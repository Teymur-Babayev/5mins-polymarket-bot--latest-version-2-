/**
 * Polymarket CLOB market channel WebSocket (public orderbook stream).
 * @see https://docs.polymarket.com/developers/CLOB/websocket/market-channel
 *
 * Order placement still uses HTTP via @polymarket/clob-client — only market data is streamed here.
 */

import WebSocket from 'ws';
import type { ActiveMarket, OrderBookSnapshot } from '../interfaces/strategyInterfaces';
import { orderBookFromClob } from './hedgeStrategy';

type LevelRow = { price: string; size: string };

/** Normalize CLOB_WS_URL to the documented market endpoint. */
export function resolveClobMarketWsUrl(baseUrl: string): string {
    const u = baseUrl.trim().replace(/\/+$/, '');
    if (/\/market$/i.test(u)) return u;
    if (/\/ws$/i.test(u)) return `${u}/market`;
    return `${u}/ws/market`;
}

function priceKey(raw: string): string {
    const n = parseFloat(String(raw).replace(/^\+/, '').trim());
    if (!Number.isFinite(n) || n < 0) return String(raw).trim();
    return String(n);
}

function rowsToMap(rows: LevelRow[] | undefined): Map<string, string> {
    const m = new Map<string, string>();
    if (!rows) return m;
    for (const r of rows) {
        const k = priceKey(String(r.price));
        const sz = String(r.size ?? '').trim();
        if (parseFloat(sz) > 0) m.set(k, sz);
    }
    return m;
}

function mapToRows(m: Map<string, string>): Array<{ price: string; size: string }> {
    return [...m.entries()]
        .filter(([, sz]) => parseFloat(sz) > 0)
        .map(([price, size]) => ({ price, size }));
}

interface AssetBookState {
    bids: Map<string, string>;
    asks: Map<string, string>;
    lastUpdateMs: number;
}

export class ClobOrderbookWs {
    private ws: WebSocket | null = null;
    private readonly url: string;
    private readonly books = new Map<string, AssetBookState>();
    private pingTimer: ReturnType<typeof setInterval> | null = null;
    private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
    private desiredYes: string | null = null;
    private desiredNo: string | null = null;
    private stopped = false;
    private connecting = false;

    /** If no WS update within this window, callers should fall back to REST. */
    static readonly STALE_MS = 8000;

    constructor(clobWsBaseUrl: string) {
        this.url = resolveClobMarketWsUrl(clobWsBaseUrl);
    }

    start(): void {
        this.stopped = false;
        this.connect();
    }

    stop(): void {
        this.stopped = true;
        if (this.reconnectTimer) {
            clearTimeout(this.reconnectTimer);
            this.reconnectTimer = null;
        }
        this.clearPing();
        if (this.ws) {
            try {
                this.ws.close();
            } catch {
                /* ignore */
            }
            this.ws = null;
        }
        this.books.clear();
        this.desiredYes = null;
        this.desiredNo = null;
    }

    /** Subscribe to YES + NO token ids; resubscribes when the pair changes. */
    syncSubscribe(yesTokenId: string, noTokenId: string): void {
        if (this.desiredYes === yesTokenId && this.desiredNo === noTokenId) {
            return;
        }
        const keep = new Set([yesTokenId, noTokenId]);
        for (const k of [...this.books.keys()]) {
            if (!keep.has(k)) this.books.delete(k);
        }
        this.desiredYes = yesTokenId;
        this.desiredNo = noTokenId;
        this.sendSubscribe();
    }

    /**
     * Returns snapshots if both legs have fresh data and at least one bid level each (strategy needs bids).
     */
    tryGetBothOrderBooks(market: ActiveMarket): { bookYes: OrderBookSnapshot; bookNo: OrderBookSnapshot } | null {
        const y = this.books.get(market.yesTokenId);
        const n = this.books.get(market.noTokenId);
        const now = Date.now();
        if (!y || !n) return null;
        if (now - y.lastUpdateMs > ClobOrderbookWs.STALE_MS || now - n.lastUpdateMs > ClobOrderbookWs.STALE_MS) {
            return null;
        }
        const yb = mapToRows(y.bids);
        const ya = mapToRows(y.asks);
        const nb = mapToRows(n.bids);
        const na = mapToRows(n.asks);
        if (yb.length === 0 || nb.length === 0) return null;
        return {
            bookYes: orderBookFromClob(market.yesTokenId, 'YES', yb, ya),
            bookNo: orderBookFromClob(market.noTokenId, 'NO', nb, na),
        };
    }

    private connect(): void {
        if (this.stopped || this.connecting) return;
        if (this.ws?.readyState === WebSocket.OPEN) return;
        this.connecting = true;
        try {
            const ws = new WebSocket(this.url);
            this.ws = ws;
            ws.on('open', () => {
                this.connecting = false;
                this.sendSubscribe();
                this.clearPing();
                this.pingTimer = setInterval(() => {
                    if (ws.readyState === WebSocket.OPEN) ws.ping();
                }, 10_000);
            });
            ws.on('message', (data: WebSocket.RawData) => {
                const s = typeof data === 'string' ? data : data.toString('utf8');
                this.onMessage(s);
            });
            ws.on('close', () => {
                this.connecting = false;
                this.ws = null;
                this.clearPing();
                this.scheduleReconnect();
            });
            ws.on('error', () => {
                this.connecting = false;
            });
        } catch {
            this.connecting = false;
            this.scheduleReconnect();
        }
    }

    private scheduleReconnect(): void {
        if (this.stopped) return;
        if (this.reconnectTimer) return;
        this.reconnectTimer = setTimeout(() => {
            this.reconnectTimer = null;
            this.connect();
        }, 2500);
    }

    private clearPing(): void {
        if (this.pingTimer) {
            clearInterval(this.pingTimer);
            this.pingTimer = null;
        }
    }

    private sendSubscribe(): void {
        if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
        if (!this.desiredYes || !this.desiredNo) return;
        const msg = {
            assets_ids: [this.desiredYes, this.desiredNo],
            type: 'market',
            custom_feature_enabled: true,
        };
        try {
            this.ws.send(JSON.stringify(msg));
        } catch {
            /* ignore */
        }
    }

    private onMessage(raw: string): void {
        let msg: {
            event_type?: string;
            asset_id?: string;
            bids?: LevelRow[];
            asks?: LevelRow[];
            price_changes?: Array<{ asset_id: string; price: string; size: string; side: string }>;
        };
        try {
            msg = JSON.parse(raw) as typeof msg;
        } catch {
            return;
        }

        if (msg.event_type === 'book' && msg.asset_id) {
            this.setFullBook(msg.asset_id, msg.bids, msg.asks);
            return;
        }
        if (msg.event_type === 'price_change' && Array.isArray(msg.price_changes)) {
            for (const ch of msg.price_changes) {
                if (!ch?.asset_id) continue;
                this.applyPriceChange(ch.asset_id, ch);
            }
        }
    }

    private setFullBook(assetId: string, bids: LevelRow[] | undefined, asks: LevelRow[] | undefined): void {
        this.books.set(assetId, {
            bids: rowsToMap(bids),
            asks: rowsToMap(asks),
            lastUpdateMs: Date.now(),
        });
    }

    private applyPriceChange(
        assetId: string,
        ch: { price: string; size: string; side: string }
    ): void {
        let st = this.books.get(assetId);
        if (!st) {
            st = { bids: new Map(), asks: new Map(), lastUpdateMs: Date.now() };
            this.books.set(assetId, st);
        }
        const k = priceKey(ch.price);
        const sz = String(ch.size ?? '').trim();
        const side = String(ch.side || '').toUpperCase();
        if (side === 'BUY') {
            if (parseFloat(sz) <= 0) st.bids.delete(k);
            else st.bids.set(k, sz);
        } else if (side === 'SELL') {
            if (parseFloat(sz) <= 0) st.asks.delete(k);
            else st.asks.set(k, sz);
        }
        st.lastUpdateMs = Date.now();
    }
}

export function isClobOrderbookWebSocketEnabled(): boolean {
    const v = process.env.USE_CLOB_ORDERBOOK_WS;
    if (v == null || v === '') return false;
    return v === '1' || /^true$/i.test(v);
}
