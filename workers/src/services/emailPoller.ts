import type { PollResult, DecryptedGmailTokens, ScanProgress } from '../types/gmail';
import { decrypt } from '../models/encryption';
import { refreshAccessToken } from './gmailAuth';
import { storeOAuthTokens } from '../models/oauth';
import { getAllRetailersForSearch } from '../models/retailers';
import { buildSearchQuery, processMessage, searchAllMessages } from './emailPipeline';
import type { GmailPollingEnv, RetailerSearchEntry } from './emailPipeline';

// Re-exported so existing callers (routes/gmail.ts: `import type { GmailPollingEnv }`)
// keep resolving the env type from this module after the pipeline extraction.
export type { GmailPollingEnv } from './emailPipeline';

export const LAST_POLL_KV_PREFIX = 'gmail:lastPoll:';
export const SCAN_PROGRESS_KV_PREFIX = 'gmail:scan:';
const LAST_POLL_KV_TTL = 365 * 24 * 60 * 60; // 365 days
const SCAN_PROGRESS_KV_TTL = 3600; // 1 hour
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
    billsAlreadyImported: 0,
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
  let billsAlreadyImported = 0;
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
        } else if (result.skipReason === 'skipped_duplicate' || result.duplicatesSkipped > 0) {
          // Already ingested on a previous scan — NOT a discovery failure.
          // Counting these as "no bill subject" made re-connect scans read as
          // "0 bills discovered" (found in the #242 deployed run).
          billsAlreadyImported++;
        } else {
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
        progress.billsAlreadyImported = billsAlreadyImported;
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
  progress.billsAlreadyImported = billsAlreadyImported;
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
