// The simulated universe (D-78): which instruments the SIM feed quotes, with ILLUSTRATIVE base prices. Versioned: change a
// number and bump `version` and `asOf`. None of this is market data: the base levels are round numbers chosen so the demo
// looks plausible, and the price model (sim.ts) wanders around them. Real company names and fund names are used because
// the instrument master is real; no identifier here is presented as a real listing detail beyond name and exchange code.
import type { CandleInstrument } from './candles.js';

export const SIM_UNIVERSE_VERSION = 1;
/** The date the illustrative base levels were last reviewed. */
export const SIM_UNIVERSE_AS_OF = '2026-11-14';
export const SIM_UNIVERSE_NOTE =
  'Illustrative base prices for a simulated demo feed. They are round numbers, not market data, and the simulation does not track real prices.';

export interface SimInstrument extends CandleInstrument {
  readonly name: string;
  readonly assetClass: 'EQUITY' | 'ETF' | 'CRYPTO';
  /** Exchange code in the `exchanges` table (XNAS, XNYS, ARCX, or CRYPTO for the simulated 24/7 crypto market). */
  readonly exchange: 'XNAS' | 'XNYS' | 'ARCX' | 'CRYPTO';
  /** Crypto only: the base asset (BTC). */
  readonly baseAsset?: string;
}

const stock = (
  symbol: string,
  name: string,
  assetClass: 'EQUITY' | 'ETF',
  exchange: 'XNAS' | 'XNYS' | 'ARCX',
  basePrice: string,
  dailyVolBps: number,
  baseSpreadTicks: number,
  sharesPerMinute: number,
): SimInstrument => ({
  symbol,
  name,
  assetClass,
  exchange,
  basePrice,
  tickDp: 2,
  dailyVolBps,
  baseSpreadTicks,
  gapBps: assetClass === 'ETF' ? 30 : 60,
  volumeUnitsPerMinute: sharesPerMinute, // synthetic: shares per minute
  volumeDp: 0,
});

const crypto = (
  symbol: string,
  baseAsset: string,
  name: string,
  basePrice: string,
  tickDp: number,
  dailyVolBps: number,
  baseSpreadTicks: number,
  unitsPerMinute: number,
): SimInstrument => ({
  symbol,
  name,
  assetClass: 'CRYPTO',
  exchange: 'CRYPTO',
  baseAsset,
  basePrice,
  tickDp,
  dailyVolBps,
  baseSpreadTicks,
  gapBps: 0, // crypto never closes: no overnight gap
  volumeUnitsPerMinute: unitsPerMinute, // synthetic: 1e-8 units of the base asset per minute
  volumeDp: 8,
});

/** Stocks and ETFs (the existing instrument seeds). Daily volatility in basis points, illustrative. */
export const SIM_STOCKS: readonly SimInstrument[] = [
  stock('AAPL', 'Apple Inc.', 'EQUITY', 'XNAS', '190.00', 150, 1, 900),
  stock('MSFT', 'Microsoft Corporation', 'EQUITY', 'XNAS', '420.00', 140, 1, 400),
  stock('NVDA', 'NVIDIA Corporation', 'EQUITY', 'XNAS', '130.00', 290, 1, 1500),
  stock('TSLA', 'Tesla, Inc.', 'EQUITY', 'XNAS', '250.00', 380, 2, 1100),
  stock('AMZN', 'Amazon.com, Inc.', 'EQUITY', 'XNAS', '185.00', 190, 1, 700),
  stock('GOOGL', 'Alphabet Inc. Class A', 'EQUITY', 'XNAS', '175.00', 170, 1, 450),
  stock('META', 'Meta Platforms, Inc.', 'EQUITY', 'XNAS', '520.00', 230, 2, 300),
  stock('SPY', 'SPDR S&P 500 ETF Trust', 'ETF', 'ARCX', '560.00', 90, 1, 1800),
  stock('QQQ', 'Invesco QQQ Trust', 'ETF', 'XNAS', '480.00', 120, 1, 900),
  stock('VOO', 'Vanguard S&P 500 ETF', 'ETF', 'ARCX', '515.00', 90, 1, 250),
  stock('JPM', 'JPMorgan Chase & Co.', 'EQUITY', 'XNYS', '215.00', 130, 1, 250),
  stock('KO', 'The Coca-Cola Company', 'EQUITY', 'XNYS', '62.00', 90, 1, 400),
];

/** Crypto pairs quoted in USD. Tick sizes are the usual ones for each pair on public venues (illustrative). */
export const SIM_CRYPTO: readonly SimInstrument[] = [
  crypto('BTC-USD', 'BTC', 'Bitcoin', '67000.00', 2, 320, 1, 35_000_000),
  crypto('ETH-USD', 'ETH', 'Ethereum', '3200.00', 2, 400, 1, 500_000_000),
  crypto('SOL-USD', 'SOL', 'Solana', '150.00', 2, 560, 1, 8_000_000_000),
  crypto('XRP-USD', 'XRP', 'XRP', '0.5500', 4, 520, 2, 200_000_000_000),
  crypto('DOGE-USD', 'DOGE', 'Dogecoin', '0.15000', 5, 640, 2, 2_000_000_000_000),
  crypto('BNB-USD', 'BNB', 'BNB', '580.00', 2, 380, 1, 1_200_000_000),
];

export const SIM_UNIVERSE: readonly SimInstrument[] = [...SIM_STOCKS, ...SIM_CRYPTO];

/** Crypto quantities move in 8 decimal places (noted for M8, when fractional trading arrives). */
export const SIM_CRYPTO_QTY_STEP = '0.00000001';
