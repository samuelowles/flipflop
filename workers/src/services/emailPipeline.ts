// Per-message Gmail bill-discovery pipeline, extracted from emailPoller.ts
// (issue: emailPoller.ts exceeded the 500-line project limit). This module owns
// the pure-ish message lifecycle: search-query construction, sender→retailer
// matching, recursive MIME PDF extraction, and per-message fetch/store/enqueue.
// The cron/on-demand entry points (pollAllUsers, pollSingleUser) remain in
// emailPoller.ts and orchestrate this pipeline.

import type { GmailMessage } from '../types/gmail';
import type { EncryptionEnv } from '../models/encryption';
import { getMessage, downloadAttachment, searchMessages } from './gmailAuth';
import { createBill, getBillBySourceMessageId } from '../models/bills';
import { nameToSearchKeywords } from '../models/retailers';

export interface GmailPollingEnv extends EncryptionEnv {
  readonly DB: D1Database;
  readonly KV: KVNamespace;
  readonly BILLS: R2Bucket;
  readonly PARSE_QUEUE: Queue<{ billId: string; r2Key: string }>;
  readonly GMAIL_CLIENT_ID: string;
  readonly GMAIL_CLIENT_SECRET: string;
}

const SUBJECT_PATTERN = /\b(bill|invoice|statement|account)\b/i;

/**
 * A retailer row projected for Gmail search-query construction and From-header
 * matching. Fetched once per poll run and reused for every message (avoids an
 * N+1 DB hit per message that the old getAllRetailerNames call caused).
 */
export interface RetailerSearchEntry {
  readonly id: string;
  readonly name: string;
  readonly emailDomains: readonly string[];
}

/**
 * Issue #227 — Build Gmail search query as a UNION of retailer sender DOMAINS
 * (migration 0017 `retailers.email_domains`) AND retailer NAME keywords.
 *
 * Domains are the reliable signal (`from:contactenergy.co.nz` matches any
 * display name on that domain); name keywords are retained so nothing that
 * matched before stops matching (third-party mailers where the display name
 * carries the retailer name but the domain is a shared bulk-sender).
 *
 * Example: {from:contactenergy.co.nz OR from:"Contact Energy" OR from:mercury.co.nz OR from:Mercury OR ...} has:attachment after:YYYY/MM/DD
 */
export function buildSearchQuery(
  retailers: readonly RetailerSearchEntry[],
  afterDate?: string
): string {
  if (retailers.length === 0) {
    throw new Error('No active retailers configured');
  }

  // Collect every from: term across all retailers (handles multi-retailer users).
  // Domains first, then name keywords — order is cosmetic but deterministic.
  const fromTerms = new Set<string>();
  for (const r of retailers) {
    for (const domain of r.emailDomains) {
      fromTerms.add(domain);
    }
    for (const kw of nameToSearchKeywords(r.name)) {
      fromTerms.add(kw);
    }
  }

  const fromClause = [...fromTerms].map((t) => `from:${t}`).join(' OR ');
  let query = `{${fromClause}} has:attachment`;
  if (afterDate) {
    const d = new Date(afterDate);
    const yyyy = d.getFullYear();
    const mm = String(d.getMonth() + 1).padStart(2, '0');
    const dd = String(d.getDate()).padStart(2, '0');
    query += ` after:${yyyy}/${mm}/${dd}`;
  }
  return query;
}

/**
 * Issue #227 — Match a From header to a retailer by sender DOMAIN first (the
 * reliable signal from migration 0017), then fall back to retailer name.
 *
 * Domain match: the From header contains `@<domain>` or the bare domain.
 * Name match: the retailer name appears in the From header
 * (case-insensitive); multi-word names also try their first word (>= 4 chars)
 * so "Contact" matches a From header carrying only the first word.
 *
 * Pure function over the cached retailer list — no DB hit per message
 * (the old matchRetailerByName re-queried D1 on every message).
 */
export function matchRetailer(
  retailers: readonly RetailerSearchEntry[],
  fromHeader: string
): string | null {
  const lowerFrom = fromHeader.toLowerCase();

  // 1. Domain match (highest confidence — the new reliable signal).
  for (const r of retailers) {
    for (const domain of r.emailDomains) {
      const d = domain.toLowerCase();
      // Match `@domain` (RFC-5322 addr-spec) or the bare domain.
      if (lowerFrom.includes(`@${d}`) || lowerFrom.includes(d)) {
        return r.id;
      }
    }
  }

  // 2. Exact full-name match.
  for (const r of retailers) {
    if (lowerFrom.includes(r.name.toLowerCase())) {
      return r.id;
    }
  }

  // 3. Fallback: first word of multi-word names (>= 4 chars).
  for (const r of retailers) {
    const firstWord = r.name.split(' ')[0] ?? '';
    if (firstWord.length >= 4 && lowerFrom.includes(firstWord.toLowerCase())) {
      return r.id;
    }
  }

  return null;
}

interface MessageToProcess {
  messageId: string;
  accessToken: string;
}

/** Structured skip reason for per-message cron logging (issue #227 fix 4). */
type SkipReason = 'skipped_no_retailer_match' | 'skipped_no_pdf' | 'skipped_duplicate';

export interface ProcessMessageResult {
  billsFound: number;
  /** Present when the message was skipped without an error (cron logging). */
  skipReason?: SkipReason;
  /** Whether the subject matched SUBJECT_PATTERN (issue #227 fix 4). */
  subjectMatched: boolean;
  /** Count of duplicate parts already ingested on a prior run (fix 1). */
  duplicatesSkipped: number;
  error?: string;
  sender: string;
}

/**
 * Structural type covering both the top-level Gmail payload AND nested MIME
 * parts. The official GmailMessage type models the payload and parts as
 * different shapes, but a recursive walk needs a single uniform shape. This
 * loosens optional fields so both the root payload and leaf parts satisfy it.
 */
interface MimeNode {
  readonly mimeType: string;
  readonly filename?: string;
  readonly body?: { readonly attachmentId?: string; readonly size: number };
  readonly partId?: string;
  readonly parts?: readonly MimeNode[];
}

/**
 * Issue #227 fix 2 — recursive MIME part walker. Gmail nests attachments under
 * `multipart/mixed` → `multipart/alternative` → …; a top-level `payload.parts`
 * filter misses anything not at depth 1.
 *
 * A part is a bill PDF when EITHER:
 *   - mimeType === 'application/pdf', OR
 *   - filename ends `.pdf` (case-insensitive) AND body.attachmentId is present
 *     (catches retailers' mailers that send PDFs as application/octet-stream).
 *
 * The top-level payload itself may carry the attachment (single-part messages),
 * so it is included as the first candidate.
 */
function findPdfParts(payload: GmailMessage['payload']): readonly MimeNode[] {
  if (!payload) return [];
  const found: MimeNode[] = [];

  const visit = (node: MimeNode): void => {
    // A node qualifies as a bill PDF attachment when it has an attachmentId
    // and is PDF by mime OR by .pdf filename.
    const isPdfByMime = node.mimeType === 'application/pdf';
    const isPdfByName =
      typeof node.filename === 'string' &&
      node.filename.toLowerCase().endsWith('.pdf') &&
      !!node.body?.attachmentId;
    if ((isPdfByMime || isPdfByName) && node.body?.attachmentId) {
      found.push(node);
    }
    // Recurse into nested parts (multipart/mixed → multipart/alternative → …).
    if (Array.isArray(node.parts)) {
      for (const child of node.parts) {
        visit(child);
      }
    }
  };

  visit(payload as unknown as MimeNode);
  return found;
}

/**
 * Process a single Gmail message: fetch, filter, download PDFs, store, enqueue.
 * Pure logic shared by both pollAllUsers and pollSingleUser.
 *
 * Issue #227 overhauls:
 *   - Dedup via getBillBySourceMessageId (fix 1).
 *   - Recursive MIME walk (fix 2).
 *   - Subject demoted to signal when retailer matched + PDF present (fix 4);
 *     hard gate only when retailer match failed.
 *   - Per-message skip reasons logged.
 */
export async function processMessage(
  env: GmailPollingEnv,
  userId: string,
  msg: MessageToProcess,
  retailers: readonly RetailerSearchEntry[]
): Promise<ProcessMessageResult> {
  const sender = 'unknown';
  try {
    const fullMsg = await getMessage({
      accessToken: msg.accessToken,
      messageId: msg.messageId,
    });

    const headers = fullMsg.payload?.headers ?? [];
    const from = headers.find((h) => h.name === 'From')?.value ?? '';
    const subject = headers.find((h) => h.name === 'Subject')?.value ?? '';
    const subjectMatched = SUBJECT_PATTERN.test(subject);

    // Retailer match is the primary signal (domain first, then name).
    const retailerId = matchRetailer(retailers, from);

    // Recursive MIME walk to find PDF attachments at any nesting depth.
    const pdfParts = findPdfParts(fullMsg.payload);

    // Unknown-sender protection: if the retailer didn't match, the subject
    // filter stays a HARD gate (an unknown sender with a PDF and no bill-like
    // subject is not a bill we want to ingest).
    if (retailerId === null && !subjectMatched) {
      console.log(JSON.stringify({
        type: 'gmail_message_skip',
        messageId: msg.messageId,
        userId,
        reason: 'skipped_no_retailer_match',
        subjectMatched: false,
        timestamp: new Date().toISOString(),
      }));
      return { billsFound: 0, skipReason: 'skipped_no_retailer_match', subjectMatched: false, duplicatesSkipped: 0, sender: from };
    }

    if (pdfParts.length === 0) {
      console.log(JSON.stringify({
        type: 'gmail_message_skip',
        messageId: msg.messageId,
        userId,
        reason: 'skipped_no_pdf',
        subjectMatched,
        timestamp: new Date().toISOString(),
      }));
      return { billsFound: 0, skipReason: 'skipped_no_pdf', subjectMatched, duplicatesSkipped: 0, sender: from };
    }

    let billsFound = 0;
    let duplicatesSkipped = 0;
    for (const pdfPart of pdfParts) {
      const partId = pdfPart.partId;
      // Issue #227 fix 1 — dedup via source_message_id (mirrors the WhatsApp
      // path in routes/messaging.ts + getBillBySourceMessageId). The poll
      // cursor is date-granular and crons run twice daily, so without this
      // every bill was processed twice → duplicate rows + duplicate parse jobs.
      const sourceMessageId = `gmail_${msg.messageId}_${partId}`;
      const existing = await getBillBySourceMessageId(env.DB, sourceMessageId);
      if (existing) {
        duplicatesSkipped++;
        console.log(JSON.stringify({
          type: 'gmail_message_skip',
          messageId: msg.messageId,
          partId,
          userId,
          reason: 'skipped_duplicate',
          billId: existing.id,
          timestamp: new Date().toISOString(),
        }));
        continue;
      }

      const attachmentId = pdfPart.body?.attachmentId;
      if (!attachmentId) continue; // findPdfParts guarantees this; defensive guard
      const attachment = await downloadAttachment({
        accessToken: msg.accessToken,
        messageId: msg.messageId,
        attachmentId,
      });

      // Store in R2
      const r2Key = `bills/${userId}/${sourceMessageId}.pdf`;
      await env.BILLS.put(r2Key, attachment);

      // Create bill record in D1 (now with sourceMessageId for dedup).
      const bill = await createBill(env.DB, {
        userId,
        rawR2Key: r2Key,
        source: 'gmail',
        retailerId: retailerId ?? undefined,
        sourceMessageId,
      });

      // Enqueue parse job
      await env.PARSE_QUEUE.send({ billId: bill.id, r2Key });
      billsFound++;
    }

    console.log(JSON.stringify({
      type: 'gmail_message_processed',
      messageId: msg.messageId,
      userId,
      billsFound,
      duplicatesSkipped,
      subjectMatched,
      retailerMatched: retailerId !== null,
      timestamp: new Date().toISOString(),
    }));

    return { billsFound, subjectMatched, duplicatesSkipped, sender: from };
  } catch (err) {
    return { billsFound: 0, error: (err as Error).message, subjectMatched: false, duplicatesSkipped: 0, sender };
  }
}

/**
 * Search Gmail with pagination. Keeps fetching pages until exhausted.
 * Returns all matching message IDs (may be more than maxResults per page).
 */
export async function searchAllMessages(params: {
  accessToken: string;
  query: string;
}): Promise<readonly { id: string }[]> {
  const allMessages: { id: string }[] = [];
  let pageToken: string | undefined;

  do {
    const page = await searchMessages({
      accessToken: params.accessToken,
      query: params.query,
      pageToken,
    });

    if (page.messages) {
      allMessages.push(...page.messages);
    }

    pageToken = page.nextPageToken;
  } while (pageToken);

  return allMessages;
}
