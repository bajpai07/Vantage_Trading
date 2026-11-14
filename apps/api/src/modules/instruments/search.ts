// Instrument search. Plain functions over a pg client so the benchmark script can call them without Nest.
// All user input travels as parameters; LIKE wildcards in it are escaped; nothing is concatenated into SQL.
import type { ClientBase } from 'pg';

export type Queryable = Pick<ClientBase, 'query'>;

export interface InstrumentRow {
  readonly id: string;
  readonly symbol: string;
  readonly name: string;
  readonly assetClass: string;
  /** Market identifier code, e.g. XNAS. */
  readonly exchange: string;
  readonly currency: string;
  readonly status: string;
  readonly tickSize: string;
  /** attrs.source of the instrument master row, e.g. FIXTURE (null when absent). */
  readonly attrsSource: string | null;
  /** Feature gates (`tradable_in`); the MVP gate means orders are accepted for this instrument. */
  readonly tradableIn: readonly string[];
}

interface RawRow {
  id: string;
  symbol: string;
  name: string;
  asset_class: string;
  exchange: string;
  currency: string;
  status: string;
  tick_size: string;
  attrs_source: string | null;
  tradable_in: string[];
}

const toRow = (r: RawRow): InstrumentRow => ({
  id: r.id,
  symbol: r.symbol,
  name: r.name,
  assetClass: r.asset_class,
  exchange: r.exchange,
  currency: r.currency,
  status: r.status,
  tickSize: r.tick_size,
  attrsSource: r.attrs_source,
  tradableIn: r.tradable_in,
});

export const COLUMNS = `i.id, i.symbol, i.name, i.asset_class::text AS asset_class, e.code AS exchange,
  i.quote_currency AS currency, i.status::text AS status, i.tick_size, i.attrs->>'source' AS attrs_source,
  i.tradable_in::text[] AS tradable_in`;

/** Escapes the LIKE metacharacters so user text is matched literally (ESCAPE '\\' is used in the SQL). */
export function escapeLike(input: string): string {
  return input.replace(/[\\%_]/g, (c) => `\\${c}`);
}

/**
 * Ranking: 0 exact symbol match, 1 symbol or name prefix (or a word that starts with the text),
 * 2 trigram similarity on symbol or name (typo tolerance). Ties break on similarity, then symbol.
 */
export async function searchInstruments(
  db: Queryable,
  text: string,
  limit = 20,
): Promise<InstrumentRow[]> {
  const q = text.trim();
  if (q === '') return [];
  const escaped = escapeLike(q);
  const r = await db.query<RawRow & { rank: number; sim: number }>(
    `SELECT ${COLUMNS},
            CASE WHEN upper(i.symbol) = $2 THEN 0
                 WHEN i.symbol ILIKE $3 ESCAPE '\\' OR i.name ILIKE $3 ESCAPE '\\' OR i.name ILIKE $4 ESCAPE '\\' THEN 1
                 ELSE 2 END AS rank,
            GREATEST(similarity(i.symbol, $1), word_similarity($1, i.name)) AS sim
       FROM instruments i JOIN exchanges e ON e.id = i.exchange_id
      WHERE upper(i.symbol) = $2
         OR i.symbol ILIKE $3 ESCAPE '\\'
         OR i.name ILIKE $3 ESCAPE '\\'
         OR i.name ILIKE $4 ESCAPE '\\'
         OR similarity(i.symbol, $1) >= 0.2
         OR word_similarity($1, i.name) >= 0.4
      ORDER BY rank, sim DESC, i.symbol, e.code
      LIMIT $5::int`,
    [q, q.toUpperCase(), `${escaped}%`, `% ${escaped}%`, limit],
  );
  return r.rows.map(toRow);
}

export async function findBySymbols(
  db: Queryable,
  symbols: readonly string[],
): Promise<InstrumentRow[]> {
  if (symbols.length === 0) return [];
  const r = await db.query<RawRow>(
    `SELECT ${COLUMNS}
       FROM instruments i JOIN exchanges e ON e.id = i.exchange_id
      WHERE upper(i.symbol) = ANY($1::text[])
      ORDER BY i.symbol, e.code`,
    [symbols.map((s) => s.toUpperCase())],
  );
  return r.rows.map(toRow);
}
