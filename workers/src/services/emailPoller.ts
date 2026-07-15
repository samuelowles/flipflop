import type { PollResult, DecryptedGmailTokens, ScanProgress, GmailMessage } from '../types/gmail';
import type { EncryptionEnv } from '../models/encryption';
import { decrypt } from '../models/encryption';
import {
  refreshAccessToken,
  searchMessages,
  getMessage,
  downloadAttachment,
} from './gmailAuth';
import { storeOAuthTokens } from '../models/oauth';
import { createBill, getBillBySourceMessageId } from '../models/bills';
import { getAllRetailersForSearch, nameToSearchKeywords } from '../models/retailers';

export interface GmailPollingEnv extends EncryptionEnv {
  readonly DB: D1Database;
  readonly KV: KVNamespace;
  readonly BILLS: R2Bucket;
  readonly PARSE_QUEUE: Queue<{ billId: string; r2Key: string }>;
  readonly GMAIL_CLIENT_ID: string;
  readonly GMAIL_CLIENT_SECRET: string;
}

const LAST_POLL_KV_PREFIX = 'gmail:lastPoll:';
const SCAN_PROGRESS_KV_PREFIX = 'gmail:scan:';
const LAST_POLL_KV_TTL = 365 * 24 * 60 * 60; // 365 days
const SCAN_PROGRESS_KV_TTL = 3600; // 1 hour
const SUBJECT_PATTERN = /\b(bill|invoice|statement|account)\b/i;
const INITIAL_LOOKBACK_DAYS = 365;

/**
 * A retailer row projected for Gmail search-query construction and From-header
 * matching. Fetched once per poll run and reused for every message (avoids an
 * N+1 DB hit per message that the old getAllRetailerNames call caused).
 */
interface RetailerSearchEntry {
  readonly id: string;
  readonly name: string;
  readonly emailDomains: readonly string[];
}

/** Fetch all users with Gmail OAuth tokens from D1 */
async function getGmailUsers(
  db: D1Database
): Promise<
  ReadonlyArray<{
    userId: string;
    accessTokenEncrypted: string;
    refreshTokenEncrypted: string | null;
    expiry: string;
  }>
> {
  const stmt = db.prepare(
    'SELECT user_id, access_token_encrypted, refresh_token_encrypted, expiry FROM oauth_tokens WHERE provider = ?1'
  );
  const results = await stmt.bind('gmail').all<Record<string, unknown>>();

  return (results.results ?? []).map((r) => ({
    userId: r['user_id'] as string,
    accessTokenEncrypted: r['access_token_encrypted'] as string,
    refreshTokenEncrypted: r['refresh_token_encrypted'] as string | null,
    expiry: r['expiry'] as string,
  }));
}

/** Fetch a single user's Gmail OAuth token row */
async function getGmailTokenForUser(
  db: D1Database,
  userId: string
): Promise<{
  userId: string;
  accessTokenEncrypted: string;
  refreshTokenEncrypted: string | null;
  expiry: string;
} | null> {
  const stmt = db.prepare(
    'SELECT user_id, access_token_encrypted, refresh_token_encrypted, expiry FROM oauth_tokens WHERE user_id = ?1 AND provider = ?2'
  );
  const result = await stmt.bind(userId, 'gmail').first<Record<string, unknown>>();
  if (!result) return null;
  return {
    userId: result['user_id'] as string,
    accessTokenEncrypted: result['access_token_encrypted'] as string,
    refreshTokenEncrypted: result['refresh_token_encrypted'] as string | null,
    expiry: result['expiry'] as string,
  };
}

// Decrypt tokens, refresh if expired
async function getValidTokens(
  row: {
    userId: string;
    accessTokenEncrypted: string;
    refreshTokenEncrypted: string | null;
    expiry: string;
  },
  env: GmailPollingEnv
): Promise<DecryptedGmailTokens | Error> {
  try {
    const accessToken = await decrypt(row.accessTokenEncrypted, env.ENCRYPTION_KEY);
    const refreshToken = row.refreshTokenEncrypted
      ? await decrypt(row.refreshTokenEncrypted, env.ENCRYPTION_KEY)
      : null;

    // Check if expired
    if (new Date(row.expiry) <= new Date()) {
      if (!refreshToken) {
        return new Error('Token expired and no refresh token available');
      }

      const refreshed = await refreshAccessToken({
        refreshToken,
        clientId: env.GMAIL_CLIENT_ID,
        clientSecret: env.GMAIL_CLIENT_SECRET,
      });

      // Store refreshed tokens (oauth model encrypts internally)
      await storeOAuthTokens(env.DB, { ENCRYPTION_KEY: env.ENCRYPTION_KEY }, {
        userId: row.userId,
        provider: 'gmail',
        accessToken: refreshed.accessToken,
        refreshToken,
        expiry: refreshed.expiry,
      });

      return { accessToken: refreshed.accessToken, refreshToken, expiry: refreshed.expiry };
    }

    return { accessToken, refreshToken, expiry: row.expiry };
  } catch (err) {
    return err as Error;
  }
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
function buildSearchQuery(
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

// Get the last-poll timestamp for a user from KV
async function getLastPollTime(kv: KVNamespace, userId: string): Promise<string | null> {
  return kv.get(`${LAST_POLL_KV_PREFIX}${userId}`);
}

// Store the last-poll timestamp for a user in KV
async function setLastPollTime(
  kv: KVNamespace,
  userId: string,
  timestamp: string
): Promise<void> {
  await kv.put(`${LAST_POLL_KV_PREFIX}${userId}`, timestamp, {
    expirationTtl: LAST_POLL_KV_TTL,
  });
}

// Write scan progress to KV so the callback page can poll it
async function writeScanProgress(
  kv: KVNamespace,
  userId: string,
  progress: ScanProgress
): Promise<void> {
  await kv.put(
    `${SCAN_PROGRESS_KV_PREFIX}${userId}`,
    JSON.stringify(progress),
    { expirationTtl: SCAN_PROGRESS_KV_TTL }
  );
}

/** Read scan progress from KV (for the status endpoint) */
export async function readScanProgress(
  kv: KVNamespace,
  userId: string
): Promise<ScanProgress | null> {
  const raw = await kv.get(`${SCAN_PROGRESS_KV_PREFIX}${userId}`);
  if (!raw) return null;
  try {
    return JSON.parse(raw) as ScanProgress;
  } catch {
    return null;
  }
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
function matchRetailer(
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

interface ProcessMessageResult {
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
async function processMessage(
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
async function searchAllMessages(params: {
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

/**
 * Poll all users' Gmail inboxes for new power bill PDFs.
 * Cron-triggered entry point called from the scheduled() handler.
 */
export async function pollAllUsers(
  env: GmailPollingEnv
): Promise<readonly PollResult[]> {
  const users = await getGmailUsers(env.DB);
  if (users.length === 0) {
    console.log(JSON.stringify({
      type: 'gmail_poll_summary',
      message: 'No users with Gmail tokens',
      timestamp: new Date().toISOString(),
    }));
    return [];
  }

  // Fetch retailers ONCE (id/name/emailDomains) — reused for every user and
  // message (the old code re-queried D1 per message via matchRetailerByName).
  let retailers: readonly RetailerSearchEntry[];
  try {
    retailers = await getAllRetailersForSearch(env.DB);
  } catch (err) {
    console.log(JSON.stringify({
      level: 'error',
      type: 'gmail_poll_error',
      error: (err as Error).message,
      timestamp: new Date().toISOString(),
    }));
    return [];
  }

  // Build base search query (same for all users except the after: date)
  let baseQuery: string;
  try {
    baseQuery = buildSearchQuery(retailers);
  } catch (err) {
    console.log(JSON.stringify({
      level: 'error',
      type: 'gmail_poll_error',
      error: (err as Error).message,
      timestamp: new Date().toISOString(),
    }));
    return [];
  }

  const results: PollResult[] = [];

  for (const user of users) {
    const errors: string[] = [];
    let billsFound = 0;

    try {
      // Decrypt and optionally refresh tokens
      const tokens = await getValidTokens(user, env);
      if (tokens instanceof Error) {
        errors.push(`Token error: ${tokens.message}`);
        results.push({ userId: user.userId, billsFound: 0, errors });
        continue;
      }

      // Get last poll cursor; for first-time users, look back 365 days
      const lastPoll = await getLastPollTime(env.KV, user.userId);
      const afterDate = lastPoll
        ? lastPoll.slice(0, 10)
        : new Date(Date.now() - INITIAL_LOOKBACK_DAYS * 24 * 60 * 60 * 1000)
            .toISOString()
            .slice(0, 10);

      const finalQuery = `${baseQuery} after:${afterDate}`;

      // Search Gmail with pagination
      const messages = await searchAllMessages({
        accessToken: tokens.accessToken,
        query: finalQuery,
      });

      if (messages.length === 0) {
        // Clean run with no messages → advance cursor (fix 6).
        await setLastPollTime(env.KV, user.userId, new Date().toISOString());
        results.push({ userId: user.userId, billsFound: 0, errors: [] });
        continue;
      }

      // Process each message
      for (const { id: messageId } of messages) {
        const result = await processMessage(env, user.userId, {
          messageId,
          accessToken: tokens.accessToken,
        }, retailers);

        billsFound += result.billsFound;
        if (result.error) {
          errors.push(`Message ${messageId}: ${result.error}`);
        }
      }

      // Issue #227 fix 6 — cursor safety: only advance the poll cursor when the
      // run had zero errors. With dedup (fix 1) in place, re-scanning the same
      // window after a failed run is idempotent and loses nothing.
      if (errors.length === 0) {
        await setLastPollTime(env.KV, user.userId, new Date().toISOString());
      }
    } catch (err) {
      errors.push(`User ${user.userId}: ${(err as Error).message}`);
    }

    results.push({ userId: user.userId, billsFound, errors });
  }

  console.log(JSON.stringify({
    type: 'gmail_poll_summary',
    usersPolled: results.length,
    totalBillsFound: results.reduce((sum, r) => sum + r.billsFound, 0),
    totalErrors: results.reduce((sum, r) => sum + r.errors.length, 0),
    timestamp: new Date().toISOString(),
  }));

  return results;
}

/**
 * Poll a single user's Gmail inbox for new power bill PDFs.
 * Used for on-demand scanning (post-signup, manual trigger).
 * Looks back 365 days for the initial scan. Does NOT update the gmail:lastPoll KV cursor.
 * Writes progress to KV under gmail:scan:{userId} for the callback page to poll.
 */
export async function pollSingleUser(
  env: GmailPollingEnv,
  userId: string
): Promise<PollResult> {
  const startedAt = new Date().toISOString();
  const progress: ScanProgress = {
    phase: 'connecting',
    messagesFound: 0,
    messagesScanned: 0,
    messagesSkippedNoSubject: 0,
    messagesSkippedNoPdf: 0,
    billsFound: 0,
    billSenders: [],
    filteredSenders: [],
    errors: [],
    complete: false,
    startedAt,
  };

  await writeScanProgress(env.KV, userId, progress);

  const tokenRow = await getGmailTokenForUser(env.DB, userId);
  if (!tokenRow) {
    progress.phase = 'complete';
    progress.errors = ['No Gmail tokens found for user'];
    progress.complete = true;
    progress.finishedAt = new Date().toISOString();
    await writeScanProgress(env.KV, userId, progress);
    return { userId, billsFound: 0, errors: ['No Gmail tokens found for user'] };
  }

  const tokens = await getValidTokens(tokenRow, env);
  if (tokens instanceof Error) {
    progress.phase = 'complete';
    progress.errors = [`Token error: ${tokens.message}`];
    progress.complete = true;
    progress.finishedAt = new Date().toISOString();
    await writeScanProgress(env.KV, userId, progress);
    return { userId, billsFound: 0, errors: [`Token error: ${tokens.message}`] };
  }

  // Fetch retailers once for this scan (domain + name matching).
  let retailers: readonly RetailerSearchEntry[];
  try {
    retailers = await getAllRetailersForSearch(env.DB);
  } catch (err) {
    progress.phase = 'complete';
    progress.errors = [(err as Error).message];
    progress.complete = true;
    progress.finishedAt = new Date().toISOString();
    await writeScanProgress(env.KV, userId, progress);
    return { userId, billsFound: 0, errors: [(err as Error).message] };
  }

  let query: string;
  try {
    const afterDate = new Date(
      Date.now() - INITIAL_LOOKBACK_DAYS * 24 * 60 * 60 * 1000
    )
      .toISOString()
      .slice(0, 10);
    query = buildSearchQuery(retailers, afterDate);
  } catch (err) {
    progress.phase = 'complete';
    progress.errors = [(err as Error).message];
    progress.complete = true;
    progress.finishedAt = new Date().toISOString();
    await writeScanProgress(env.KV, userId, progress);
    return { userId, billsFound: 0, errors: [(err as Error).message] };
  }

  // Searching phase
  progress.phase = 'searching';
  progress.searchQuery = query;
  await writeScanProgress(env.KV, userId, progress);

  const errors: string[] = [];
  let billsFound = 0;
  const billSenders = new Set<string>();
  const filteredSenders = new Set<string>();
  let messagesSkippedNoSubject = 0;
  let messagesSkippedNoPdf = 0;

  try {
    const messages = await searchAllMessages({
      accessToken: tokens.accessToken,
      query,
    });

    progress.phase = 'scanning';
    progress.messagesFound = messages.length;
    await writeScanProgress(env.KV, userId, progress);

    for (const { id: messageId } of messages) {
      progress.messagesScanned++;
      const result = await processMessage(env, userId, {
        messageId,
        accessToken: tokens.accessToken,
      }, retailers);

      if (result.billsFound > 0) {
        billsFound += result.billsFound;
        if (result.sender && result.sender !== 'unknown') {
          billSenders.add(result.sender);
        }
      } else if (result.sender && result.sender !== 'unknown') {
        // Matched Gmail search but filtered out — track sender for debugging.
        // Skip classification now comes straight from processMessage (fix 4)
        // instead of a second getMessage round-trip.
        filteredSenders.add(result.sender);
        if (result.skipReason === 'skipped_no_pdf') {
          messagesSkippedNoPdf++;
        } else {
          // skipped_no_retailer_match or skipped_duplicate both indicate the
          // message lacked a bill-worthy subject+retailer combo (the dedup
          // case is rare on the single-user initial scan). Count as no-subject
          // for progress-display parity with the prior behaviour.
          messagesSkippedNoSubject++;
        }
      }

      if (result.error) {
        errors.push(`Message ${messageId}: ${result.error}`);
      }

      // Update progress periodically (every 5 messages)
      if (progress.messagesScanned % 5 === 0) {
        progress.billsFound = billsFound;
        progress.messagesSkippedNoSubject = messagesSkippedNoSubject;
        progress.messagesSkippedNoPdf = messagesSkippedNoPdf;
        progress.billSenders = [...billSenders];
        progress.filteredSenders = [...filteredSenders];
        progress.errors = errors;
        await writeScanProgress(env.KV, userId, progress);
      }
    }
  } catch (err) {
    errors.push(`Gmail search error: ${(err as Error).message}`);
  }

  progress.phase = 'complete';
  progress.billsFound = billsFound;
  progress.messagesSkippedNoSubject = messagesSkippedNoSubject;
  progress.messagesSkippedNoPdf = messagesSkippedNoPdf;
  progress.billSenders = [...billSenders];
  progress.filteredSenders = [...filteredSenders];
  progress.errors = errors;
  progress.complete = true;
  progress.finishedAt = new Date().toISOString();
  await writeScanProgress(env.KV, userId, progress);

  console.log(JSON.stringify({
    type: 'gmail_single_poll',
    userId,
    billsFound,
    messagesFound: progress.messagesFound,
    billSendersSeen: billSenders.size,
    filteredSendersSeen: filteredSenders.size,
    errorCount: errors.length,
    timestamp: new Date().toISOString(),
  }));

  return { userId, billsFound, errors };
}
