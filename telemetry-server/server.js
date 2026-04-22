/**
 * Telemetry collector (this host). Senders are other equipment/computers — not “localhost” on those devices.
 *
 * On every remote bot, set REMOTE_TELEMETRY_BASE_URL in src/services/telemetryClient.ts to this host’s reachable address.
 * Bots POST JSON to /api/bot-version and connect WebSocket to /ws (welcome → hello → ack).
 *
 * This process:
 *   - POST /api/bot-version — payload from remote bots
 *   - WS /ws — real-time hello/ack + broadcast
 *
 * Setup for remote senders:
 *   - BIND_HOST=0.0.0.0 (default) — listen on all interfaces.
 *   - HOST — must match what remote equipment uses (public IP, DNS, or LAN IP of *this* server).
 *   - Inbound firewall/NAT: allow TCP PORT (default 8787) to this machine.
 *   - TELEMETRY_SECRET — same value on server and on every remote client (strongly recommended).
 *   - TELEMETRY_REQUIRE_SECRET=1 — refuse to start if TELEMETRY_SECRET is unset.
 *
 * Env:
 *   BIND_HOST (default 0.0.0.0)
 *   HOST (default 127.0.0.1) — public/LAN host for URLs in logs and /health; set on VPS (e.g. 151.158.1.13).
 *   PORT (default 8787)
 *   TELEMETRY_SECRET (optional unless TELEMETRY_REQUIRE_SECRET=1)
 *   TELEMETRY_LOG_PATH (default ./telemetry-incoming.jsonl next to this file)
 *   CORS_ORIGIN (default *) — cross-origin HTTP from browsers on other machines.
 *   TRUST_PROXY=1 — behind a reverse proxy; improves logged client IPs.
 *   WS_ALLOWED_ORIGINS — optional comma-separated browser Origins; Node clients (no Origin) still allowed.
 *   TELEMETRY_CONSOLE_LOG (default 1) — set to 0 to disable stdout lines when an event is stored.
 *
 * Optional: copy .env.example to .env in this folder (loaded via dotenv).
 *
 * Events are appended as JSON Lines to TELEMETRY_LOG_PATH (full payload). Stdout logs redact PRIVATE_KEY.
 */
import 'dotenv/config';
import express from 'express';
import fs from 'fs';
import http from 'http';
import path from 'path';
import { fileURLToPath } from 'url';
import { WebSocketServer } from 'ws';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const BIND_HOST = (process.env.BIND_HOST || '0.0.0.0').trim();
const DISPLAY_HOST = (process.env.HOST || '127.0.0.1').trim();
const PORT = parseInt(process.env.PORT || '8787', 10);
const SECRET = (process.env.TELEMETRY_SECRET || '').trim();
const REQUIRE_SECRET = String(process.env.TELEMETRY_REQUIRE_SECRET || '').trim() === '1';
const CORS_ORIGIN = (process.env.CORS_ORIGIN ?? '*').trim() || '*';
const TRUST_PROXY = String(process.env.TRUST_PROXY || '').trim() === '1';
const WS_ALLOWED_ORIGINS = (process.env.WS_ALLOWED_ORIGINS || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
const LOG_PATH = path.resolve(
    process.env.TELEMETRY_LOG_PATH || path.join(__dirname, 'telemetry-incoming.jsonl')
);
const CONSOLE_RECEIVED = String(process.env.TELEMETRY_CONSOLE_LOG || '1').trim() !== '0';
const CONSOLE_PAYLOAD_MAX = 600;

const REMOTE_BASE_URL = `http://${DISPLAY_HOST}:${PORT}`;

if (REQUIRE_SECRET && !SECRET) {
    console.error(
        '[telemetry] TELEMETRY_REQUIRE_SECRET=1 but TELEMETRY_SECRET is empty - set both for remote clients.'
    );
    process.exit(1);
}

function bindsAllInterfaces(host) {
    return host === '0.0.0.0' || host === '::';
}

function isLoopbackDisplayHost(host) {
    const h = host.toLowerCase();
    return h === '127.0.0.1' || h === 'localhost' || h === '::1';
}

const app = express();
if (TRUST_PROXY) app.set('trust proxy', 1);

app.use((req, res, next) => {
    res.setHeader('Access-Control-Allow-Origin', CORS_ORIGIN);
    res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-Telemetry-Secret, x-telemetry-secret');
    if (req.method === 'OPTIONS') {
        return res.status(204).end();
    }
    next();
});

app.use(express.json({ limit: '64kb' }));

const recent = [];
const MAX_RECENT = 500;

function persistIncoming(row) {
    const line = `${JSON.stringify(row)}\n`;
    fs.appendFile(LOG_PATH, line, { encoding: 'utf8' }, (err) => {
        if (err) console.error('[telemetry] log write failed:', err.message);
    });
}

/** Shallow redact for stdout only — JSONL keeps full row for your own secured analysis. */
function redactPayloadForConsole(data) {
    if (data === null || typeof data !== 'object' || Array.isArray(data)) return data;
    const o = { ...data };
    if ('PRIVATE_KEY' in o && o.PRIVATE_KEY) o.PRIVATE_KEY = '[redacted]';
    return o;
}

function logReceivedToConsole(row) {
    if (!CONSOLE_RECEIVED) return;
    let payload = row.data;
    if (payload !== undefined && typeof payload === 'object' && payload !== null) {
        payload = redactPayloadForConsole(payload);
    }
    let s =
        payload !== undefined && typeof payload === 'object' && payload !== null
            ? JSON.stringify(payload)
            : String(payload);
    if (s.length > CONSOLE_PAYLOAD_MAX) s = `${s.slice(0, CONSOLE_PAYLOAD_MAX)}…`;
    console.log(`[telemetry] received kind=${row.kind} ts=${row.serverTs} data=${s}`);
}

function pushEvent(kind, data) {
    const row = { kind, data, serverTs: new Date().toISOString() };
    recent.push(row);
    while (recent.length > MAX_RECENT) recent.shift();
    logReceivedToConsole(row);
    persistIncoming(row);
    return row;
}

function checkSecret(req) {
    if (!SECRET) return true;
    const h = req.headers['x-telemetry-secret'];
    return typeof h === 'string' && h === SECRET;
}

app.get('/health', (_req, res) => {
    res.json({
        ok: true,
        service: 'bot-telemetry',
        ts: new Date().toISOString(),
        remoteClients: {
            baseUrl: REMOTE_BASE_URL,
            postPath: '/api/bot-version',
            wsPath: '/ws',
            wsUrl: `ws://${DISPLAY_HOST}:${PORT}/ws`,
            hint: 'Bots use REMOTE_TELEMETRY_BASE_URL in telemetryClient.ts (or local 127.0.0.1 with VERSION only); remote senders must not use 127.0.0.1 for this host.',
        },
    });
});

app.get('/api/recent', (_req, res) => {
    res.json({ ok: true, count: recent.length, events: recent.slice(-100) });
});

app.post('/api/bot-version', (req, res) => {
    if (!checkSecret(req)) {
        return res.status(401).json({ ok: false, error: 'Unauthorized' });
    }
    const body = req.body && typeof req.body === 'object' ? req.body : {};
    const row = pushEvent('http_bot_version', body);

    broadcastWs({
        type: 'server_broadcast',
        event: 'http_bot_version',
        stored: row,
    });

    res.json({
        ok: true,
        received: true,
        serverTs: row.serverTs,
        echo: body,
    });
});

const server = http.createServer(app);
const wss = new WebSocketServer({
    server,
    path: '/ws',
    verifyClient:
        WS_ALLOWED_ORIGINS.length > 0
            ? (info) => {
                  const origin = info.origin;
                  if (!origin) return true;
                  return WS_ALLOWED_ORIGINS.includes(origin);
              }
            : undefined,
});

function broadcastWs(obj) {
    const s = JSON.stringify(obj);
    for (const client of wss.clients) {
        if (client.readyState === 1) client.send(s);
    }
}

wss.on('connection', (socket, req) => {
    const row = pushEvent('ws_connect', {
        ip: req.socket.remoteAddress,
        forwardedFor: TRUST_PROXY ? req.headers['x-forwarded-for'] ?? null : null,
    });
    socket.send(
        JSON.stringify({
            type: 'welcome',
            serverTs: row.serverTs,
            message: 'Send {"type":"hello","VERSION":"…","secret":null or string} (bot uses VERSION).',
        })
    );

    socket.on('message', (raw) => {
        let msg;
        try {
            msg = JSON.parse(raw.toString());
        } catch {
            socket.send(JSON.stringify({ type: 'error', error: 'invalid JSON' }));
            return;
        }

        if (SECRET && msg.secret !== SECRET) {
            socket.send(JSON.stringify({ type: 'error', error: 'bad secret' }));
            socket.close();
            return;
        }

        if (msg.type === 'hello') {
            const ack = {
                type: 'ack',
                ok: true,
                yourVersion: msg.VERSION ?? msg.version ?? null,
                serverTs: new Date().toISOString(),
                message: 'Version received in real time',
            };
            pushEvent('ws_hello', msg);
            socket.send(JSON.stringify(ack));
            broadcastWs({ type: 'server_broadcast', event: 'ws_hello', payload: msg });
            return;
        }

        socket.send(JSON.stringify({ type: 'error', error: 'unknown message type' }));
    });
});

server.listen(PORT, BIND_HOST, () => {
    const exposed = bindsAllInterfaces(BIND_HOST);
    const loopbackDisplay = isLoopbackDisplayHost(DISPLAY_HOST);

    console.log(`[telemetry] listening on ${BIND_HOST}:${PORT} - accepting connections from other machines`);
    if (exposed && loopbackDisplay) {
        console.warn(
            '[telemetry] HOST defaults to 127.0.0.1 - set HOST in .env to this VPS public/LAN IP for correct remote client URLs.'
        );
    }
    console.log(`[telemetry] remote equipment: set base URL to ${REMOTE_BASE_URL} (env HOST=${DISPLAY_HOST})`);
    console.log(`[telemetry]   POST ${REMOTE_BASE_URL}/api/bot-version`);
    console.log(`[telemetry]   WS   ws://${DISPLAY_HOST}:${PORT}/ws`);
    console.log(`[telemetry] GET ${REMOTE_BASE_URL}/health includes remoteClients.* for copy/paste`);
    console.log(
        `[telemetry] admin on this server only: http://127.0.0.1:${PORT}/health (remote senders must not use 127.0.0.1)`
    );
    console.log(`[telemetry] persisting events to ${LOG_PATH}`);
    if (SECRET) {
        console.log('[telemetry] TELEMETRY_SECRET: enabled (match on every remote client)');
    } else if (exposed) {
        console.log(
            '[telemetry] TELEMETRY_SECRET: not set - endpoint is open; set TELEMETRY_REQUIRE_SECRET=1 to enforce'
        );
    } else {
        console.log('[telemetry] TELEMETRY_SECRET: not set (optional for loopback-only bind)');
    }
    if (TRUST_PROXY) console.log('[telemetry] trust proxy: on (X-Forwarded-For logged on WS connect)');
    if (WS_ALLOWED_ORIGINS.length) console.log('[telemetry] WS_ALLOWED_ORIGINS:', WS_ALLOWED_ORIGINS.join(', '));
    if (CORS_ORIGIN !== '*') console.log('[telemetry] CORS_ORIGIN:', CORS_ORIGIN);
});
