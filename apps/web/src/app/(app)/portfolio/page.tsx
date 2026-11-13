import type { Metadata } from 'next';

export const metadata: Metadata = { title: 'Portfolio' };

// Placeholder until the portfolio screen (T3); the session is already enforced by the (app) layout.
export default function PortfolioPage() {
  return <h1 className="text-[20px] font-semibold text-text-0">Portfolio</h1>;
}
