// Minimal local proxy for the AI Analyst tab.
// Keeps your Anthropic API key off the browser.
//
// Setup:
//   1. Install Node.js 18+ (has global fetch).
//   2. Set your key in this terminal session:
//        PowerShell:  $env:ANTHROPIC_API_KEY="sk-ant-..."
//        bash/zsh:    export ANTHROPIC_API_KEY="sk-ant-..."
//   3. Run:  node proxy-server.js
//   4. In the app, enable "Use local proxy" and keep URL = http://localhost:8787/analyze
//
// Notes:
// - Only listens on localhost. Do NOT expose to the internet without auth.
// - Accepts CORS from any local origin (file:// shows as "null"); tighten if needed.

import http from 'http';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const PORT = process.env.PORT || 8787;
const API_KEY = process.env.ANTHROPIC_API_KEY;
const ANTHROPIC_URL = 'https://api.anthropic.com/v1/messages';
const MAX_BODY_BYTES = 25 * 1024 * 1024; // 25 MB cap for image payloads

if (!API_KEY || API_KEY.includes('your-key')) {
    console.error('ERROR: ANTHROPIC_API_KEY environment variable is not set or contains a placeholder.');
    process.exit(1);
}

// ----- Rotating log file (max 1MB, keep one .old) so failures persist past terminal scrollback -----
const LOG_PATH = path.join(__dirname, 'proxy.log');
const LOG_MAX = 1 * 1024 * 1024;
function logLine(level, args) {
    const line = `[${new Date().toISOString()}] ${level} ${args.map(a => (a && a.stack) ? a.stack : (typeof a === 'object' ? JSON.stringify(a) : String(a))).join(' ')}\n`;
    try {
        if (fs.existsSync(LOG_PATH) && fs.statSync(LOG_PATH).size > LOG_MAX) {
            try { fs.renameSync(LOG_PATH, LOG_PATH + '.old'); } catch (_) {}
        }
        fs.appendFileSync(LOG_PATH, line);
    } catch (_) { /* don't let logging take the proxy down */ }
}
const _origLog = console.log.bind(console);
const _origErr = console.error.bind(console);
console.log = (...a) => { logLine('INFO ', a); _origLog(...a); };
console.error = (...a) => { logLine('ERROR', a); _origErr(...a); };

process.on('unhandledRejection', (reason) => { console.error('unhandledRejection:', reason); });
process.on('uncaughtException',  (err)    => { console.error('uncaughtException:',  err); });

const SYSTEM_PROMPT = [
    'You are a disciplined institutional-style technical analyst. You read CHART IMAGES + a LIVE MARKET CONTEXT block (multi-timeframe numerical snapshots, derivatives data, economic calendar, news, sentiment, and your own recent track record).',
    '',
    'NON-NEGOTIABLE RULES:',
    '1. HTF dictates bias. If 1D and 4H trends disagree, declare "no trade" unless price is at a clean HTF reversal level with confirmation.',
    '2. Setups must have at least 3 confluences (e.g. HTF level + LTF structure shift + indicator + volume). List them explicitly.',
    '3. Skip the trade and produce zero setups if ANY of these is true:',
    '   - LIVE CONTEXT shows NEWS BLACKOUT (high-impact event within 30 min)',
    '   - Crypto and |funding rate| > 0.05% AND price is extended (RSI > 70 long-side or < 30 short-side)',
    '   - HTF and LTF trends conflict and no clear reversal pattern is visible',
    '   - You cannot read the chart clearly',
    '   In each skip case, set "setups": [] and explain in "summary" exactly which rule triggered.',
    '4. Stop must be placed at a structural level (beyond a swing, not arbitrary), not a fixed % away.',
    '5. Risk-reward to first target must be >= 1.5. If not, no setup.',
    '6. Calibrate confidence honestly. If your recent track record (in LIVE CONTEXT) shows poor performance, lower confidence and tighten criteria. Never claim "high" confidence with fewer than 4 confluences.',
    '7. Use the numerical MTF snapshot (EMA20/EMA50, RSI14, ATR14, swing highs/lows) to anchor levels. Never invent prices not supported by the chart or the snapshot.',
    '8. Use ATR14 of the entry timeframe to sanity-check stop distance. Stop should be roughly 1-2 ATR for swing, 0.5-1 ATR for scalp.',
    '9. Output STRICT JSON only. No prose outside JSON.',
    '',
    'You are honest about limits. Markets are probabilistic. You produce a falsifiable plan, not a prediction.'
].join('\n');

function buildUserContent(payload) {
    const userText = [
        `Instrument: ${payload.instrument}`,
        `Primary timeframe (user-stated): ${payload.timeframe}`,
        `Trading style: ${payload.style}`,
        payload.context ? `\n=== LIVE CONTEXT ===\n${payload.context}\n=== END LIVE CONTEXT ===\n` : 'Additional context: none',
        '',
        'You will receive one or more chart screenshots. Each image is preceded by a label naming its timeframe. Treat them as a TOP-DOWN stack: HTF for bias, LTF for entry. The LIVE CONTEXT above contains numerical multi-timeframe data, derivatives, news, calendar, and your own track record — USE IT.',
        '',
        'Return JSON with this exact schema:',
        '{',
        '  "summary": string,  // 2-4 sentences, must reference HTF bias and any context that influenced the read',
        '  "regime": "trending_up|trending_down|range|volatile_chop|breakout",',
        '  "htf_bias": "long|short|neutral",',
        '  "context_used": string[],  // e.g. ["1D RSI 70 (overbought)", "funding +0.08% extreme"]',
        '  "market_structure": { "trend": "up|down|range", "phase": string, "notes": string },',
        '  "key_levels": { "supports": number[], "resistances": number[] },',
        '  "patterns": [ { "name": string, "bias": "bullish|bearish|neutral", "evidence": string } ],',
        '  "indicators_inferred": [ { "name": string, "reading": string } ],',
        '  "setups": [ {',
        '      "direction": "long|short",',
        '      "entry": number, "stop": number, "targets": number[],',
        '      "risk_reward": number, "confidence": "low|medium|high",',
        '      "confluences": string[],  // MUST list >=3 if confidence>=medium',
        '      "thesis": string,',
        '      "invalidation": string,  // plain English: "if price closes above X on 4H, plan is wrong"',
        '      "timeframe": string,',
        '      "atr_stop_multiple": number  // stop distance / ATR14 of entry TF',
        '  } ],',
        '  "skip_reason": string,  // populated when setups is empty; cites which rule triggered',
        '  "risks": string[],',
        '  "confidence_overall": "low|medium|high",',
        '  "disclaimer": string',
        '}',
        '',
        'Quality > quantity. Empty setups[] is a valid, often correct answer.'
    ].join('\n');

    const content = [{ type: 'text', text: userText }];
    for (const img of payload.images || []) {
        const dataUrl = img.dataUrl || '';
        const base64 = dataUrl.includes(',') ? dataUrl.split(',')[1] : dataUrl;
        content.push({ type: 'text', text: `Chart timeframe: ${img.timeframe || payload.timeframe}` });
        content.push({
            type: 'image',
            source: { type: 'base64', media_type: img.type || 'image/png', data: base64 }
        });
    }
    return content;
}

function parseJsonLoose(text) {
    try { return JSON.parse(text); } catch (_) { /* fall through */ }
    const match = text.match(/\{[\s\S]*\}/);
    if (match) {
        try { return JSON.parse(match[0]); } catch (_) { /* fall through */ }
    }
    return { summary: text, raw: true };
}

// ---- Security helpers ----
// Allowed origins: localhost (any port), file:// (which sends Origin: null), and current deployed domain
const ORIGIN_ALLOW = /^(https?:\/\/(localhost|127\.0\.0\.1|render\.com|([a-z0-9-]+\.)?onrender\.com)(:\d+)?|null)$/i;
function setCors(res, req) {
    const origin = (req && req.headers.origin) || '';
    // Echo back the request's origin only if it's on the allow-list.
    // Browsers reject '*' when credentials are sent; echoing is also safer.
    const allow = ORIGIN_ALLOW.test(origin) ? origin : 'http://localhost';
    res.setHeader('Access-Control-Allow-Origin', allow);
    res.setHeader('Vary', 'Origin');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'content-type');
}
function originAllowed(req) {
    const o = (req && req.headers.origin) || '';
    if (!o) return true; // same-origin or non-browser caller
    return ORIGIN_ALLOW.test(o);
}

// Symbol whitelist: 2-15 uppercase alphanumerics. Blocks SSRF + URL injection.
const SYMBOL_RX = /^[A-Z0-9]{2,15}$/;
function safeSymbol(raw, fallback) {
    const s = String(raw || fallback || 'BTCUSDT').toUpperCase().trim();
    if (!SYMBOL_RX.test(s)) {
        const e = new Error('invalid symbol: ' + s);
        e.statusCode = 400;
        throw e;
    }
    return s;
}
function safeInterval(raw, fallback) {
    const s = String(raw || fallback || '1h').toLowerCase().trim();
    if (!/^(1m|3m|5m|15m|30m|1h|2h|4h|6h|8h|12h|1d|3d|1w|1mo)$/.test(s)) {
        const e = new Error('invalid interval: ' + s);
        e.statusCode = 400;
        throw e;
    }
    return s;
}

// Simple per-endpoint token-bucket rate limit (process-local, in-memory).
const _buckets = new Map();
function rateLimit(key, maxPerWindow, windowMs) {
    const now = Date.now();
    const b = _buckets.get(key) || { count: 0, resetAt: now + windowMs };
    if (now >= b.resetAt) { b.count = 0; b.resetAt = now + windowMs; }
    b.count++;
    _buckets.set(key, b);
    return b.count <= maxPerWindow;
}
function enforceRate(req, res, key, maxPerWindow = 30, windowMs = 10000) {
    if (!rateLimit(key, maxPerWindow, windowMs)) {
        res.writeHead(429, { 'content-type': 'application/json', 'retry-after': Math.ceil(windowMs / 1000) });
        res.end(JSON.stringify({ error: 'rate_limited', endpoint: key }));
        return false;
    }
    return true;
}

function readBody(req) {
    return new Promise((resolve, reject) => {
        let total = 0;
        const chunks = [];
        req.on('data', chunk => {
            total += chunk.length;
            if (total > MAX_BODY_BYTES) {
                reject(new Error('Request body too large.'));
                req.destroy();
                return;
            }
            chunks.push(chunk);
        });
        req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
        req.on('error', reject);
    });
}

const server = http.createServer(async (req, res) => {
    setCors(res, req);

    if (req.method === 'OPTIONS') {
        res.writeHead(204);
        res.end();
        return;
    }

    // Serve the main HTML file for root or any unmatched routes
    if ((req.method === 'GET' && req.url === '/') || req.url.endsWith('.html')) {
        try {
            const htmlPath = path.join(__dirname, 'trading-analysis-guide.html');
            const html = fs.readFileSync(htmlPath, 'utf8');
            res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
            res.end(html);
            return;
        } catch (err) {
            res.writeHead(404, { 'content-type': 'application/json' });
            res.end(JSON.stringify({ error: 'HTML file not found' }));
            return;
        }
    }

    if (!originAllowed(req)) {
        res.writeHead(403, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: 'origin not allowed', origin: req.headers.origin }));
        return;
    }

    if (req.method !== 'POST' || req.url !== '/analyze') {
        if (req.method === 'GET' && (req.url === '/health' || req.url.startsWith('/health?'))) {
            return handleHealth(req, res);
        }
        if (req.method === 'POST' && req.url === '/council') {
            return handleCouncil(req, res);
        }
        if (req.method === 'GET' && req.url.startsWith('/news')) {
            return handleNews(req, res);
        }
        if (req.method === 'GET' && req.url === '/sentiment') {
            return handleSentiment(req, res);
        }
        if (req.method === 'GET' && req.url.startsWith('/klines')) {
            return handleKlines(req, res);
        }
        if (req.method === 'GET' && req.url.startsWith('/derivs')) {
            return handleDerivs(req, res);
        }
        if (req.method === 'GET' && req.url === '/calendar') {
            return handleCalendar(req, res);
        }
        if (req.method === 'GET' && req.url.startsWith('/mtf')) {
            return handleMTF(req, res);
        }
        if (req.method === 'GET' && req.url.startsWith('/scan')) {
            return handleScan(req, res);
        }
        if (req.method === 'GET' && req.url.startsWith('/montecarlo')) {
            return handleMonteCarlo(req, res);
        }
        if (req.method === 'POST' && req.url === '/coach') {
            return handleCoach(req, res);
        }
        if (req.method === 'POST' && req.url === '/text') {
            return handleText(req, res);
        }
        res.writeHead(404, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: 'Not found.' }));
        return;
    }

    try {
        const raw = await readBody(req);
        const { model, payload } = JSON.parse(raw || '{}');
        if (!payload || !Array.isArray(payload.images) || payload.images.length === 0) {
            res.writeHead(400, { 'content-type': 'application/json' });
            res.end(JSON.stringify({ error: 'Missing images.' }));
            return;
        }

        const upstream = await fetch(ANTHROPIC_URL, {
            method: 'POST',
            headers: {
                'x-api-key': API_KEY,
                'content-type': 'application/json',
                'anthropic-version': '2023-06-01'
            },
            body: JSON.stringify({
                model: model || 'claude-opus-4-5',
                max_tokens: 2000,
                system: SYSTEM_PROMPT,
                messages: [{ role: 'user', content: buildUserContent(payload) }]
            })
        });

        if (!upstream.ok) {
            const errText = await upstream.text();
            res.writeHead(upstream.status, { 'content-type': 'application/json' });
            res.end(JSON.stringify({ error: `Anthropic ${upstream.status}: ${errText}` }));
            return;
        }

        const data = await upstream.json();
        const textBlock = (data.content || []).find(b => b.type === 'text');
        if (!textBlock) {
            res.writeHead(502, { 'content-type': 'application/json' });
            res.end(JSON.stringify({ error: 'No text content from model.' }));
            return;
        }

        const result = parseJsonLoose(textBlock.text);
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ result }));
    } catch (err) {
        res.writeHead(500, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: err.message || String(err) }));
    }
});

// ----- AI helpers (shared) -----
// Wrap fetch with timeout + 2 retries on transient network failures (DNS / TLS hiccups
// often surface as the unhelpful "fetch failed" from undici).
async function anthropicFetch(body, attempt) {
    attempt = attempt || 0;
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 90000);
    try {
        return await fetch(ANTHROPIC_URL, {
            method: 'POST',
            headers: { 'x-api-key': API_KEY, 'content-type': 'application/json', 'anthropic-version': '2023-06-01' },
            body,
            signal: ctrl.signal
        });
    } catch (err) {
        const msg = String(err && (err.cause && err.cause.code) || err.message || err);
        const transient = /fetch failed|ECONNRESET|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|UND_ERR|aborted/i.test(msg);
        if (transient && attempt < 2) {
            await new Promise(r => setTimeout(r, 600 * (attempt + 1)));
            return anthropicFetch(body, attempt + 1);
        }
        const cause = (err && err.cause) ? ` (cause: ${err.cause.code || err.cause.message || err.cause})` : '';
        const e = new Error(`Network error reaching api.anthropic.com: ${err.message || err}${cause}. Check internet/DNS/firewall and that your ANTHROPIC_API_KEY is valid.`);
        e.cause = err;
        throw e;
    } finally {
        clearTimeout(t);
    }
}

async function callAnthropic(model, system, content, maxTokens) {
    const upstream = await anthropicFetch(JSON.stringify({ model, max_tokens: maxTokens || 1500, system, messages: [{ role: 'user', content }] }));
    if (!upstream.ok) throw new Error(`Anthropic ${upstream.status}: ${await upstream.text()}`);
    const data = await upstream.json();
    const textBlock = (data.content || []).find(b => b.type === 'text');
    return textBlock ? textBlock.text : '';
}

async function callAnthropicMessages(model, system, messages, maxTokens) {
    const upstream = await anthropicFetch(JSON.stringify({ model, max_tokens: maxTokens || 1200, system, messages }));
    if (!upstream.ok) throw new Error(`Anthropic ${upstream.status}: ${await upstream.text()}`);
    const data = await upstream.json();
    const textBlock = (data.content || []).find(b => b.type === 'text');
    return textBlock ? textBlock.text : '';
}

// ----- AI Coach: personalised trading guide -----
const COACH_SYSTEM = [
    'You are an experienced, friendly trading coach helping a beginner set up and execute their trading workflow.',
    'You will be given the user PROFILE (platform, starting capital, risk tolerance, experience, goals, available time, preferred markets) at the start of every conversation.',
    'Your job:',
    '  1. On the first message ("__INIT__"), produce a personalised, step-by-step plan tailored to their PLATFORM and CAPITAL. Cover: account setup, what to enable/disable on their platform, position sizing math (using their actual numbers), a beginner-safe risk rule, which 2-3 markets to focus on, a daily/weekly routine, and the first 3 things they should practise on this app (Analyze a chart → log it → review).',
    '  2. On follow-ups, answer plainly and concretely. If a number is involved, do the math with the user\'s actual capital.',
    '  3. Always mention concrete buttons/sections of THIS app when relevant: "🎯 Analyze tab", "📓 Journal tab", "Position Size & Risk Calculator", "Live Chart", "Pattern Library", "Risk per trade %".',
    '  4. Tone: warm, plain English, no jargon without a quick parenthetical definition. No hype. Be honest about risk and the high failure rate of new traders.',
    '  5. Never recommend specific trades or claim to predict the market. You teach process, not picks.',
    '  6. Format with short paragraphs, bold key terms with **, and use numbered lists for steps. NO code blocks. NO JSON. Plain markdown only.',
    '  7. Keep first-message plan under ~450 words. Keep follow-ups under ~200 words unless asked to elaborate.'
].join('\n');

function profileToText(p) {
    if (!p || typeof p !== 'object') return '(no profile)';
    return [
        `Platform: ${p.platform || '?'}`,
        `Starting capital: ${p.capital ? '$' + p.capital : '?'} ${p.currency || 'USD'}`,
        `Risk tolerance: ${p.risk || '?'}`,
        `Experience: ${p.experience || '?'}`,
        `Goal: ${p.goal || '?'}`,
        `Hours per week available: ${p.hours || '?'}`,
        `Preferred markets: ${p.markets || '?'}`,
        `Timezone / sessions: ${p.timezone || '?'}`
    ].join('\n');
}

// ----- Generic text-only Anthropic passthrough (used by Step 1 AI Symbol Picker etc.) -----
// Accepts { model, system?, prompt, maxTokens? } and returns { text }.
// Rate-limited so a stuck UI can't burn budget. No images, plain text in/out.
async function handleText(req, res) {
    if (!enforceRate(req, res, 'text', 12, 10000)) return;
    try {
        const raw = await readBody(req);
        const { model, system, prompt, maxTokens } = JSON.parse(raw || '{}');
        if (!prompt || typeof prompt !== 'string') {
            res.writeHead(400, { 'content-type': 'application/json' });
            res.end(JSON.stringify({ error: 'Missing prompt (string) in body.' }));
            return;
        }
        const m = model || 'claude-opus-4-5';
        const cap = Math.max(64, Math.min(4000, parseInt(maxTokens) || 1500));
        const text = await callAnthropic(m, system || 'You are a helpful assistant. Respond strictly as the user asks.', prompt, cap);
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ text, model: m, ts: Date.now() }));
    } catch (err) {
        res.writeHead(500, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: err.message || String(err) }));
    }
}

async function handleCoach(req, res) {
    try {
        const raw = await readBody(req);
        const { model, profile, history, message } = JSON.parse(raw || '{}');
        if (!profile) {
            res.writeHead(400, { 'content-type': 'application/json' });
            res.end(JSON.stringify({ error: 'Missing profile.' }));
            return;
        }
        const m = model || 'claude-opus-4-5';
        const profileBlock = `USER PROFILE:\n${profileToText(profile)}\n\n---\n`;
        const userMsg = String(message || '__INIT__');

        // Build messages: inject profile into the first user turn so the model
        // always has context, even when client trims old turns.
        const priorTurns = Array.isArray(history) ? history.slice(-12) : [];
        const messages = [];
        if (priorTurns.length === 0) {
            messages.push({ role: 'user', content: profileBlock + (userMsg === '__INIT__'
                ? 'This is our first session. Please produce my personalised setup plan now.'
                : userMsg) });
        } else {
            // First turn carries profile; subsequent turns are the conversation.
            messages.push({ role: 'user', content: profileBlock + (priorTurns[0].content || '') });
            for (let i = 1; i < priorTurns.length; i++) {
                const t = priorTurns[i];
                if (t && t.role && t.content) messages.push({ role: t.role, content: String(t.content) });
            }
            messages.push({ role: 'user', content: userMsg });
        }

        const text = await callAnthropicMessages(m, COACH_SYSTEM, messages, 1400);
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ text, model: m, ts: Date.now() }));
    } catch (err) {
        res.writeHead(500, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: err.message || String(err) }));
    }
}

// ----- AI Council: bull vs bear vs judge -----

const BULL_SYSTEM = 'You are a BULL-side institutional analyst. Your job is to argue the strongest possible LONG case for this chart, citing structure, levels, momentum, and live context. You must still be intellectually honest — if there is genuinely no long case, say so. Output STRICT JSON: { "case_strength": "weak|moderate|strong|none", "thesis": string, "key_evidence": string[], "best_long_setup": { "entry": number, "stop": number, "target": number, "rr": number, "confluences": string[] } | null, "risks_to_long": string[] }';

const BEAR_SYSTEM = 'You are a BEAR-side institutional analyst. Your job is to argue the strongest possible SHORT case for this chart, citing structure, levels, momentum, and live context. You must still be intellectually honest — if there is genuinely no short case, say so. Output STRICT JSON: { "case_strength": "weak|moderate|strong|none", "thesis": string, "key_evidence": string[], "best_short_setup": { "entry": number, "stop": number, "target": number, "rr": number, "confluences": string[] } | null, "risks_to_short": string[] }';

const JUDGE_SYSTEM = [
    'You are an impartial JUDGE evaluating two opposing trading cases (bull and bear) for the same chart.',
    'You receive: the original chart context, the BULL case JSON, and the BEAR case JSON.',
    'Your job: weigh the evidence honestly and decide. Bias toward NO-TRADE when the cases are evenly matched (asymmetry is what makes a good trade).',
    'Output STRICT JSON:',
    '{',
    '  "verdict": "long|short|no_trade",',
    '  "edge_strength": "none|weak|moderate|strong",',
    '  "winning_side_score": 0-100,  // confidence the winning side is right; <55 should be no_trade',
    '  "rationale": string,  // 2-4 sentences citing which evidence tipped it',
    '  "agreed_facts": string[],  // things both sides implicitly agree on (e.g. key levels)',
    '  "disputed_points": string[],',
    '  "final_setup": { "direction": "long|short", "entry": number, "stop": number, "targets": number[], "confluences": string[], "invalidation": string } | null,',
    '  "what_would_change_my_mind": string',
    '}'
].join('\n');

async function handleCouncil(req, res) {
    try {
        const raw = await readBody(req);
        const { model, payload } = JSON.parse(raw || '{}');
        if (!payload || !Array.isArray(payload.images) || payload.images.length === 0) {
            res.writeHead(400, { 'content-type': 'application/json' });
            res.end(JSON.stringify({ error: 'Missing images.' }));
            return;
        }
        const m = model || 'claude-opus-4-5';
        const userContent = buildUserContent(payload);

        const [bullText, bearText] = await Promise.all([
            callAnthropic(m, BULL_SYSTEM, userContent, 1200),
            callAnthropic(m, BEAR_SYSTEM, userContent, 1200)
        ]);
        const bull = parseJsonLoose(bullText);
        const bear = parseJsonLoose(bearText);

        const judgeContent = [{
            type: 'text',
            text: `Original chart context:\n${payload.context || '(none)'}\n\nInstrument: ${payload.instrument} | TF: ${payload.timeframe} | Style: ${payload.style}\n\nBULL case JSON:\n${JSON.stringify(bull, null, 2)}\n\nBEAR case JSON:\n${JSON.stringify(bear, null, 2)}\n\nNow render verdict.`
        }];
        // Include images in judge call too so it can verify claims
        for (const img of payload.images || []) {
            const dataUrl = img.dataUrl || '';
            const base64 = dataUrl.includes(',') ? dataUrl.split(',')[1] : dataUrl;
            judgeContent.push({ type: 'image', source: { type: 'base64', media_type: img.type || 'image/png', data: base64 } });
        }
        const judgeText = await callAnthropic(m, JUDGE_SYSTEM, judgeContent, 1200);
        const judge = parseJsonLoose(judgeText);

        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ bull, bear, judge, model: m, ts: Date.now() }));
    } catch (err) {
        const msg = err && (err.message || String(err));
        console.error('Council error:', msg, err && err.cause ? err.cause : '');
        res.writeHead(500, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: msg }));
    }
}

// ----- Health probe: lightweight checks of Anthropic + Binance + key presence -----
let _healthCache = { ts: 0, body: null };
async function probe(url, opts, timeoutMs) {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), timeoutMs || 4000);
    const t0 = Date.now();
    try {
        const r = await fetch(url, { ...(opts || {}), signal: ctrl.signal });
        return { ok: r.status < 500, status: r.status, ms: Date.now() - t0 };
    } catch (err) {
        return { ok: false, status: 0, ms: Date.now() - t0, error: (err && err.message) || String(err) };
    } finally { clearTimeout(t); }
}
async function handleHealth(req, res) {
    // 10s cache to avoid hammering upstreams when many tabs poll.
    const now = Date.now();
    if (_healthCache.body && (now - _healthCache.ts) < 10000) {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(_healthCache.body);
        return;
    }
    const wantDeep = /deep=1/.test(req.url || '');
    const out = {
        proxy: 'ok',
        ts: now,
        api_key: API_KEY ? 'present' : 'missing',
        anthropic: 'unchecked',
        binance: 'unchecked',
        version: 1
    };
    if (wantDeep) {
        const [ant, bin] = await Promise.all([
            // HEAD on /v1/messages would 405; use a tiny GET to /v1/models with auth (returns 401/200 fast).
            probe('https://api.anthropic.com/v1/models', { headers: { 'x-api-key': API_KEY, 'anthropic-version': '2023-06-01' } }, 4000),
            probe('https://api.binance.com/api/v3/ping', {}, 4000)
        ]);
        out.anthropic = ant.ok ? { status: 'ok', http: ant.status, ms: ant.ms } : { status: 'fail', http: ant.status, ms: ant.ms, error: ant.error };
        out.binance   = bin.ok ? { status: 'ok', http: bin.status, ms: bin.ms } : { status: 'fail', http: bin.status, ms: bin.ms, error: bin.error };
    }
    const body = JSON.stringify(out);
    _healthCache = { ts: now, body };
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(body);
}

server.listen(PORT, '0.0.0.0', () => {
    console.log(`AI Analyst proxy listening on 0.0.0.0:${PORT} (local: http://localhost:${PORT}/analyze)`);
    console.log(`Health:     http://localhost:${PORT}/health  (?deep=1 for upstream probes)`);
    console.log(`Council:    http://localhost:${PORT}/council  (POST, bull/bear/judge)`);
    console.log(`News:       http://localhost:${PORT}/news?cat=crypto|stocks|forex|macro|all`);
    console.log(`Sentiment:  http://localhost:${PORT}/sentiment  (Crypto Fear & Greed Index)`);
});

// ----- News & Sentiment endpoints -----
const NEWS_FEEDS = {
    crypto: [
        { name: 'CoinDesk', url: 'https://www.coindesk.com/arc/outboundfeeds/rss/' },
        { name: 'Cointelegraph', url: 'https://cointelegraph.com/rss' }
    ],
    stocks: [
        { name: 'Yahoo Finance', url: 'https://finance.yahoo.com/news/rssindex' },
        { name: 'MarketWatch', url: 'https://feeds.content.dowjones.io/public/rss/mw_topstories' }
    ],
    forex: [
        { name: 'ForexLive', url: 'https://www.forexlive.com/feed/news' },
        { name: 'DailyFX', url: 'https://www.dailyfx.com/feeds/market-news' }
    ],
    macro: [
        { name: 'BBC Business', url: 'https://feeds.bbci.co.uk/news/business/rss.xml' },
        { name: 'Reuters Business', url: 'https://feeds.reuters.com/reuters/businessNews' }
    ]
};

function stripTags(s) { return String(s).replace(/<!\[CDATA\[|\]\]>/g, '').replace(/<[^>]+>/g, '').replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').trim(); }

function parseRss(xml, sourceName) {
    const items = [];
    const itemRegex = /<item[\s\S]*?<\/item>/g;
    const matches = xml.match(itemRegex) || [];
    for (const block of matches.slice(0, 10)) {
        const title = (block.match(/<title>([\s\S]*?)<\/title>/) || [])[1] || '';
        const link = (block.match(/<link>([\s\S]*?)<\/link>/) || [])[1] || '';
        const pub = (block.match(/<pubDate>([\s\S]*?)<\/pubDate>/) || [])[1] || '';
        const desc = (block.match(/<description>([\s\S]*?)<\/description>/) || [])[1] || '';
        if (title) items.push({ source: sourceName, title: stripTags(title), link: stripTags(link), pubDate: pub, summary: stripTags(desc).slice(0, 240) });
    }
    return items;
}

async function fetchFeed(feed) {
    try {
        const r = await fetch(feed.url, { headers: { 'user-agent': 'Mozilla/5.0 trading-app' }, signal: AbortSignal.timeout(8000) });
        if (!r.ok) return [];
        const xml = await r.text();
        return parseRss(xml, feed.name);
    } catch (_) { return []; }
}

async function handleNews(req, res) {
    const url = new URL(req.url, 'http://x');
    const cat = (url.searchParams.get('cat') || 'all').toLowerCase();
    const cats = cat === 'all' ? Object.keys(NEWS_FEEDS) : [cat].filter(c => NEWS_FEEDS[c]);
    const feeds = cats.flatMap(c => NEWS_FEEDS[c].map(f => ({ ...f, category: c })));
    const results = await Promise.all(feeds.map(async f => {
        const items = await fetchFeed(f);
        return items.map(i => ({ ...i, category: f.category }));
    }));
    const all = results.flat().sort((a, b) => new Date(b.pubDate) - new Date(a.pubDate));
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ items: all.slice(0, 60) }));
}

async function handleSentiment(req, res) {
    try {
        const r = await fetch('https://api.alternative.me/fng/?limit=7', { signal: AbortSignal.timeout(5000) });
        const data = await r.json();
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify(data));
    } catch (err) {
        res.writeHead(502, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: err.message }));
    }
}

// ----- Klines (candles) with multi-exchange fallback -----
const BYBIT_INTERVAL = { '1m': '1', '3m': '3', '5m': '5', '15m': '15', '30m': '30', '1h': '60', '2h': '120', '4h': '240', '6h': '360', '12h': '720', '1d': 'D', '1w': 'W' };
const COINBASE_GRAN = { '1m': 60, '5m': 300, '15m': 900, '1h': 3600, '6h': 21600, '1d': 86400 };
const KRAKEN_INTERVAL = { '1m': 1, '5m': 5, '15m': 15, '30m': 30, '1h': 60, '4h': 240, '1d': 1440, '1w': 10080 };

async function tryFetch(url, opts = {}) {
    const r = await fetch(url, { signal: AbortSignal.timeout(7000), ...opts });
    if (!r.ok) throw new Error(`${r.status}`);
    return r.json();
}

async function fromBinance(symbol, interval, limit) {
    const rows = await tryFetch(`https://api.binance.com/api/v3/klines?symbol=${symbol}&interval=${interval}&limit=${limit}`);
    return rows.map(k => ({ time: Math.floor(k[0] / 1000), open: +k[1], high: +k[2], low: +k[3], close: +k[4], volume: +k[5] }));
}
async function fromBybit(symbol, interval, limit) {
    const iv = BYBIT_INTERVAL[interval]; if (!iv) throw new Error('iv');
    const data = await tryFetch(`https://api.bybit.com/v5/market/kline?category=spot&symbol=${symbol}&interval=${iv}&limit=${Math.min(limit, 1000)}`);
    if (data.retCode !== 0) throw new Error('bybit ' + data.retMsg);
    return data.result.list.slice().reverse().map(k => ({ time: Math.floor(+k[0] / 1000), open: +k[1], high: +k[2], low: +k[3], close: +k[4], volume: +k[5] }));
}
async function fromCoinbase(symbol, interval, limit) {
    const gran = COINBASE_GRAN[interval]; if (!gran) throw new Error('iv');
    const m = symbol.match(/^([A-Z]+)(USDT|USDC|USD|EUR|GBP)$/); if (!m) throw new Error('sym');
    const pair = `${m[1]}-${m[2] === 'USDT' ? 'USD' : m[2]}`;
    const rows = await tryFetch(`https://api.exchange.coinbase.com/products/${pair}/candles?granularity=${gran}`);
    return rows.slice().reverse().slice(-limit).map(k => ({ time: k[0], low: +k[1], high: +k[2], open: +k[3], close: +k[4] }));
}
async function fromKraken(symbol, interval, limit) {
    const iv = KRAKEN_INTERVAL[interval]; if (!iv) throw new Error('iv');
    const m = symbol.match(/^([A-Z]+)(USDT|USDC|USD|EUR|GBP)$/); if (!m) throw new Error('sym');
    const pair = `${m[1] === 'BTC' ? 'XBT' : m[1]}${m[2]}`;
    const data = await tryFetch(`https://api.kraken.com/0/public/OHLC?pair=${pair}&interval=${iv}`);
    if (data.error && data.error.length) throw new Error('kraken ' + data.error[0]);
    const key = Object.keys(data.result).find(k => k !== 'last');
    return data.result[key].slice(-limit).map(k => ({ time: k[0], open: +k[1], high: +k[2], low: +k[3], close: +k[4] }));
}

async function handleKlines(req, res) {
    if (!enforceRate(req, res, 'klines', 60, 10000)) return;
    let symbol, interval, limit;
    try {
        const url = new URL(req.url, 'http://x');
        symbol = safeSymbol(url.searchParams.get('symbol'));
        interval = safeInterval(url.searchParams.get('interval'));
        limit = Math.min(parseInt(url.searchParams.get('limit') || '500', 10) || 500, 1000);
    } catch (e) {
        res.writeHead(e.statusCode || 400, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: e.message }));
        return;
    }
    const sources = [
        ['binance', fromBinance], ['bybit', fromBybit], ['coinbase', fromCoinbase], ['kraken', fromKraken]
    ];
    const errors = [];
    for (const [name, fn] of sources) {
        try {
            const candles = await fn(symbol, interval, limit);
            if (candles && candles.length) {
                res.writeHead(200, { 'content-type': 'application/json' });
                return res.end(JSON.stringify({ source: name, candles }));
            }
        } catch (err) { errors.push(`${name}: ${err.message}`); }
    }
    res.writeHead(502, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: 'All sources failed', details: errors }));
}

// ----- Crypto derivatives (funding rate + open interest) via Bybit -----
async function handleDerivs(req, res) {
    if (!enforceRate(req, res, 'derivs', 30, 10000)) return;
    let symbol;
    try {
        const url = new URL(req.url, 'http://x');
        symbol = safeSymbol(url.searchParams.get('symbol'));
    } catch (e) {
        res.writeHead(e.statusCode || 400, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: e.message }));
        return;
    }
    const out = { symbol };
    try {
        const t = await tryFetch(`https://api.bybit.com/v5/market/tickers?category=linear&symbol=${symbol}`);
        const tk = t.result?.list?.[0];
        if (tk) {
            out.fundingRate = parseFloat(tk.fundingRate);
            out.fundingRatePct = (parseFloat(tk.fundingRate) * 100).toFixed(4) + '%';
            out.nextFundingTime = new Date(parseInt(tk.nextFundingTime)).toISOString();
            out.openInterest = parseFloat(tk.openInterest);
            out.openInterestValue = parseFloat(tk.openInterestValue);
            out.price24hPcnt = (parseFloat(tk.price24hPcnt) * 100).toFixed(2) + '%';
            out.lastPrice = parseFloat(tk.lastPrice);
        }
    } catch (err) { out.tickerError = err.message; }
    try {
        const oi = await tryFetch(`https://api.bybit.com/v5/market/open-interest?category=linear&symbol=${symbol}&intervalTime=1h&limit=24`);
        const list = (oi.result?.list || []).slice().reverse();
        if (list.length >= 2) {
            const first = parseFloat(list[0].openInterest);
            const last = parseFloat(list[list.length - 1].openInterest);
            out.oi24hChangePct = (((last - first) / first) * 100).toFixed(2) + '%';
        }
    } catch (err) { out.oiError = err.message; }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify(out));
}

// ----- Economic calendar (high-impact events) -----
let CAL_CACHE = { ts: 0, data: null };
async function handleCalendar(req, res) {
    const now = Date.now();
    if (CAL_CACHE.data && now - CAL_CACHE.ts < 30 * 60 * 1000) {
        res.writeHead(200, { 'content-type': 'application/json' });
        return res.end(JSON.stringify(CAL_CACHE.data));
    }
    try {
        const r = await fetch('https://nfs.faireconomy.media/ff_calendar_thisweek.json', { signal: AbortSignal.timeout(8000) });
        if (!r.ok) throw new Error('cal ' + r.status);
        const events = await r.json();
        const nowMs = Date.now();
        const upcoming = events
            .filter(e => e.impact === 'High' || e.impact === 'Medium')
            .map(e => ({
                title: e.title,
                country: e.country,
                date: e.date,
                impact: e.impact,
                forecast: e.forecast,
                previous: e.previous,
                actual: e.actual,
                msUntil: new Date(e.date).getTime() - nowMs
            }))
            .filter(e => e.msUntil > -2 * 3600 * 1000) // keep last 2h + future
            .sort((a, b) => a.msUntil - b.msUntil)
            .slice(0, 30);
        const blackout = upcoming.find(e => e.impact === 'High' && e.msUntil > 0 && e.msUntil < 30 * 60 * 1000);
        const out = { events: upcoming, blackoutWarning: blackout || null };
        CAL_CACHE = { ts: now, data: out };
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify(out));
    } catch (err) {
        res.writeHead(502, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: err.message, events: [] }));
    }
}

// ----- Multi-timeframe summary with computed indicators -----
function ema(values, period) {
    const k = 2 / (period + 1);
    let e = values[0];
    for (let i = 1; i < values.length; i++) e = values[i] * k + e * (1 - k);
    return e;
}
function rsi(closes, period = 14) {
    if (closes.length < period + 1) return null;
    let gains = 0, losses = 0;
    for (let i = closes.length - period; i < closes.length; i++) {
        const d = closes[i] - closes[i - 1];
        if (d >= 0) gains += d; else losses -= d;
    }
    const rs = (gains / period) / ((losses / period) || 1e-9);
    return 100 - 100 / (1 + rs);
}
function atr(candles, period = 14) {
    if (candles.length < period + 1) return null;
    let sum = 0;
    for (let i = candles.length - period; i < candles.length; i++) {
        const c = candles[i], p = candles[i - 1];
        const tr = Math.max(c.high - c.low, Math.abs(c.high - p.close), Math.abs(c.low - p.close));
        sum += tr;
    }
    return sum / period;
}
function swingPoints(candles, lookback = 5) {
    const highs = [], lows = [];
    for (let i = lookback; i < candles.length - lookback; i++) {
        let isH = true, isL = true;
        for (let j = 1; j <= lookback; j++) {
            if (candles[i - j].high >= candles[i].high || candles[i + j].high >= candles[i].high) isH = false;
            if (candles[i - j].low <= candles[i].low || candles[i + j].low <= candles[i].low) isL = false;
        }
        if (isH) highs.push({ i, t: candles[i].time, p: candles[i].high });
        if (isL) lows.push({ i, t: candles[i].time, p: candles[i].low });
    }
    return { highs: highs.slice(-5), lows: lows.slice(-5) };
}
function detectLiquidity(candles, swings) {
    // Detect liquidity sweeps: did the last bar take out a recent swing high/low and close back inside?
    if (!candles || candles.length < 5 || !swings) return { sweptHigh: false, sweptLow: false, untestedHighs: [], untestedLows: [] };
    const last = candles[candles.length - 1];
    const prev = candles[candles.length - 2];
    const highs = (swings.highs || []).slice(0, -1); // exclude the most recent forming swing
    const lows = (swings.lows || []).slice(0, -1);
    let sweptHigh = false, sweptLow = false;
    for (const h of highs) {
        if (last.high > h.p && last.close < h.p && prev.high <= h.p) { sweptHigh = true; break; }
    }
    for (const l of lows) {
        if (last.low < l.p && last.close > l.p && prev.low >= l.p) { sweptLow = true; break; }
    }
    // Untested levels = swings not breached after their formation
    const untestedHighs = highs.filter(h => !candles.slice(h.i + 1).some(c => c.high > h.p)).slice(-3).map(h => h.p);
    const untestedLows = lows.filter(l => !candles.slice(l.i + 1).some(c => c.low < l.p)).slice(-3).map(l => l.p);
    return { sweptHigh, sweptLow, untestedHighs, untestedLows };
}

function volumeContext(candles) {
    const vols = candles.map(c => c.volume).filter(v => Number.isFinite(v) && v > 0);
    if (vols.length < 20) return null;
    const last = vols[vols.length - 1];
    const avg20 = vols.slice(-20).reduce((a, b) => a + b, 0) / 20;
    const ratio = avg20 > 0 ? last / avg20 : 1;
    let label = 'normal';
    if (ratio > 2) label = 'climactic';
    else if (ratio > 1.4) label = 'elevated';
    else if (ratio < 0.6) label = 'thin';
    return { lastVol: +last.toFixed(2), avg20: +avg20.toFixed(2), ratio: +ratio.toFixed(2), label };
}

function summarize(candles) {
    if (!candles || candles.length < 20) return null;
    const closes = candles.map(c => c.close);
    const last = candles[candles.length - 1];
    const first = candles[0];
    const hi = Math.max(...candles.map(c => c.high));
    const lo = Math.min(...candles.map(c => c.low));
    const ema20v = ema(closes.slice(-Math.min(closes.length, 60)), 20);
    const ema50v = closes.length >= 50 ? ema(closes.slice(-Math.min(closes.length, 120)), 50) : null;
    const trend = ema50v ? (ema20v > ema50v ? 'up' : 'down') : (last.close > first.close ? 'up' : 'down');
    const swings = swingPoints(candles);
    return {
        last: last.close,
        rangePct: (((hi - lo) / lo) * 100).toFixed(2) + '%',
        high: hi,
        low: lo,
        ema20: +ema20v.toFixed(4),
        ema50: ema50v ? +ema50v.toFixed(4) : null,
        rsi14: rsi(closes) ? +rsi(closes).toFixed(1) : null,
        atr14: atr(candles) ? +atr(candles).toFixed(4) : null,
        trend,
        priceVsEma20Pct: (((last.close - ema20v) / ema20v) * 100).toFixed(2) + '%',
        swings,
        liquidity: detectLiquidity(candles, swings),
        volume: volumeContext(candles)
    };
}

async function fetchCandles(symbol, interval, limit) {
    const sources = [fromBinance, fromBybit, fromCoinbase, fromKraken];
    for (const fn of sources) {
        try { const c = await fn(symbol, interval, limit); if (c && c.length) return c; }
        catch (_) { /* next */ }
    }
    return null;
}

async function handleMTF(req, res) {
    if (!enforceRate(req, res, 'mtf', 30, 10000)) return;
    let symbol, tfs;
    try {
        const url = new URL(req.url, 'http://x');
        symbol = safeSymbol(url.searchParams.get('symbol'));
        tfs = (url.searchParams.get('tfs') || '1d,4h,1h,15m').split(',').map(t => safeInterval(t));
    } catch (e) {
        res.writeHead(e.statusCode || 400, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: e.message }));
        return;
    }
    const out = { symbol, timeframes: {} };
    await Promise.all(tfs.map(async tf => {
        const candles = await fetchCandles(symbol, tf, 200);
        out.timeframes[tf] = candles ? summarize(candles) : { error: 'unavailable' };
    }));
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify(out));
}

// ----- Watchlist scanner: rules-based scoring (no AI cost) -----
const DEFAULT_WATCHLIST = ['BTCUSDT', 'ETHUSDT', 'SOLUSDT', 'BNBUSDT', 'XRPUSDT', 'AVAXUSDT', 'LINKUSDT', 'ARBUSDT'];

function scoreSymbol(mtf, btcRegime) {
    const d = mtf.timeframes['1d'], h4 = mtf.timeframes['4h'], h1 = mtf.timeframes['1h'], m15 = mtf.timeframes['15m'];
    if (!d || d.error || !h4 || h4.error || !h1 || h1.error) return null;
    const reasons = [];
    let score = 0;
    let direction = null;

    // 1. HTF alignment (must)
    if (d.trend === h4.trend) {
        score += 25;
        direction = d.trend === 'up' ? 'long' : 'short';
        reasons.push(`HTF aligned (${d.trend})`);
    } else {
        return { score: 0, direction: null, reasons: ['HTF conflict (1D vs 4H) — skip'], skip: true };
    }

    // 2. BTC regime gate (only for alts)
    if (btcRegime) {
        if (btcRegime.unstable) {
            score -= 20;
            reasons.push(`BTC unstable (${btcRegime.atrPct1h}% ATR) — high alt risk`);
        }
        if (direction === 'long' && btcRegime.trend1h === 'down') {
            score -= 15;
            reasons.push('Long alt vs BTC 1H downtrend');
        } else if (direction === 'short' && btcRegime.trend1h === 'up') {
            score -= 15;
            reasons.push('Short alt vs BTC 1H uptrend');
        } else if (btcRegime.trend1h === btcRegime.trend4h && ((direction === 'long' && btcRegime.trend1h === 'up') || (direction === 'short' && btcRegime.trend1h === 'down'))) {
            score += 10;
            reasons.push('BTC tailwind aligned');
        }
    }

    // 3. Pullback to EMA20 on 1H
    const distToEma20 = Math.abs(parseFloat(h1.priceVsEma20Pct));
    if (distToEma20 < 1.0) { score += 20; reasons.push(`1H near EMA20 (${h1.priceVsEma20Pct})`); }
    else if (distToEma20 > 4) { score -= 10; reasons.push(`1H extended from EMA20 (${h1.priceVsEma20Pct})`); }

    // 4. RSI not extreme on 4H
    if (h4.rsi14 !== null) {
        if (direction === 'long' && h4.rsi14 > 75) { score -= 15; reasons.push(`4H RSI overbought (${h4.rsi14})`); }
        else if (direction === 'short' && h4.rsi14 < 25) { score -= 15; reasons.push(`4H RSI oversold (${h4.rsi14})`); }
        else if (h4.rsi14 >= 45 && h4.rsi14 <= 65) { score += 10; reasons.push(`4H RSI healthy (${h4.rsi14})`); }
    }

    // 5. LTF momentum confirms
    if (m15 && !m15.error && m15.trend === d.trend) { score += 10; reasons.push('15m momentum aligned'); }

    // 6. ATR sanity
    if (h1.atr14 && h1.last) {
        const atrPct = (h1.atr14 / h1.last) * 100;
        if (atrPct > 0.3) { score += 5; reasons.push(`1H ATR ${atrPct.toFixed(2)}%`); }
        else { score -= 5; reasons.push(`1H low volatility (ATR ${atrPct.toFixed(2)}%)`); }
    }

    // 7. Swing structure
    const sw = h4.swings || { highs: [], lows: [] };
    if (direction === 'long' && sw.lows.length >= 2 && sw.lows[sw.lows.length - 1].p > sw.lows[0].p) {
        score += 10; reasons.push('4H higher lows');
    }
    if (direction === 'short' && sw.highs.length >= 2 && sw.highs[sw.highs.length - 1].p < sw.highs[0].p) {
        score += 10; reasons.push('4H lower highs');
    }

    // 8. Liquidity sweep on 1H (reversal/continuation signal)
    const liq1h = h1.liquidity || {};
    if (direction === 'long' && liq1h.sweptLow) { score += 15; reasons.push('1H swept liquidity below (long bias)'); }
    if (direction === 'short' && liq1h.sweptHigh) { score += 15; reasons.push('1H swept liquidity above (short bias)'); }
    if (direction === 'long' && liq1h.sweptHigh) { score -= 10; reasons.push('1H swept liquidity above (against long)'); }
    if (direction === 'short' && liq1h.sweptLow) { score -= 10; reasons.push('1H swept liquidity below (against short)'); }

    // 9. Volume confirmation on 1H
    const vol1h = h1.volume;
    if (vol1h) {
        if (vol1h.label === 'climactic') { score += 8; reasons.push(`1H climactic volume (${vol1h.ratio}x avg)`); }
        else if (vol1h.label === 'elevated') { score += 5; reasons.push(`1H elevated volume (${vol1h.ratio}x avg)`); }
        else if (vol1h.label === 'thin') { score -= 8; reasons.push(`1H thin volume (${vol1h.ratio}x avg)`); }
    }

    // Suggested entry/stop
    const entry = h1.ema20;
    const stop = direction === 'long'
        ? Math.min(...((h1.swings && h1.swings.lows) || []).map(s => s.p), h1.low)
        : Math.max(...((h1.swings && h1.swings.highs) || []).map(s => s.p), h1.high);
    const risk = Math.abs(entry - stop);
    const target1 = direction === 'long' ? entry + risk * 2 : entry - risk * 2;

    return {
        score,
        direction,
        reasons,
        suggestion: { entry: +entry.toFixed(4), stop: +stop.toFixed(4), target1: +target1.toFixed(4), rr: 2 },
        last: h1.last,
        liquidity: liq1h,
        volume: vol1h
    };
}

async function handleScan(req, res) {
    if (!enforceRate(req, res, 'scan', 6, 10000)) return;
    let symbols;
    try {
        const url = new URL(req.url, 'http://x');
        const raw = (url.searchParams.get('symbols') || DEFAULT_WATCHLIST.join(',')).split(',').map(s => s.trim()).filter(Boolean);
        if (raw.length > 30) {
            res.writeHead(400, { 'content-type': 'application/json' });
            res.end(JSON.stringify({ error: 'too many symbols (max 30)' }));
            return;
        }
        symbols = raw.map(s => safeSymbol(s));
    } catch (e) {
        res.writeHead(e.statusCode || 400, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: e.message }));
        return;
    }

    // BTC regime gate: pull BTC MTF first to decide global market state
    const btc = { symbol: 'BTCUSDT', timeframes: {} };
    await Promise.all(['1d', '4h', '1h'].map(async tf => {
        const c = await fetchCandles('BTCUSDT', tf, 200);
        btc.timeframes[tf] = c ? summarize(c) : { error: 'unavailable' };
    }));
    const btc1h = btc.timeframes['1h'];
    const btc4h = btc.timeframes['4h'];
    const btcAtrPct = (btc1h && !btc1h.error && btc1h.atr14 && btc1h.last) ? (btc1h.atr14 / btc1h.last) * 100 : null;
    const btcRegime = {
        trend1h: btc1h && !btc1h.error ? btc1h.trend : 'unknown',
        trend4h: btc4h && !btc4h.error ? btc4h.trend : 'unknown',
        rsi4h: btc4h && !btc4h.error ? btc4h.rsi14 : null,
        atrPct1h: btcAtrPct ? +btcAtrPct.toFixed(2) : null,
        unstable: btcAtrPct !== null && btcAtrPct > 1.5,
        verdict: null
    };
    if (btcRegime.unstable) btcRegime.verdict = 'BTC volatile — alt longs risky';
    else if (btcRegime.trend1h === btcRegime.trend4h) btcRegime.verdict = `BTC ${btcRegime.trend1h} (aligned)`;
    else btcRegime.verdict = 'BTC mixed timeframes';

    const results = await Promise.all(symbols.map(async sym => {
        try {
            const tfsData = { symbol: sym, timeframes: {} };
            await Promise.all(['1d', '4h', '1h', '15m'].map(async tf => {
                const c = await fetchCandles(sym, tf, 200);
                tfsData.timeframes[tf] = c ? summarize(c) : { error: 'unavailable' };
            }));
            const score = scoreSymbol(tfsData, sym !== 'BTCUSDT' ? btcRegime : null);
            return { symbol: sym, ...score };
        } catch (err) { return { symbol: sym, error: err.message }; }
    }));
    const ranked = results.filter(r => !r.error && !r.skip).sort((a, b) => (b.score || 0) - (a.score || 0));
    const skipped = results.filter(r => r.skip || r.error);
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ btcRegime, ranked, skipped, scannedAt: new Date().toISOString() }));
}

// ----- Monte Carlo path simulation for a planned setup -----
// Uses bootstrap sampling of recent log-returns from 1H candles to estimate
// hit probabilities of stop / target1 / target2 within a horizon (bars).
async function handleMonteCarlo(req, res) {
    if (!enforceRate(req, res, 'montecarlo', 20, 10000)) return;
    try {
        const url = new URL(req.url, 'http://x');
        const symbol = safeSymbol(url.searchParams.get('symbol'));
        const interval = safeInterval(url.searchParams.get('interval'));
        const entry = parseFloat(url.searchParams.get('entry'));
        const stop = parseFloat(url.searchParams.get('stop'));
        const targetsRaw = url.searchParams.get('targets') || '';
        const targets = targetsRaw.split(',').map(parseFloat).filter(Number.isFinite);
        const horizon = Math.min(200, Math.max(5, parseInt(url.searchParams.get('horizon') || '48', 10)));
        const nSims = Math.min(10000, Math.max(100, parseInt(url.searchParams.get('sims') || '2000', 10)));
        if (!Number.isFinite(entry) || !Number.isFinite(stop) || targets.length === 0) {
            res.writeHead(400, { 'content-type': 'application/json' });
            res.end(JSON.stringify({ error: 'entry, stop, and targets= required' }));
            return;
        }
        if (entry === stop) {
            res.writeHead(400, { 'content-type': 'application/json' });
            res.end(JSON.stringify({ error: 'entry must differ from stop' }));
            return;
        }
        const candles = await fetchCandles(symbol, interval, 500);
        if (!candles || candles.length < 50) {
            res.writeHead(502, { 'content-type': 'application/json' });
            res.end(JSON.stringify({ error: 'insufficient candle history' }));
            return;
        }
        // Compute log-returns of high & low relative to prior close to capture intra-bar range
        const logRets = [];
        const rangeBars = []; // {hiPct, loPct, closePct} relative to prior close
        for (let i = 1; i < candles.length; i++) {
            const prev = candles[i - 1].close;
            rangeBars.push({
                hi: candles[i].high / prev,
                lo: candles[i].low / prev,
                close: candles[i].close / prev
            });
            logRets.push(Math.log(candles[i].close / prev));
        }
        const direction = entry < targets[0] ? 'long' : 'short';
        let stopHits = 0;
        const targetHits = targets.map(() => 0);
        let firstHitTime = []; // bars to first resolution

        for (let s = 0; s < nSims; s++) {
            let price = entry;
            let resolved = false;
            for (let b = 0; b < horizon; b++) {
                const sample = rangeBars[Math.floor(Math.random() * rangeBars.length)];
                const barHi = price * sample.hi;
                const barLo = price * sample.lo;
                const barClose = price * sample.close;

                if (direction === 'long') {
                    if (barLo <= stop) { stopHits++; firstHitTime.push(b); resolved = true; break; }
                    for (let t = 0; t < targets.length; t++) {
                        if (barHi >= targets[t]) { targetHits[t]++; if (t === 0) firstHitTime.push(b); resolved = true; break; }
                    }
                } else {
                    if (barHi >= stop) { stopHits++; firstHitTime.push(b); resolved = true; break; }
                    for (let t = 0; t < targets.length; t++) {
                        if (barLo <= targets[t]) { targetHits[t]++; if (t === 0) firstHitTime.push(b); resolved = true; break; }
                    }
                }
                if (resolved) break;
                price = barClose;
            }
        }

        // Expected R per trade (using T1 as reward, stop = -1R)
        const risk = Math.abs(entry - stop);
        const reward1 = Math.abs(targets[0] - entry);
        const r1 = reward1 / risk;
        const winProb = targetHits[0] / nSims;
        const lossProb = stopHits / nSims;
        const undecided = 1 - winProb - lossProb;
        const expectancyR = winProb * r1 - lossProb * 1;
        const medianBarsToHit = firstHitTime.length ? firstHitTime.sort((a, b) => a - b)[Math.floor(firstHitTime.length / 2)] : null;

        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({
            symbol, interval, direction, entry, stop, targets, horizon, nSims,
            stopHitProb: +(lossProb * 100).toFixed(1),
            targetHitProb: targetHits.map(h => +(h / nSims * 100).toFixed(1)),
            undecidedProb: +(undecided * 100).toFixed(1),
            expectancyR: +expectancyR.toFixed(3),
            medianBarsToHit,
            verdict: expectancyR > 0.2 ? 'positive_edge' : expectancyR > 0 ? 'thin_edge' : 'negative_edge',
            sampleSize: rangeBars.length
        }));
    } catch (err) {
        res.writeHead(500, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: err.message || String(err) }));
    }
}