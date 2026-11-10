# VANTAGE — DESIGN_SYSTEM.md

Version 2.0 · Direction: premium institutional dark terminal. Deep navy and near-black surfaces, electric-blue and violet accents, restrained green/red. Dense, precise, readable. Not a SaaS dashboard.

## 1. Design principles

1. **Data is the interface.** Numbers, tables and charts get the space; chrome stays thin.
2. **Honesty is visible.** Every price shows freshness and source on demand; every blocked action explains itself.
3. **Density with order.** Compact rows (28px), strict alignment on decimal points, consistent column order across tables.
4. **Quiet colour.** Colour carries meaning (direction, state), never decoration. Accent colours are rare.
5. **Keyboard first.** Every frequent action has a shortcut and a visible hint.
6. **No decoration motion.** Motion only confirms a change (price tick flash, panel open).

## 2. Colour tokens (dark theme is the product; light theme is out of scope for MVP)

Surfaces (navy-black ramp, each step about +3–4% lightness):

| Token | Hex | Use |
|---|---|---|
| `--bg-0` | `#070A12` | App background, behind panels |
| `--bg-1` | `#0B1020` | Panel background |
| `--bg-2` | `#10172A` | Raised panels, table header, inputs |
| `--bg-3` | `#16203A` | Hover rows, menus, popovers |
| `--bg-4` | `#1D2A4A` | Selected row, active tab fill |
| `--line` | `#1E2845` | 1px hairlines |
| `--line-strong` | `#2B3862` | Dividers on focus/hover |

Text:

| Token | Hex | Contrast on `--bg-1` | Use |
|---|---|---|---|
| `--text-0` | `#F2F5FB` | ~16:1 | Primary figures, headings |
| `--text-1` | `#C3CCE0` | ~10:1 | Body, labels |
| `--text-2` | `#8591AD` | ~5.4:1 | Secondary, units, column heads |
| `--text-3` | `#5F6B88` | ~3.3:1 | Disabled, placeholders only (not for essential info) |

Accents and semantics:

| Token | Hex | Use |
|---|---|---|
| `--accent` | `#3D7BFF` | Primary interactive (links, focus, primary button) |
| `--accent-hi` | `#6A9BFF` | Hover |
| `--violet` | `#8B6CFF` | Secondary accent: AI coach, competitions, selection highlights in analytics. Never on price direction |
| `--up` | `#27C28A` | Positive change (text), buy |
| `--up-bg` | `rgba(39,194,138,.14)` | Positive fills |
| `--down` | `#F2566B` | Negative change (text), sell |
| `--down-bg` | `rgba(242,86,107,.14)` | Negative fills |
| `--warn` | `#E8B24A` | Delayed, caution |
| `--stale` | `#E8884A` | Stale data |
| `--info` | `#4BB5E8` | Informational |

Rules: green/red are always paired with a sign (+/−), arrow or text; never colour alone. Buy button uses `--up`, sell uses `--down`; the *primary action colour* of the app (accent) is blue, so the Buy/Sell buttons are the only large green/red surfaces in the product. Gradients: none in the terminal; the landing page may use one subtle navy-to-violet radial glow behind the hero, nowhere else.

Chart palette: candle up `#27C28A` (body fill `#27C28A`, wick same), down `#F2566B`; volume bars at 40% opacity of the same colours; grid `#1E2845` at 50%; crosshair `#8591AD`; MA lines `#3D7BFF`, `#8B6CFF`, `#E8B24A`; RSI line `#4BB5E8` with 30/70 bands `#2B3862`.

## 3. Typography

| Role | Family | Notes |
|---|---|---|
| UI | **Inter** (variable) | Tight tracking −0.01em in headings; `font-feature-settings: "cv11","ss01"` |
| Numbers/prices | **JetBrains Mono** (or IBM Plex Mono) | `font-variant-numeric: tabular-nums` always; used for every price, qty, P&L, timestamp |
| Display (landing only) | Inter Display weight 600 | Hero headline only |

Scale (px/line-height): 11/14 micro (badges), 12/16 table cells and labels, 13/18 body (default in terminal), 14/20 forms, 16/22 panel titles, 20/26 page titles, 28/34 landing. Terminal panels never use text above 16px except the instrument header price (22px mono).

Number formatting: thousands separators by user locale setting; USD to 2 dp (crypto prices adapt: ≥ 1000 → 2 dp, 1–1000 → 4 dp, < 1 → up to 8 dp); percent 2 dp; INR with lakh grouping option; negative values with a real minus sign `−` (U+2212); P&L always shows an explicit `+`. Right-align numeric columns; align decimals via tabular numerals.

## 4. Spacing, shape, elevation

- Base unit 4px; layout uses 4/8/12/16. Table row 28px (compact) or 32px (comfortable setting). Panel padding 8–12px. Panel header 32px.
- Radius: 2px for badges/inputs-in-tables, 4px for buttons/inputs, 6px for popovers. No radius above 8px anywhere.
- Elevation by surface step, not shadows. Only overlays (menus, dialogs, toasts) get a shadow: `0 8px 24px rgba(0,0,0,.45)`.
- Borders: 1px `--line`. Panels are separated by 1px gaps showing `--bg-0`, producing a tiled workstation look.

## 5. Layout system

Desktop terminal grid (≥ 1280px):

```
┌───────────────────────────────────────────────────────────────────────────────┐
│ TOPBAR 40px: VANTAGE | search (/) | sessions: US● IN○ CRYPTO● | Equity | 🔔 | acct│
├──┬────────────────────────────────────────────────────────┬───────────────────┤
│  │ INSTRUMENT HEADER 56px: AAPL  Apple Inc · NASDAQ · USD │ ORDER TICKET      │
│R │  189.97  +1.24 (+0.66%)  Bid 189.95  Ask 190.00  [●DELAYED 15m] │ (320px)  │
│A ├────────────────────────────────────────────────────────┤ Buy | Sell       │
│I │ CHART  tf: 1m 5m 15m 1h 1D   indicators  candle/line    │ Type Qty TIF     │
│L │                                                         │ Preview + [Place]│
│48│                                                         ├───────────────────┤
│px│                                                         │ WATCHLIST         │
│  ├────────────────────────────────────────────────────────┤  (virtualised)    │
│  │ BOTTOM TABS 240px: Positions | Orders | Fills | Activity│ INSTRUMENT INFO  │
└──┴────────────────────────────────────────────────────────┴───────────────────┘
```

- Left rail: icons with tooltips (Markets, Terminal, Portfolio, Orders, Journal, Analytics, Competitions, Settings), 48px.
- Panels are resizable via splitters; layouts persist per user (`workspace_layouts`, P2: presets "Trade", "Analyse"). MVP ships the default plus resizable splitters stored locally.
- Breakpoints: ≥1280 full terminal; 1024–1279 right column collapses to a drawer; 768–1023 (tablet) chart on top, ticket as a side sheet; < 768 (mobile) single-column with bottom tab bar: Markets · Chart · Trade · Portfolio · More. The order ticket is a bottom sheet; tables become two-line cards (symbol + P&L; details on expand). Charts keep full width and a reduced toolbar.

## 6. Components (spec each; Storybook stories required)

| Component | Behaviour and rules |
|---|---|
| **PriceCell** | Mono tabular; tick flash 120ms (`--up-bg`/`--down-bg`) only on change; respects reduced-motion; shows stale styling (`--stale` text + dotted underline) when STALE |
| **FreshnessBadge** | Pill 11px: `REAL-TIME` (dot `--up`), `DELAYED 15m` (`--warn`), `STALE 2m` (`--stale`), `CLOSED` (`--text-2`), `UNAVAILABLE` (`--down`). Click/hover: popover with source, provider timestamp, receive time, entitlement, licence note |
| **ChangeCell** | `+1.24 (+0.66%)` coloured with sign and ▲/▼ glyph |
| **DataTable** | Virtualised (TanStack Table + virtual), sticky header, sortable columns, column chooser, keyboard row navigation, right-aligned numerics, row density setting, empty and loading states, CSV export for owner data |
| **OrderTicket** | Side tabs (Buy/Sell), type select, qty (shares or USD notional; converts server-side preview), limit/stop fields appear per type, TIF, **pre-trade preview** (est. fill, fees, FX line for INR, buying power after), primary submit labelled with side, symbol and qty (e.g. "Buy 10 AAPL"), disabled state always paired with a reason line. Confirmation: optional "confirm orders" setting (default on for first 5 trades, then off) |
| **Chart** | TradingView Lightweight Charts. Candles/line, volume pane, up to 3 overlays + 1 oscillator pane (RSI at MVP), crosshair with OHLC legend, timeframe buttons, log/linear toggle, session breaks, "last updated" tag, gaps shown as gaps. Order and position lines drawn on the chart (entry price, stop/limit lines) with drag-to-modify in P2 |
| **PositionsTable** | Symbol, qty, avg cost, mark, mkt value (USD), unrealised P&L (USD + %), day P&L, FX effect (INR rows), weight %, actions (close, set stop) |
| **OrderStatusTimeline** | Vertical timeline from `order_events` with the quote used per fill |
| **MetricCard (compact)** | Label (12px `--text-2`), value (mono 18px), delta; a "?" opens the **methodology popover** (formula, window, sample size). Used only in analytics, never decoratively |
| **EquityCurve / Allocation** | Line chart with benchmark overlay (P2), drawdown shading; allocation as horizontal bars (preferred over pies) |
| **CommandPalette** | `Cmd/Ctrl+K`: search instruments, jump to pages, run actions |
| **Toast** | Fills, rejects, alerts. Reject toasts show the reject code and a plain-language reason |
| **Banner** | Persistent: "Virtual money · not a brokerage"; data-delay notice when delayed feeds are in use |
| **EmptyState** | Instructional, one action (e.g. "No positions. Search a symbol to place your first order") |

All components expose loading, empty, error, stale and disabled states. Component library: shadcn/ui primitives, restyled; tokens in Tailwind theme; icons Lucide at 16px/1.5 stroke.

## 7. Screen specifications (MVP unless stated)

**Landing.** Hero with product screenshot (real UI, no mock numbers presented as live), three promise tiles (real data labelled; honest execution; learn from results), data-source disclosure, "Create free account". Disclosure "virtual money" visible above the fold.

**Registration/Onboarding.** Steps: account → verify email → intro modal 1/3 "Virtual $10,000, real market data" → 2/3 "How freshness labels work" → 3/3 pick starter watchlist (US large caps, ETFs, top crypto) → guided first order (ticket highlights fields; preview explained) → portfolio view. Skippable after step 1; progress saved.

**Markets (MVP-lite).** Indices strip (reference quotes, with source), movers computed from our stored quotes (US large-cap universe + crypto), most active, session clocks, crypto 24h. News/calendar tiles appear only when a licensed source exists (P2).

**Terminal.** As §5. Default instrument: last viewed or SPY.

**Portfolio.** Top summary bar (equity, cash, reserved, invested, day P&L, total return, with timestamp and freshness of marks), equity curve, allocation bars (asset class, currency, instrument), holdings table, realised P&L table (trading vs FX columns when INR positions exist).

**Orders.** Tabs: Open, Filled, Cancelled, Rejected, Expired; click row → side panel timeline + execution table with quote details and `model_version`.

**Journal.** Auto-created entries list with filters; detail with notes, tags, rating; entry/exit mini chart with marker lines.

**Analytics.** Metric grid (each with methodology), equity and drawdown curves, performance by instrument and asset class, holding-period histogram (P2), sample-size warnings.

**Watchlists.** Left list switcher, table with sortable columns, drag reorder, add via search, alerts column (P2).

**Competitions (P2).** List, rules (scoring formula shown), leaderboard (rank, score, return, max drawdown, trades), my entry, history.

**AI coach (P2).** Side panel in violet accent: asks about portfolio/journal; every number it cites is rendered from a tool result and linked to its source view; "analysis, not advice" footer.

**Admin.** Dense tables: users, feeds (health cards), trading controls (kill switches), audit log with filters, fee/slippage config with version diff and approve step.

**Settings.** Profile, security (sessions, 2FA in P2), preferences (density, number format, default timeframe, confirm orders), notifications, data export/delete.

## 8. Interaction guidelines

- **Shortcuts (default):** `/` search, `B` buy tab, `S` sell tab, `Q` focus quantity, `Enter` submit (when ticket focused and valid), `Esc` close/cancel, `G P` portfolio, `G O` orders, `[`/`]` previous/next watchlist symbol, `1`–`5` timeframes. Shortcuts are listed in a `?` overlay and are disabled while typing in inputs.
- **Optimistic UI is prohibited for money:** orders, fills and balances update only after server confirmation (events). Pending states show spinners with "Awaiting server".
- **Order feedback:** accepted → toast + row appears in Open Orders; filled → toast with price, quantity, fee, and a link to the order; rejected → toast with plain reason.
- **Data states:** loading uses skeleton rows with fixed dimensions to prevent layout shift; disconnected shows a top banner "Reconnecting… prices frozen" and greys price cells; STALE per instrument as above.
- **Destructive actions** (cancel all, close position) require confirm with the quantity and estimated result spelled out.
- **Errors** are specific, not generic ("Insufficient buying power: need $1,919.00, have $1,500.00").
- **Accessibility:** WCAG 2.2 AA for all non-chart UI; focus rings `2px --accent`; all tables navigable by keyboard; chart has an "Open data table" action; colour-blind mode toggles up/down to blue/orange plus always-on glyphs; reduced-motion respected; minimum touch target 44px on mobile.
- **Performance budget:** JS initial bundle ≤ 250 KB gzip for the app shell (chart code-split); LCP ≤ 2.5 s on throttled 4G mid device; INP ≤ 200 ms; chart ≥ 50 fps at 5,000 candles; ≤ 2 React components re-render per tick (selector-based Zustand slices + memoised cells); WebSocket quote updates are batched per animation frame.

## 9. Brand

Working name VANTAGE. Wordmark in Inter 600, tracking +0.08em, uppercase; mark: a stylised "V" formed by two ascending strokes (blue → violet) used at 16–24px in the top bar. The violet is reserved for brand moments, AI and competitions. Name/trademark clearance (India, US) is a pre-launch task (see ROADMAP, Phase 0).

## 10. Acceptance criteria (design system module)

1. Tokens defined once (Tailwind theme + CSS variables); lint rule rejects raw hex colours in components.
2. Contrast: automated check passes for every text/background token pair used (≥ 4.5:1 for text, ≥ 3:1 for UI components).
3. Storybook stories for all components in §6 covering loading/empty/error/stale/disabled.
4. Visual regression (Playwright screenshots) for Terminal, Portfolio, Orders at 1440, 1024, 390 widths.
5. Axe accessibility scan: 0 critical/serious on all MVP screens.
6. All prices rendered through PriceCell/FreshnessBadge (a test enumerates price nodes; any raw price text fails).
7. Perf budget enforced in CI (Lighthouse CI) with the numbers in §8.
8. Usability check with 5 target users: ≥ 4 of 5 complete "place a first limit order" unaided in under 3 minutes.
