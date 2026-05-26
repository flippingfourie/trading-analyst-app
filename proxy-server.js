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

const http = require('http');
const fs = require('fs');
const path = require('path');

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
        '  "summary": string,',
        '  "regime": "trending_up|trending_down|range|volatile_chop|breakout",',
        '  "htf_bias": "long|short|neutral",',
        '  "setups": [ { "direction": "long|short", "entry": number, "stop": number, "targets": number[], "confidence": "low|medium|high" } ],',
        '}'
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
// Allowed origins: localhost, file://, and Render domains
const ORIGIN_ALLOW = /^(https?:\/\/(localhost|127\.0\.0\.1|\.onrender\.com)(:\d+)?|null)$/i;
function setCors(res, req) {
    const origin = (req && req.headers.origin) || '';
    const allow = ORIGIN_ALLOW.test(origin) ? origin : 'http://localhost';
    res.setHeader('Access-Control-Allow-Origin', allow);
    res.setHeader('Vary', 'Origin');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'content-type');
}
function originAllowed(req) {
    const o = (req && req.headers.origin) || '';
    if (!o) return true;
    return ORIGIN_ALLOW.test(o);
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

    // Serve the main HTML file for root
    if (req.method === 'GET' && req.url === '/') {
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
        res.end(JSON.stringify({ error: 'origin not allowed' }));
        return;
    }

    if (req.method === 'POST' && req.url === '/analyze') {
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
        return;
    }

    res.writeHead(404, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: 'Not found.' }));
});

server.listen(PORT, '0.0.0.0', () => {
    console.log(`AI Analyst proxy listening on http://0.0.0.0:${PORT}/`);
    console.log(`API endpoint: http://0.0.0.0:${PORT}/analyze`);
    console.log(`Frontend will be served at the same URL`);
});
