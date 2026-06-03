import type { PollResult, DecryptedGmailTokens, ScanProgress } from '../types/gmail';
import type { EncryptionEnv } from '../models/encryption';
import { decrypt } from '../models/encryption';
import {
  refreshAccessToken,
  searchMessages,
  getMessage,
  downloadAttachment,
} from './gmailAuth';
import { storeOAuthTokens } from '../models/oauth';
import { createBill } from '../models/bills';
import { getAllRetailerNames, nameToSearchKeywords } from '../models/retailers';

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
 * Build Gmail search query using retailer NAMES (not domains).
 * Uses all active retailers so bills from any past or present retailer are caught.
 *
 * Multi-word names get quoted for exact phrase match in the display name,
 * plus the first word as a fallback keyword. Single-word names are used as-is.
 *
 * Example: {from:"Contact Energy" OR from:Contact OR from:Mercury OR ...} has:attachment after:YYYY/MM/DD
 */
async function buildSearchQuery(
  db: D1Database,
  afterDate?: string
): Promise<string> {
  const retailers = await getAllRetailerNames(db);
  if (retailers.length === 0) {
    throw new Error('No active retailers configured');
  }

  // Collect all search keywords across ALL retailers (handles multi-retailer users)
  const allKeywords = new Set<string>();
  for (const r of retailers) {
    for (const kw of nameToSearchKeywords(r.name)) {
      allKeywords.add(kw);
    }
  }

  const fromClause = [...allKeywords].map((k) => `from:${k}`).join(' OR ');
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
 * Match a From header to a retailer by checking if the retailer name
 * appears anywhere in the From header (case-insensitive).
 * This catches bills from any domain, subdomain, or third-party billing service.
 * Returns the retailer ID or null.
 */
async function matchRetailerByName(
  db: D1Database,
  fromHeader: string
): Promise<string | null> {
  const retailers = await getAllRetailerNames(db);
  const lowerFrom = fromHeader.toLowerCase();

  // Try exact name match first
  for (const r of retailers) {
    if (lowerFrom.includes(r.name.toLowerCase())) {
      return r.id;
    }
  }

  // Fallback: try first word of multi-word names
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

interface ProcessMessageResult {
  billsFound: number;
  error?: string;
  sender: string;
}

/**
 * Process a single Gmail message: fetch, filter, download PDFs, store, enqueue.
 * Pure logic shared by both pollAllUsers and pollSingleUser.
 */
async function processMessage(
  env: GmailPollingEnv,
  userId: string,
  msg: MessageToProcess
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

    // Subject must match bill patterns
    if (!SUBJECT_PATTERN.test(subject)) {
      return { billsFound: 0, sender: from };
    }

    // Find PDF attachments
    const parts = fullMsg.payload?.parts ?? [];
    const pdfParts = parts.filter(
      (p) => p.mimeType === 'application/pdf' && p.body.attachmentId
    );

    if (pdfParts.length === 0) {
      return { billsFound: 0, sender: from };
    }

    // Match retailer by name in From header
    const retailerId = await matchRetailerByName(env.DB, from);

    let billsFound = 0;
    for (const pdfPart of pdfParts) {
      const attachment = await downloadAttachment({
        accessToken: msg.accessToken,
        messageId: msg.messageId,
        attachmentId: pdfPart.body.attachmentId!,
      });

      // Store in R2
      const r2Key = `bills/${userId}/gmail_${msg.messageId}_${pdfPart.partId}.pdf`;
      await env.BILLS.put(r2Key, attachment);

      // Create bill record in D1
      const bill = await createBill(env.DB, {
        userId,
        rawR2Key: r2Key,
        source: 'gmail',
        retailerId: retailerId ?? undefined,
      });

      // Enqueue parse job
      await env.PARSE_QUEUE.send({ billId: bill.id, r2Key });
      billsFound++;
    }

    return { billsFound, sender: from };
  } catch (err) {
    return { billsFound: 0, error: (err as Error).message, sender };
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

  // Build base search query (same for all users except the after: date)
  let baseQuery: string;
  try {
    baseQuery = await buildSearchQuery(env.DB);
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
        await setLastPollTime(env.KV, user.userId, new Date().toISOString());
        results.push({ userId: user.userId, billsFound: 0, errors: [] });
        continue;
      }

      // Process each message
      for (const { id: messageId } of messages) {
        const result = await processMessage(env, user.userId, {
          messageId,
          accessToken: tokens.accessToken,
        });

        billsFound += result.billsFound;
        if (result.error) {
          errors.push(`Message ${messageId}: ${result.error}`);
        }
      }

      // Update cursor
      await setLastPollTime(env.KV, user.userId, new Date().toISOString());
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

  let query: string;
  try {
    const afterDate = new Date(
      Date.now() - INITIAL_LOOKBACK_DAYS * 24 * 60 * 60 * 1000
    )
      .toISOString()
      .slice(0, 10);
    query = await buildSearchQuery(env.DB, afterDate);
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
      });

      if (result.billsFound > 0) {
        billsFound += result.billsFound;
        if (result.sender && result.sender !== 'unknown') {
          billSenders.add(result.sender);
        }
      } else if (result.sender && result.sender !== 'unknown') {
        // Matched Gmail search but filtered out by subject/PDF — track for debugging
        filteredSenders.add(result.sender);
        // Check why by fetching headers
        try {
          const fullMsg = await getMessage({
            accessToken: tokens.accessToken,
            messageId,
          });
          const headers = fullMsg.payload?.headers ?? [];
          const subject = headers.find((h) => h.name === 'Subject')?.value ?? '';
          if (!SUBJECT_PATTERN.test(subject)) {
            messagesSkippedNoSubject++;
          } else {
            messagesSkippedNoPdf++;
          }
        } catch {
          // best-effort skip classification
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
