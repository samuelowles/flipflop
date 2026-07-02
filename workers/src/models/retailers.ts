import type { Retailer } from '../types/retailer';

/**
 * Known retailer sender numbers → retailer IDs (issue #40).
 *
 * Maps inbound WhatsApp/SMS sender numbers (or sender IDs) to the primary-key
 * retailer ID from the retailers table (migration 0002_seed_retailers.sql).
 * Used to set bills.retailer_id at ingest time when the bill arrives directly
 * from a known retailer sender, avoiding a downstream prompt for the user.
 *
 * Real dedicated bill-sender numbers are not consistently published for all NZ
 * retailers, so several entries are realistic placeholders keyed off the
 * retailer's public customer-service number pattern. Verify against live Sent
 * inbound sender IDs before relying on these in production.
 *
 * TODO: verify against live Sent inbound sender IDs.
 */
const RETAILER_SENDER_NUMBERS: readonly {
  readonly sender: string;
  readonly retailerId: string;
}[] = [
  { sender: '+64 21 400 400', retailerId: 'ffcfa737-7546-4d1f-9f5e-8bfa1e6fc31a' }, // Contact Energy
  { sender: '+64 21 500 500', retailerId: '2951d6b6-436e-474b-8ea9-7fb5092cc069' }, // Mercury
  { sender: '+64 21 600 600', retailerId: 'a20f39b2-7f2c-48ef-8b17-12886402e2fd' }, // Genesis Energy
  { sender: '+64 21 700 700', retailerId: '5efa7fa6-0ec7-4f81-b3cf-229951b3896b' }, // Meridian Energy
  { sender: '+64 21 800 800', retailerId: '92a506ac-2ca0-4ff3-a46e-3a27d850ce6a' }, // Trustpower
  { sender: '+64 21 900 900', retailerId: '02b3f36d-27b2-475b-bc08-2863e2cc96c9' }, // Nova Energy
  { sender: '+64 21 100 100', retailerId: '9b60928a-0d44-4b49-8d76-bb0e6295c63d' }, // Electric Kiwi
  { sender: '+64 21 200 200', retailerId: '989a6f4d-bf36-4c0b-b920-43679aecf9a0' }, // Powershop
  { sender: '+64 21 300 300', retailerId: '41f1cccd-ee33-4f96-b9be-925d5ee399e9' }, // Flick Electric
  { sender: '+64 21 450 450', retailerId: 'a14a71cc-a945-4fc2-a72f-80779a746429' }, // Pulse Energy
];

const RETAILER_SENDER_MAP: ReadonlyMap<string, string> = new Map(
  RETAILER_SENDER_NUMBERS.map(({ sender, retailerId }) => [
    // Normalise: strip whitespace and lowercase so lookup is format-tolerant.
    sender.replace(/\s+/g, '').toLowerCase(),
    retailerId,
  ])
);

/**
 * Detect a retailer from an inbound sender number (or sender ID).
 * Returns the retailer primary-key ID, or null when the sender is unknown
 * (downstream logic then prompts the user to identify their retailer).
 */
export function detectRetailerBySender(sender: string): string | null {
  const normalised = sender.replace(/\s+/g, '').toLowerCase();
  return RETAILER_SENDER_MAP.get(normalised) ?? null;
}

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
