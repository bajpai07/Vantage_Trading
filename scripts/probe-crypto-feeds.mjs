// M7a T1 evidence script (NOT part of CI, NOT used by any test): connects to candidate public crypto market-data streams
// for a few seconds each and prints the message rate, the latency against the local clock, the symbol names and the field
// formats. Read-only: no API key, no account, no subscription to anything private.
//
//   node scripts/probe-crypto-feeds.mjs [seconds]     (default 30)
//
// Uses Node's built-in WebSocket (global in Node 22). Output is JSON lines plus a summary; nothing is written to disk.
const seconds = Number(process.argv[2] ?? 30);

const CANDIDATES = [
  {
    name: 'binance-vision',
    url: 'wss://data-stream.binance.vision/stream?streams=btcusdt@bookTicker/ethusdt@bookTicker/btcusdt@trade',
    subscribe: null,
  },
  {
    name: 'binance-com',
    url: 'wss://stream.binance.com:9443/stream?streams=btcusdt@bookTicker/ethusdt@bookTicker/btcusdt@trade',
    subscribe: null,
  },
  {
    name: 'coinbase-exchange',
    url: 'wss://ws-feed.exchange.coinbase.com',
    subscribe: {
      type: 'subscribe',
      product_ids: ['BTC-USD', 'ETH-USD'],
      channels: ['ticker', 'heartbeat'],
    },
  },
];

function probe(c) {
  return new Promise((resolve) => {
    const started = Date.now();
    const out = {
      name: c.name,
      url: c.url,
      connected: false,
      error: null,
      messages: 0,
      bytes: 0,
      types: {},
      sample: {},
      lat: [],
    };
    let ws;
    try {
      ws = new WebSocket(c.url);
    } catch (e) {
      out.error = String(e);
      return resolve(out);
    }
    const done = (why) => {
      out.ended = why;
      out.seconds = (Date.now() - started) / 1000;
      try {
        ws.close();
      } catch {
        /* ignore */
      }
      resolve(out);
    };
    const timer = setTimeout(() => done('timeout-ok'), seconds * 1000);
    ws.onopen = () => {
      out.connected = true;
      out.connectMs = Date.now() - started;
      if (c.subscribe) ws.send(JSON.stringify(c.subscribe));
    };
    ws.onerror = (e) => {
      out.error = e.message ?? String(e.type);
    };
    ws.onclose = (e) => {
      clearTimeout(timer);
      if (out.ended === undefined) {
        out.closeCode = e.code;
        out.closeReason = e.reason;
        done('closed');
      }
    };
    ws.onmessage = (ev) => {
      const now = Date.now();
      const text = typeof ev.data === 'string' ? ev.data : String(ev.data);
      out.messages += 1;
      out.bytes += text.length;
      let j;
      try {
        j = JSON.parse(text);
      } catch {
        out.types.unparseable = (out.types.unparseable ?? 0) + 1;
        return;
      }
      const d = j.data ?? j;
      const type = j.stream ? `${j.stream.split('@')[1]}` : (j.type ?? d.e ?? 'unknown');
      out.types[type] = (out.types[type] ?? 0) + 1;
      if (out.sample[type] === undefined) out.sample[type] = text.slice(0, 400);
      // provider timestamp where there is one: coinbase ticker "time" (ISO), binance trade "T" / "E" (ms); bookTicker has none
      const ts = d.time !== undefined ? Date.parse(d.time) : (d.T ?? d.E);
      if (typeof ts === 'number' && Number.isFinite(ts)) out.lat.push(now - ts);
    };
  });
}

for (const c of CANDIDATES) {
  console.log(`--- ${c.name}: ${c.url}  (${String(seconds)} s)`);
  const r = await probe(c);
  const lat = r.lat.sort((a, b) => a - b);
  const q = (p) =>
    lat.length === 0 ? null : lat[Math.min(lat.length - 1, Math.floor(p * lat.length))];
  console.log(
    JSON.stringify(
      {
        name: r.name,
        connected: r.connected,
        connectMs: r.connectMs,
        ended: r.ended,
        error: r.error,
        closeCode: r.closeCode,
        closeReason: r.closeReason,
        messages: r.messages,
        perSecond: r.seconds ? Number((r.messages / r.seconds).toFixed(1)) : null,
        kbytes: Number((r.bytes / 1024).toFixed(1)),
        types: r.types,
        latencyMsAgainstLocalClock: {
          n: lat.length,
          p50: q(0.5),
          p95: q(0.95),
          min: lat[0] ?? null,
          max: lat.at(-1) ?? null,
        },
      },
      null,
      2,
    ),
  );
  for (const [t, s] of Object.entries(r.sample)) console.log(`sample[${t}]: ${s}`);
}
console.log(`local clock at end: ${new Date().toISOString()}`);
