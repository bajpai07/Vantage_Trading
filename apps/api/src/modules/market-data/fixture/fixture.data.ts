// FIXTURE DATA: synthetic prices for local development and tests ONLY.
// Real company names and exchange codes, but every price is obviously fake (a multiple of 11.11).
// This table is the only place in src/ allowed to hold hard-coded prices (see no-hardcoded-prices.test.ts).

export interface FixtureInstrument {
  readonly symbol: string;
  readonly name: string;
  readonly assetClass: 'EQUITY' | 'ETF';
  readonly exchange: 'XNAS' | 'XNYS' | 'ARCX';
}

export const FIXTURE_INSTRUMENTS: readonly FixtureInstrument[] = [
  { symbol: 'AAPL', name: 'Apple Inc.', assetClass: 'EQUITY', exchange: 'XNAS' },
  { symbol: 'MSFT', name: 'Microsoft Corporation', assetClass: 'EQUITY', exchange: 'XNAS' },
  { symbol: 'GOOGL', name: 'Alphabet Inc. Class A', assetClass: 'EQUITY', exchange: 'XNAS' },
  { symbol: 'AMZN', name: 'Amazon.com, Inc.', assetClass: 'EQUITY', exchange: 'XNAS' },
  { symbol: 'NVDA', name: 'NVIDIA Corporation', assetClass: 'EQUITY', exchange: 'XNAS' },
  { symbol: 'META', name: 'Meta Platforms, Inc.', assetClass: 'EQUITY', exchange: 'XNAS' },
  { symbol: 'TSLA', name: 'Tesla, Inc.', assetClass: 'EQUITY', exchange: 'XNAS' },
  { symbol: 'AVGO', name: 'Broadcom Inc.', assetClass: 'EQUITY', exchange: 'XNAS' },
  { symbol: 'COST', name: 'Costco Wholesale Corporation', assetClass: 'EQUITY', exchange: 'XNAS' },
  { symbol: 'NFLX', name: 'Netflix, Inc.', assetClass: 'EQUITY', exchange: 'XNAS' },
  { symbol: 'AMD', name: 'Advanced Micro Devices, Inc.', assetClass: 'EQUITY', exchange: 'XNAS' },
  { symbol: 'CSCO', name: 'Cisco Systems, Inc.', assetClass: 'EQUITY', exchange: 'XNAS' },
  { symbol: 'ADBE', name: 'Adobe Inc.', assetClass: 'EQUITY', exchange: 'XNAS' },
  { symbol: 'PEP', name: 'PepsiCo, Inc.', assetClass: 'EQUITY', exchange: 'XNAS' },
  { symbol: 'QCOM', name: 'QUALCOMM Incorporated', assetClass: 'EQUITY', exchange: 'XNAS' },
  { symbol: 'INTC', name: 'Intel Corporation', assetClass: 'EQUITY', exchange: 'XNAS' },
  { symbol: 'JPM', name: 'JPMorgan Chase & Co.', assetClass: 'EQUITY', exchange: 'XNYS' },
  { symbol: 'V', name: 'Visa Inc.', assetClass: 'EQUITY', exchange: 'XNYS' },
  { symbol: 'JNJ', name: 'Johnson & Johnson', assetClass: 'EQUITY', exchange: 'XNYS' },
  { symbol: 'XOM', name: 'Exxon Mobil Corporation', assetClass: 'EQUITY', exchange: 'XNYS' },
  { symbol: 'PG', name: 'The Procter & Gamble Company', assetClass: 'EQUITY', exchange: 'XNYS' },
  { symbol: 'KO', name: 'The Coca-Cola Company', assetClass: 'EQUITY', exchange: 'XNYS' },
  { symbol: 'DIS', name: 'The Walt Disney Company', assetClass: 'EQUITY', exchange: 'XNYS' },
  { symbol: 'HD', name: 'The Home Depot, Inc.', assetClass: 'EQUITY', exchange: 'XNYS' },
  { symbol: 'SPY', name: 'SPDR S&P 500 ETF Trust', assetClass: 'ETF', exchange: 'ARCX' },
  { symbol: 'QQQ', name: 'Invesco QQQ Trust', assetClass: 'ETF', exchange: 'XNAS' },
  { symbol: 'VOO', name: 'Vanguard S&P 500 ETF', assetClass: 'ETF', exchange: 'ARCX' },
  { symbol: 'VTI', name: 'Vanguard Total Stock Market ETF', assetClass: 'ETF', exchange: 'ARCX' },
  { symbol: 'IWM', name: 'iShares Russell 2000 ETF', assetClass: 'ETF', exchange: 'ARCX' },
  {
    symbol: 'DIA',
    name: 'SPDR Dow Jones Industrial Average ETF Trust',
    assetClass: 'ETF',
    exchange: 'ARCX',
  },
  { symbol: 'GLD', name: 'SPDR Gold Shares', assetClass: 'ETF', exchange: 'ARCX' },
  {
    symbol: 'XLK',
    name: 'Technology Select Sector SPDR Fund',
    assetClass: 'ETF',
    exchange: 'ARCX',
  },
];

/** Synthetic base price: (position in the list + 1) x 11.11, e.g. 11.11, 22.22, 33.33. */
export const FIXTURE_PRICE_STEP = '11.11';
/** Synthetic spread between bid and ask. */
export const FIXTURE_SPREAD = '0.02';
