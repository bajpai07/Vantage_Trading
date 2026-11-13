import type { Metadata, Viewport } from 'next';
import '@fontsource-variable/inter';
import '@fontsource-variable/jetbrains-mono';
import './globals.css';
import { FeedBanner } from '../components/feed-banner';
import { Footer } from '../components/footer';
import { getFeedInfo } from '../lib/feed';

export const metadata: Metadata = {
  title: { default: 'VANTAGE', template: '%s · VANTAGE' },
  description: 'A virtual-money trading simulator. Not a brokerage.',
};
export const viewport: Viewport = { colorScheme: 'dark' };

// Every page depends on the session and on the live data source, and the CSP nonce is per request.
export const dynamic = 'force-dynamic';

export default async function RootLayout({ children }: { children: React.ReactNode }) {
  const feed = await getFeedInfo();
  return (
    <html lang="en">
      <body>
        <a href="#main" className="skip-link">
          Skip to content
        </a>
        <FeedBanner feed={feed} />
        {children}
        <Footer />
      </body>
    </html>
  );
}
