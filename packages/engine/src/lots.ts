// FIFO lot consumption and proceeds allocation. Pure: no IO, no clock, no randomness, no floats.
//
// D-85 (exact cost basis by construction). Every open lot carries `costRemaining`: the total cost of its REMAINING
// quantity, 8 decimal places. A sale that takes `q` of a lot with `qtyOpen = Q` and `costRemaining = R` consumes
//   * exactly R when q = Q (the last piece is taken by SUBTRACTION, so a lot's cost is never lost or invented), and
//   * round8(R x q / Q), HALF_EVEN, otherwise (clamped so that a lot that keeps quantity keeps at least one unit of
//     cost: see CLAMP below).
// The consumed costs of one sale are the basis B posted to the ledger, so the ledger and the lots use ONE number.
import { add, compare, div, isZero, mul, parse, round8, sign, sub } from '@vantage/money';
import type { Dec } from '@vantage/money';
import { EngineInputError } from './errors.js';

export interface OpenLot {
  readonly id: string;
  /** When the lot was opened. Time is data here, never read from a clock. */
  readonly openedAt: Date;
  readonly qtyOpen: string;
  /** Total cost of the remaining quantity (8 decimal places), fees excluded. */
  readonly costRemaining: string;
}

export interface LotConsumption {
  readonly lotId: string;
  /** Quantity taken from this lot. */
  readonly qty: string;
  /** The cost of that quantity (the D-85 rule). */
  readonly cost: string;
  /** What the lot has left after this sale. */
  readonly qtyOpenAfter: string;
  /** The cost the lot has left after this sale: costRemaining - cost. */
  readonly costRemainingAfter: string;
}

const ONE_UNIT = parse('0.00000001');

/**
 * First in, first out: oldest lot first, ordered by (openedAt, id). Throws if the open lots hold less than
 * `qty` (the caller checked the position first, so this is a corruption signal).
 *
 * CLAMP: the database requires cost_remaining = 0 if and only if qty_open = 0. A lot of a few smallest units whose
 * proportional share rounds up to the WHOLE remaining cost would break that, so such a partial piece consumes one
 * smallest unit (0.00000001) less. It can only happen when a lot's remaining cost is a few smallest units.
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
    const costR = parse(lot.costRemaining);
    const take = compare(open, remaining) <= 0 ? open : remaining;
    let cost: Dec;
    if (take.equals(open)) {
      cost = costR; // the last piece of a lot: by subtraction, exactly what is left
    } else {
      cost = round8(div(mul(costR, take), open, 8, 'HALF_EVEN'));
      if (compare(cost, costR) >= 0) cost = sub(costR, ONE_UNIT); // CLAMP (see above)
      if (sign(cost) < 0) cost = parse('0'); // costR was 0 (corruption) or below one unit: never negative
    }
    out.push({
      lotId: lot.id,
      qty: take.toString(),
      cost: cost.toString(),
      qtyOpenAfter: sub(open, take).toString(),
      costRemainingAfter: sub(costR, cost).toString(),
    });
    remaining = sub(remaining, take);
  }
  if (!isZero(remaining))
    throw new EngineInputError('the open lots hold fewer shares than the quantity sold');
  return out;
}

/**
 * Splits total proceeds over consumed pieces proportionally by quantity. Every piece but the last is rounded
 * to 8 decimal places (HALF_EVEN, in one division, no double rounding); the last is the total minus the others,
 * so the pieces sum EXACTLY to the total.
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
    const piece = div(mul(total, parse(c.qty)), totalQty, 8, 'HALF_EVEN');
    allocated = add(allocated, piece);
    pieces.push(piece.toString());
  });
  return pieces;
}
