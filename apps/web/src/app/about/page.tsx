import type { Metadata } from 'next';
import Link from 'next/link';

export const metadata: Metadata = { title: 'About VANTAGE' };

const H2 = 'mb-2 mt-6 text-[16px] font-semibold text-text-0';

/**
 * About (M10, D-112). Public, static, linked from the footer of every page. It says plainly what is simulated and what is not built.
 * The numbers in the execution section are illustrative parameters of the simulator (D-88, TRADING_ENGINE section 6), not research.
 */
export default function AboutPage() {
  return (
    <main id="main" className="mx-auto w-full max-w-3xl flex-1 px-4 py-6" data-testid="about-page">
      <h1 className="mb-3 text-[20px] font-semibold text-text-0">How VANTAGE works</h1>
      <p className="mb-2 text-text-1">
        VANTAGE is a trading simulator built as a portfolio project. Every account starts with
        $10,000 of virtual money. Nothing here is real trading, and it is not a brokerage.{' '}
        <Link href="/login">Sign in</Link> or <Link href="/register">create an account</Link>.
      </p>

      <h2 className={H2}>What is simulated</h2>
      <p className="mb-2 text-text-1">
        Prices come from a deterministic, seeded generator and are labelled SIM wherever they
        appear. They are not real quotes, and they say nothing about real markets. Stocks, ETFs and
        crypto are all simulated, and the crypto instruments trade around the clock.
      </p>

      <h2 className={H2}>How an order fills (model QBX-1)</h2>
      <p className="mb-2 text-text-1">
        A market order fills immediately at the current simulated ask (a buy) or bid (a sell), moved
        against you by a slippage amount in basis points, then rounded to the instrument&apos;s
        price step. A commission is added on top. For example, the crypto parameters are 5 basis
        points of slippage and a 10 basis point commission, and stocks have no commission and 2
        basis points of slippage. These are illustrative tuning values.
      </p>
      <p className="mb-2 text-text-1">
        Before accepting an order the system reserves enough cash to cover the price plus a collar
        (a 1% allowed adverse move for stocks, 2% for crypto). If the price moves further than the
        collar before the fill, the order is rejected as price moved and nothing is spent.
      </p>

      <h2 className={H2}>The ledger and idempotency</h2>
      <ul className="mb-2 list-disc pl-5 text-text-1">
        <li>
          Every change to cash or holdings is a pair of entries in an append-only double-entry
          ledger; database triggers refuse updates and deletes, and a reconciliation check verifies
          ten invariants.
        </li>
        <li>
          Money is exact decimal text end to end. The browser never does arithmetic on it: it only
          shows strings the server computed.
        </li>
        <li>
          Every order carries an idempotency key, so a retry or a double click places one order, not
          two.
        </li>
      </ul>

      <h2 className={H2}>Limit orders, reservations and the matcher</h2>
      <p className="mb-2 text-text-1">
        A limit order reserves cash (a buy) or shares (a sell) when it is accepted and then rests. A
        background matcher compares resting orders with each new simulated quote and fills them when
        the price reaches the limit. Cancelling releases the reservation.
      </p>

      <h2 className={H2}>Market depth is informational</h2>
      <p className="mb-2 text-text-1">
        The depth book shows a synthetic ladder around the current best bid and ask. Fills use the
        execution model above, not the book, so they never consume it.
      </p>

      <h2 className={H2}>What is deliberately not built</h2>
      <ul className="mb-2 list-disc pl-5 text-text-1">
        <li>Real money, real brokers or real exchanges.</li>
        <li>Margin, leverage or short selling.</li>
        <li>Live market data.</li>
        <li>Stop and stop-limit orders (not yet).</li>
        <li>Partial fills against a book.</li>
      </ul>

      <h2 className={H2}>Temporary demo accounts</h2>
      <p className="mb-2 text-text-1">
        Where the demo button is switched on, it creates a temporary account with a random address
        on the reserved <span className="font-mono">demo.invalid</span> domain and a random password
        that is never shown. It cannot be recovered after you sign out.
      </p>

      <h2 className={H2}>The stack</h2>
      <p className="mb-4 text-text-1">
        A Next.js web app that forwards API calls on its own origin, a NestJS API with PostgreSQL, a
        TypeScript monorepo, and Playwright, Vitest and property-based tests.
      </p>
      <p className="text-text-2">
        <Link href="/third-party-notices">Third-party notices</Link>
      </p>
    </main>
  );
}
