import type { Metadata } from 'next';
import Link from 'next/link';
import { APACHE_2_TEXT, LWC_NOTICE_TEXT, LWC_VERSION } from '../../lib/third-party-notices';

export const metadata: Metadata = { title: 'Third-party notices' };

/**
 * Third-party notices (M9a, D-103). Public (no session needed) and linked from the footer of every page: the licence of the chart
 * library requires its attribution notice and a link to https://www.tradingview.com/ on a page available to users.
 */
export default function ThirdPartyNoticesPage() {
  return (
    <main
      id="main"
      className="mx-auto w-full max-w-3xl flex-1 px-4 py-6"
      data-testid="notices-page"
    >
      <h1 className="mb-3 text-[20px] font-semibold text-text-0">Third-party notices</h1>
      <p className="mb-4 text-text-1">
        VANTAGE uses the software below. Its notices are reproduced exactly as published.{' '}
        <Link href="/portfolio">Back to the app</Link>
      </p>

      <section aria-labelledby="lwc-title" className="mb-6">
        <h2 id="lwc-title" className="mb-2 text-[16px] font-semibold text-text-0">
          TradingView Lightweight Charts {LWC_VERSION} (Apache License 2.0)
        </h2>
        <pre
          data-testid="lwc-notice"
          className="mb-2 whitespace-pre-wrap rounded-md border border-line bg-bg-1 p-3 text-[13px] text-text-1"
        >
          {LWC_NOTICE_TEXT}
        </pre>
        <p className="mb-2">
          Charts by{' '}
          <a href="https://www.tradingview.com/" data-testid="notices-tradingview-link">
            TradingView
          </a>
          . Licensed under the{' '}
          <a href="http://www.apache.org/licenses/LICENSE-2.0">Apache License, Version 2.0</a>. The
          package does not ship a NOTICE file; the notice above is the NOTICE file of the upstream
          repository at the tag of the version used.
        </p>
        <details className="rounded-md border border-line bg-bg-1 p-3">
          <summary className="cursor-pointer text-text-0">Full licence text</summary>
          <pre className="mt-2 whitespace-pre-wrap text-[12px] text-text-1">{APACHE_2_TEXT}</pre>
        </details>
      </section>

      <section aria-labelledby="fc-title" className="mb-6">
        <h2 id="fc-title" className="mb-2 text-[16px] font-semibold text-text-0">
          fancy-canvas 2.1.0 (MIT)
        </h2>
        <p>A dependency of Lightweight Charts, licensed under the MIT licence.</p>
      </section>

      <section aria-labelledby="fonts-title">
        <h2 id="fonts-title" className="mb-2 text-[16px] font-semibold text-text-0">
          Fonts
        </h2>
        <p>
          Inter and JetBrains Mono (through the @fontsource-variable packages) are licensed under
          the SIL Open Font License 1.1.
        </p>
      </section>
    </main>
  );
}
