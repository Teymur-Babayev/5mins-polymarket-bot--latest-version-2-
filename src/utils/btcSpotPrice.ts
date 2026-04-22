/**
 * Best-effort BTC/USD spot (Binance public ticker). Used for window-open delta only.
 */

import axios from 'axios';

let cachedPrice: number | null = null;
let cachedAtMs = 0;
const CACHE_TTL_MS = 2_000;

export async function fetchBtcUsdPrice(opts?: { forceRefresh?: boolean }): Promise<number | null> {
    const now = Date.now();
    if (
        !opts?.forceRefresh &&
        cachedPrice !== null &&
        now - cachedAtMs < CACHE_TTL_MS
    ) {
        return cachedPrice;
    }
    try {
        const r = await axios.get<{ price?: string }>('https://api.binance.com/api/v3/ticker/price', {
            params: { symbol: 'BTCUSDT' },
            timeout: 6_000,
        });
        const p = parseFloat(String(r.data?.price ?? ''));
        if (!Number.isFinite(p) || p <= 0) return null;
        cachedPrice = p;
        cachedAtMs = now;
        return p;
    } catch {
        return null;
    }
}
