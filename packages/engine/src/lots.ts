// FIFO lot consumption and proceeds allocation. Pure: no IO, no clock, no randomness.
import { add, compare, div, isZero, mul, parse, round8, sign, sub } from '@vantage/money';
import type { Dec } from '@vantage/money';
import { EngineInputError } from './errors.js';

export interface OpenLot {
  readonly id: string;
  /** When the lot was opened. Time is data here, never read from a clock. */
  readonly openedAt: Date;
  readonly qtyOpen: string;
  /** Execution price, excluding fees. */
  readonly costPerUnit: string;
}

export interface LotConsumption {
  readonly lotId: string;
  /** Shares taken from this lot. */
  readonly qty: string;
  /** qty x the lot's cost per unit (exact). */
  readonly cost: string;
  /** What the lot has left after this sale. */
  readonly qtyOpenAfter: string;
}

/**
 * First in, first out: oldest lot first, ordered by (openedAt, id). Throws if the open lots hold less than
 * `qty` (the caller checked the position first, so this is a corruption signal).
 */
export function consumeLotsFIFO(lots: readonly OpenLot[], qty: string): LotConsumption[] {
  const want = parse(qty);
  if (sign(want) <= 0) throw new EngineInputError('qty must be positive');
  const ordered = [...lots].sort((a, b) => {
    const t = a.openedAt.getTime() - b.openedAt.getTime();
    if (t !== 0) return t;
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  });
  const out: LotConsumption[] = [];
  let remaining: Dec = want;
  for (const lot of ordered) {
    if (isZero(remaining)) break;
    const open = parse(lot.qtyOpen);
    if (sign(open) <= 0) continue;
    const take = compare(open, remaining) <= 0 ? open : remaining;
    out.push({
      lotId: lot.id,
      qty: take.toString(),
      cost: mul(take, parse(lot.costPerUnit)).toString(),
      qtyOpenAfter: sub(open, take).toString(),
    });
    remaining = sub(remaining, take);
  }
  if (!isZero(remaining))
    throw new EngineInputError('the open lots hold fewer shares than the quantity sold');
  return out;
}

/**
 * Splits total proceeds over consumed pieces proportionally by quantity. Every piece but the last is rounded
 * to 8 decimal places (HALF_EVEN); the last is the total minus the others, so the pieces sum EXACTLY to the total.
 */
export function allocateProceeds(
  totalProceeds: string,
  consumptions: ReadonlyArray<{ readonly qty: string }>,
): string[] {
  if (consumptions.length === 0) throw new EngineInputError('nothing to allocate proceeds to');
  const total = parse(totalProceeds);
  const totalQty = consumptions.reduce<Dec>((acc, c) => add(acc, parse(c.qty)), parse('0'));
  if (sign(totalQty) <= 0) throw new EngineInputError('consumed quantity must be positive');
  const pieces: string[] = [];
  let allocated: Dec = parse('0');
  consumptions.forEach((c, i) => {
    if (i === consumptions.length - 1) {
      pieces.push(sub(total, allocated).toString());
      return;
    }
    const piece = round8(div(mul(total, parse(c.qty)), totalQty, 12, 'HALF_EVEN'));
    allocated = add(allocated, piece);
    pieces.push(piece.toString());
  });
  return pieces;
}
