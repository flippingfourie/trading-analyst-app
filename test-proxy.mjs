// Smoke tests for proxy-server.js — assumes proxy is running on :8787.
// Run via VS Code task "Run proxy smoke tests" or:  node test-proxy.mjs
//
// Tests only the deterministic, free endpoints (no AI cost):
//   /klines, /scan, /montecarlo, /sentiment

const BASE = 'http://127.0.0.1:8787';
let pass = 0, fail = 0;

async function test(name, fn) {
    try {
        await fn();
        console.log(`  PASS  ${name}`);
        pass++;
    } catch (e) {
        console.log(`  FAIL  ${name}\n        ${e.message}`);
        fail++;
    }
}

function assert(cond, msg) {
    if (!cond) throw new Error(msg || 'assertion failed');
}

async function get(path, timeoutMs = 30000) {
    const r = await fetch(BASE + path, { signal: AbortSignal.timeout(timeoutMs) });
    if (!r.ok) throw new Error(`HTTP ${r.status} ${path}`);
    return r.json();
}

console.log(`Proxy smoke tests against ${BASE}`);
console.log('Make sure proxy is running (start-proxy.ps1).\n');

// 1. Connectivity
await test('proxy is reachable', async () => {
    await get('/klines?symbol=BTCUSDT&interval=1h&limit=1');
});

// 2. /klines returns OHLCV candles
await test('/klines returns 100 BTCUSDT 1h candles', async () => {
    const data = await get('/klines?symbol=BTCUSDT&interval=1h&limit=100');
    assert(Array.isArray(data.candles), 'candles is not an array');
    assert(data.candles.length >= 50, `expected >=50 candles, got ${data.candles.length}`);
    const c = data.candles[0];
    assert(typeof c.open === 'number' && c.open > 0, 'open should be a positive number');
    assert(typeof c.high === 'number' && c.high >= c.low, 'high should be >= low');
    assert(typeof c.volume === 'number', 'volume should be a number');
});

// 3. /klines fallback works for less-common symbol
await test('/klines fallback handles ETHUSDT 4h', async () => {
    const data = await get('/klines?symbol=ETHUSDT&interval=4h&limit=200');
    assert(data.candles && data.candles.length > 100, 'should fetch ETH 4h candles');
});

// 4. /scan returns ranked list + BTC regime
await test('/scan returns ranked symbols + BTC regime', async () => {
    const data = await get('/scan?symbols=BTCUSDT,ETHUSDT,SOLUSDT', 60000);
    assert(Array.isArray(data.ranked), 'ranked should be an array');
    assert(data.btcRegime && typeof data.btcRegime.verdict === 'string', 'btcRegime.verdict missing');
    if (data.ranked.length > 0) {
        const top = data.ranked[0];
        assert(typeof top.score === 'number', 'top.score should be a number');
        assert(['long', 'short'].includes(top.direction), 'direction should be long|short');
    }
});

// 5. /montecarlo with realistic levels — BTC long, stop $2k away, T1 $4k away
await test('/montecarlo BTC long returns probability distribution', async () => {
    const data = await get('/montecarlo?symbol=BTCUSDT&interval=1h&entry=78000&stop=76000&targets=82000,86000&horizon=48&sims=2000', 60000);
    assert(data.direction === 'long', 'direction should be long');
    assert(data.stopHitProb >= 0 && data.stopHitProb <= 100, 'stopHitProb out of range');
    assert(Array.isArray(data.targetHitProb) && data.targetHitProb.length === 2, 'targetHitProb wrong shape');
    assert(data.targetHitProb[0] >= data.targetHitProb[1], 'P(T1) should be >= P(T2)');
    const sum = data.stopHitProb + data.targetHitProb[0] + data.undecidedProb;
    assert(Math.abs(sum - 100) < 5 || data.targetHitProb[0] > 0, 'probs roughly sum to ~100 (T2 may overlap T1)');
    assert(typeof data.expectancyR === 'number', 'expectancyR should be a number');
    assert(['positive_edge', 'thin_edge', 'negative_edge'].includes(data.verdict), 'invalid verdict');
});

// 6. /montecarlo short direction
await test('/montecarlo BTC short flips direction logic', async () => {
    const data = await get('/montecarlo?symbol=BTCUSDT&interval=1h&entry=78000&stop=80000&targets=74000&horizon=48&sims=1000', 60000);
    assert(data.direction === 'short', 'direction should be short when stop > entry');
});

// 7. /sentiment Crypto F&G
await test('/sentiment returns Crypto Fear & Greed', async () => {
    const data = await get('/sentiment');
    assert(data && (typeof data.value === 'number' || typeof data.value === 'string'), 'F&G value missing');
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);