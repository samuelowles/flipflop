import type { Retailer } from '../types/retailer';

function generateId(): string {
  return crypto.randomUUID();
}

function rowToRetailer(row: Record<string, unknown>): Retailer {
  return {
    id: row.id as string,
    name: row.name as string,
    domain: row.domain as string | null,
    parserId: row.parser_id as string | null,
    isActive: (row.is_active as number) === 1,
  };
}

/**
 * Get all active retailers.
 */
export async function getAllRetailers(
  db: D1Database
): Promise<readonly Retailer[]> {
  const stmt = db.prepare('SELECT * FROM retailers WHERE is_active = 1 ORDER BY name');
  const results = await stmt.all<Record<string, unknown>>();

  return results.results?.map(rowToRetailer) ?? [];
}

/**
 * Get a retailer by its primary key ID.
 */
export async function getRetailerById(
  db: D1Database,
  id: string
): Promise<Retailer | null> {
  const stmt = db.prepare('SELECT * FROM retailers WHERE id = ?1');
  const result = await stmt.bind(id).first<Record<string, unknown>>();

  if (!result) return null;
  return rowToRetailer(result);
}

/**
 * Get a retailer by its domain name (e.g., "contact.co.nz").
 */
export async function getRetailerByDomain(
  db: D1Database,
  domain: string
): Promise<Retailer | null> {
  const stmt = db.prepare('SELECT * FROM retailers WHERE domain = ?1');
  const result = await stmt.bind(domain).first<Record<string, unknown>>();

  if (!result) return null;
  return rowToRetailer(result);
}

/**
 * Create a new retailer.
 */
export async function createRetailer(
  db: D1Database,
  input: { readonly name: string; readonly domain?: string; readonly parserId?: string }
): Promise<Retailer> {
  const id = generateId();

  const stmt = db.prepare(
    `INSERT INTO retailers (id, name, domain, parser_id)
     VALUES (?1, ?2, ?3, ?4)`
  );

  await stmt
    .bind(id, input.name, input.domain ?? null, input.parserId ?? null)
    .run();

  const retailer = await getRetailerById(db, id);
  if (!retailer) throw new Error('Failed to create retailer');
  return retailer;
}

/**
 * Get all active retailer names and IDs for Gmail From-header matching.
 * Used by emailPoller to build Gmail search queries and match senders.
 * Uses retailer name (not domain) so third-party billing services are caught.
 */
export async function getAllRetailerNames(
  db: D1Database
): Promise<readonly { id: string; name: string }[]> {
  const stmt = db.prepare(
    'SELECT id, name FROM retailers WHERE is_active = 1 ORDER BY name'
  );
  const result = await stmt.all<{ id: string; name: string }>();
  return result.results ?? [];
}

/**
 * Extract Gmail from: search keywords from a retailer name.
 * Multi-word names are quoted for exact display-name phrase match.
 * Single-word names are used as-is.
 * No bare-word fallbacks — those cause false positives (e.g. "Contact" matches
 * contact@nznativeplantcentre.co.nz).
 *
 * Examples:
 *   "Contact Energy" → ['"Contact Energy"']
 *   "Mercury" → ['Mercury']
 *   "Electric Kiwi" → ['"Electric Kiwi"']
 */
export function nameToSearchKeywords(name: string): readonly string[] {
  if (name.includes(' ')) {
    return [`"${name}"`];
  }
  return [name];
}
