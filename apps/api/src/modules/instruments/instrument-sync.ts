// Instrument master sync: reconciles a provider's master into `instruments` and `instrument_provider_map`
// in ONE transaction. Idempotent: a second run with the same master writes nothing (updated_at only moves
// when a value really changed). Instruments are never deleted; quotes never edit instruments.
import type pg from 'pg';
import { parse } from '@vantage/money';
import { newId } from '../../ids.js';
import type { Logger } from '../../log.js';
import type { Clock } from '../../tokens.js';
import type { InstrumentMasterEntry, MarketDataProvider } from '../market-data/provider.js';

export interface SyncResult {
  readonly inserted: number;
  readonly updated: number;
  readonly unchanged: number;
  /** Master entries skipped because their exchange is unknown. */
  readonly skipped: readonly string[];
  /** Instruments mapped to this provider but absent from its master (left alone and logged). */
  readonly missing: readonly string[];
}

interface ExistingRow {
  id: string;
  symbol: string;
  exchange: string;
  name: string;
  asset_class: string;
  quote_currency: string;
  tick_size: string;
  qty_step: string;
  min_qty: string;
  fractional_ok: boolean;
  status: string;
  attrs: unknown;
  provider_symbol: string | null;
}

const sameNumber = (a: string, b: string): boolean => parse(a).equals(parse(b));

/** Key-order independent JSON text, so jsonb round trips compare equal. */
function stable(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    const o = value as Record<string, unknown>;
    return `{${Object.keys(o)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${stable(o[k])}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}

function differs(row: ExistingRow, e: InstrumentMasterEntry): boolean {
  return (
    row.name !== e.name ||
    row.asset_class !== e.assetClass ||
    row.quote_currency !== e.quoteCurrency ||
    !sameNumber(row.tick_size, e.tickSize) ||
    !sameNumber(row.qty_step, e.qtyStep) ||
    !sameNumber(row.min_qty, e.minQty) ||
    row.fractional_ok !== e.fractionalOk ||
    row.status !== e.status ||
    stable(row.attrs) !== stable(e.attrs)
  );
}

export async function syncInstrumentMaster(
  pool: pg.Pool,
  provider: MarketDataProvider,
  deps: { clock: Clock; logger: Logger },
): Promise<SyncResult> {
  const master = await provider.loadInstrumentMaster();
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const exchanges = new Map(
      (await client.query<{ id: string; code: string }>('SELECT id, code FROM exchanges')).rows.map(
        (r) => [r.code, r.id],
      ),
    );
    const existing = new Map<string, ExistingRow>();
    const rows = await client.query<ExistingRow>(
      `SELECT i.id, i.symbol, e.code AS exchange, i.name, i.asset_class::text AS asset_class,
              i.quote_currency, i.tick_size, i.qty_step, i.min_qty, i.fractional_ok,
              i.status::text AS status, i.attrs, m.provider_symbol
         FROM instruments i
         JOIN exchanges e ON e.id = i.exchange_id
         LEFT JOIN instrument_provider_map m ON m.instrument_id = i.id AND m.provider = $1`,
      [provider.id],
    );
    for (const r of rows.rows) existing.set(`${r.exchange}:${r.symbol}`, r);

    let inserted = 0;
    let updated = 0;
    let unchanged = 0;
    const skipped: string[] = [];
    const seen = new Set<string>();
    const now = deps.clock.now();

    for (const e of master) {
      const key = `${e.exchange}:${e.symbol}`;
      const exchangeId = exchanges.get(e.exchange);
      if (exchangeId === undefined) {
        skipped.push(key);
        deps.logger.warn('sync_skipped_unknown_exchange', {
          symbol: e.symbol,
          exchange: e.exchange,
        });
        continue;
      }
      seen.add(key);
      const row = existing.get(key);
      let instrumentId: string;
      if (row === undefined) {
        instrumentId = newId();
        await client.query(
          `INSERT INTO instruments (id, symbol, name, asset_class, exchange_id, quote_currency, tick_size,
                                    qty_step, min_qty, fractional_ok, status, tradable_in, attrs, updated_at, base_asset)
           VALUES ($1::uuid, $2, $3, $4::asset_class, $5::uuid, $6, $7::numeric, $8::numeric, $9::numeric,
                   $10, $11::instrument_status, $12::text[], $13::jsonb, $14, $15)`,
          [
            instrumentId,
            e.symbol,
            e.name,
            e.assetClass,
            exchangeId,
            e.quoteCurrency,
            e.tickSize,
            e.qtyStep,
            e.minQty,
            e.fractionalOk,
            e.status,
            [...(e.tradableIn ?? [])],
            JSON.stringify(e.attrs),
            now,
            e.baseAsset ?? null,
          ],
        );
        inserted += 1;
      } else {
        instrumentId = row.id;
        if (differs(row, e)) {
          await client.query(
            `UPDATE instruments
                SET name = $2, asset_class = $3::asset_class, quote_currency = $4, tick_size = $5::numeric,
                    qty_step = $6::numeric, min_qty = $7::numeric, fractional_ok = $8,
                    status = $9::instrument_status, attrs = $10::jsonb, updated_at = $11
              WHERE id = $1::uuid`,
            [
              instrumentId,
              e.name,
              e.assetClass,
              e.quoteCurrency,
              e.tickSize,
              e.qtyStep,
              e.minQty,
              e.fractionalOk,
              e.status,
              JSON.stringify(e.attrs),
              now,
            ],
          );
          updated += 1;
        } else {
          unchanged += 1;
        }
      }
      if (row === undefined || row.provider_symbol !== e.providerSymbol) {
        await client.query(
          `INSERT INTO instrument_provider_map (instrument_id, provider, provider_symbol)
           VALUES ($1::uuid, $2, $3)
           ON CONFLICT (instrument_id, provider) DO UPDATE SET provider_symbol = EXCLUDED.provider_symbol`,
          [instrumentId, provider.id, e.providerSymbol],
        );
      }
    }

    // Mapped to this provider but absent from its master: never deleted, never delisted by guesswork.
    const missing = [...existing.entries()]
      .filter(([key, r]) => r.provider_symbol !== null && !seen.has(key))
      .map(([key]) => key);
    for (const key of missing)
      deps.logger.warn('sync_instrument_missing_from_master', { instrument: key });

    await client.query('COMMIT');
    deps.logger.info('instrument_sync_done', {
      provider: provider.id,
      inserted,
      updated,
      unchanged,
    });
    return { inserted, updated, unchanged, skipped, missing };
  } catch (e) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw e;
  } finally {
    client.release();
  }
}
