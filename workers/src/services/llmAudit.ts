/**
 * #36 — LLM audit persistence + 30-day retention.
 *
 * Metadata-only store: model, intent, confidence, latency_ms, prompt_version.
 * NEVER accepts or persists message body, prompt text, response text, or PII —
 * the "prompt+response pairs" in the AC are represented by their metadata row.
 */

/** Fields persisted for every LLM call. No body/PII fields exist by design. */
export interface LLMCallRecord {
  readonly request_id?: string;
  readonly model: 'flash' | 'pro';
  readonly intent: string;
  readonly confidence: number;
  readonly latency_ms: number;
  readonly prompt_version: string;
}

/**
 * Persist a metadata-only audit row for an LLM call.
 * Safe to await; failures are logged and swallowed so audit persistence can
 * never break the LLM call path (callers already log to console).
 */
export async function persistLLMCall(
  db: D1Database,
  record: LLMCallRecord
): Promise<void> {
  try {
    await db
      .prepare(
        'INSERT INTO llm_audit (request_id, model, intent, confidence, latency_ms, prompt_version) VALUES (?, ?, ?, ?, ?, ?)'
      )
      .bind(
        record.request_id ?? null,
        record.model,
        record.intent,
        record.confidence,
        record.latency_ms,
        record.prompt_version
      )
      .run();
  } catch (err) {
    console.log(JSON.stringify({
      type: 'llm_audit_persist_error',
      error: err instanceof Error ? err.message : 'unknown',
      timestamp: new Date().toISOString(),
    }));
  }
}

/**
 * Delete audit metadata rows older than `retentionDays`.
 * Runs daily via the 03:00 UTC cron. Returns the number of rows deleted.
 */
export async function purgeOldLLMAudit(
  db: D1Database,
  retentionDays = 30
): Promise<number> {
  const result = await db
    .prepare('DELETE FROM llm_audit WHERE created_at < datetime(\'now\', ?)')
    .bind(`-${retentionDays} days`)
    .run();
  return (result.meta?.changes ?? 0) as number;
}
