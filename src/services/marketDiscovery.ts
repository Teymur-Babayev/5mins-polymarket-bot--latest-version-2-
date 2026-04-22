/**
 * Discovers the active Bitcoin "Up or Down" market (5m or 15m) from Polymarket.
 *
 * Slugs:
 *   - btc-updown-5m-{UNIX_WINDOW_START}
 *   - btc-updown-15m-{UNIX_WINDOW_START}
 *
 * Fetches directly: GET /markets/slug/{slug}
 */

import axios from 'axios';
import type { ActiveMarket, StrategyConfig } from '../interfaces/strategyInterfaces';

const GAMMA_API = 'https://gamma-api.polymarket.com';
const WINDOWS_TO_CHECK = 4;

export const BTC_WINDOW_5M_SEC = 300;
export const BTC_WINDOW_15M_SEC = 900;

/** Resolve configured window length (seconds). */
export function btcWindowDurationSec(config: StrategyConfig): number {
    return config.btcMarketWindowMinutes === 5 ? BTC_WINDOW_5M_SEC : BTC_WINDOW_15M_SEC;
}

/** Minutes label for slug (5 or 15). */
export function btcWindowMinutesLabel(config: StrategyConfig): 5 | 15 {
    return config.btcMarketWindowMinutes === 5 ? 5 : 15;
}

interface GammaMarket {
    id?: string;
    conditionId?: string;
    question?: string;
    slug?: string;
    description?: string;
    endDate?: string;
    endDateIso?: string;
    startDate?: string;
    eventStartTime?: string;
    acceptingOrders?: boolean;
    closed?: boolean;
    enableOrderBook?: boolean;
    orderPriceMinTickSize?: number;
    orderMinSize?: number;
    clobTokenIds?: string | string[];
    negRisk?: boolean;
    outcomes?: string | string[];
    tokens?: Array<{ token_id: string; outcome: string }>;
}

function getWindowStart(unixSeconds: number, durationSec: number): number {
    return Math.floor(unixSeconds / durationSec) * durationSec;
}

function buildSlug(windowStart: number, minutes: 5 | 15): string {
    return `btc-updown-${minutes}m-${windowStart}`;
}

function extractClobTokenParts(clobTokenIds: string | string[] | undefined): string[] {
    if (!clobTokenIds) return [];
    if (Array.isArray(clobTokenIds)) {
        return clobTokenIds.map(String);
    }
    try {
        const parsed = JSON.parse(clobTokenIds);
        return Array.isArray(parsed) ? parsed.map(String) : clobTokenIds.split(',').map((s) => s.trim()).filter(Boolean);
    } catch {
        return clobTokenIds.split(',').map((s) => s.trim()).filter(Boolean);
    }
}

/** CLOB token ids plus which Gamma outcome index (0 or 1) is YES/Up — used for resolution vs outcomePrices. */
export type ParsedBinaryTokens = {
    yesTokenId: string;
    noTokenId: string;
    yesSlot: 0 | 1;
};

export function parseTokenIds(
    clobTokenIds: string | string[] | undefined,
    outcomes: string | string[] | undefined,
    tokens?: Array<{ token_id: string; outcome: string }>
): ParsedBinaryTokens | null {
    if (tokens && tokens.length >= 2) {
        const upToken = tokens.find((t) => /^(yes|up)$/i.test(t.outcome?.trim()));
        const downToken = tokens.find((t) => /^(no|down)$/i.test(t.outcome?.trim()));
        if (upToken && downToken) {
            const parts = extractClobTokenParts(clobTokenIds);
            if (parts.length >= 2) {
                const yi = parts.indexOf(upToken.token_id);
                if (yi === 0 || yi === 1) {
                    return {
                        yesTokenId: upToken.token_id,
                        noTokenId: downToken.token_id,
                        yesSlot: yi as 0 | 1,
                    };
                }
            }
            return { yesTokenId: upToken.token_id, noTokenId: downToken.token_id, yesSlot: 0 };
        }
    }

    if (!clobTokenIds) return null;

    const parts = extractClobTokenParts(clobTokenIds);
    if (parts.length < 2) return null;

    let outcomeList: string[] = [];
    if (outcomes) {
        if (Array.isArray(outcomes)) {
            outcomeList = outcomes.map(String);
        } else {
            try {
                const parsed = JSON.parse(outcomes);
                outcomeList = Array.isArray(parsed) ? parsed.map(String) : outcomes.split(',').map((s) => s.trim());
            } catch {
                outcomeList = outcomes.split(',').map((s) => s.trim());
            }
        }
    }

    if (outcomeList.length >= 2) {
        const upIdx = outcomeList.findIndex((o) => /^(yes|up)$/i.test(o.trim()));
        const downIdx = outcomeList.findIndex((o) => /^(no|down)$/i.test(o.trim()));
        if (upIdx >= 0 && downIdx >= 0 && upIdx < parts.length && downIdx < parts.length) {
            const yesSlot = (upIdx === 0 || upIdx === 1 ? upIdx : 0) as 0 | 1;
            return { yesTokenId: parts[upIdx], noTokenId: parts[downIdx], yesSlot };
        }
    }

    return { yesTokenId: parts[0], noTokenId: parts[1], yesSlot: 0 };
}

async function fetchMarketBySlug(slug: string): Promise<GammaMarket | null> {
    try {
        const r = await axios.get(`${GAMMA_API}/markets/slug/${slug}`, { timeout: 10000 });
        const data = r.data;
        return Array.isArray(data) ? (data[0] || null) : (data || null);
    } catch (e: unknown) {
        const axiosErr = e as { response?: { status?: number } };
        if (axiosErr.response?.status === 404) return null;
        throw e;
    }
}

export interface MarketScanReport {
    timestamp: string;
    slugsChecked: string[];
    marketsReturned: number;
    totalApiFetched: number;
    activeMarket: {
        question: string;
        slug: string;
        endTime: string;
        secondsLeft: number;
        acceptingOrders: boolean;
    } | null;
    rejected: Array<{ slug: string; reason: string }>;
    error: string | null;
}

let lastScanReport: MarketScanReport | null = null;
export function getLastScanReport(): MarketScanReport | null { return lastScanReport; }

/**
 * Active BTC Up/Down market for configured window size (5 or 15 minutes).
 */
export async function getActiveBtcUpDownMarket(config: StrategyConfig): Promise<ActiveMarket | null> {
    const minutes = btcWindowMinutesLabel(config);
    const durationSec = btcWindowDurationSec(config);
    const nowSec = Math.floor(Date.now() / 1000);
    const currentWindowStart = getWindowStart(nowSec, durationSec);

    const report: MarketScanReport = {
        timestamp: new Date().toISOString(),
        slugsChecked: [],
        marketsReturned: 0,
        totalApiFetched: 0,
        activeMarket: null,
        rejected: [],
        error: null,
    };

    try {
        const candidates: Array<{
            market: GammaMarket;
            tokenIds: { yesTokenId: string; noTokenId: string };
            endTime: number;
            endIso: string;
        }> = [];

        for (let i = 0; i < WINDOWS_TO_CHECK; i++) {
            const windowStart = currentWindowStart + (i * durationSec);
            const slug = buildSlug(windowStart, minutes);
            report.slugsChecked.push(slug);

            const market = await fetchMarketBySlug(slug);
            if (!market) continue;

            report.totalApiFetched++;

            if (!market.enableOrderBook || !market.acceptingOrders || market.closed) {
                report.rejected.push({
                    slug,
                    reason: !market.enableOrderBook ? 'Orderbook disabled' : !market.acceptingOrders ? 'Not accepting orders' : 'Closed',
                });
                continue;
            }

            const tokenIds = parseTokenIds(market.clobTokenIds, market.outcomes, market.tokens);
            if (!tokenIds || !market.conditionId) {
                report.rejected.push({
                    slug,
                    reason: !tokenIds ? 'No valid token IDs' : 'No conditionId',
                });
                continue;
            }

            const endIso = market.endDate || new Date((windowStart + durationSec) * 1000).toISOString();
            const endTime = new Date(endIso).getTime();

            if (endTime <= Date.now()) {
                report.rejected.push({ slug, reason: 'Window already ended' });
                continue;
            }

            report.marketsReturned++;
            candidates.push({ market, tokenIds, endTime, endIso });
        }

        candidates.sort((a, b) => a.endTime - b.endTime);

        if (candidates.length > 0) {
            const best = candidates[0];
            const secsLeft = Math.max(0, Math.floor((best.endTime - Date.now()) / 1000));
            report.activeMarket = {
                question: best.market.question || best.market.slug || '',
                slug: best.market.slug || '',
                endTime: best.endIso,
                secondsLeft: secsLeft,
                acceptingOrders: true,
            };
        }

        lastScanReport = report;

        if (candidates.length === 0) return null;

        const best = candidates[0];
        const m = best.market;
        return {
            conditionId: m.conditionId!,
            question: m.question || '',
            slug: m.slug || m.conditionId!,
            yesTokenId: best.tokenIds.yesTokenId,
            noTokenId: best.tokenIds.noTokenId,
            endDateIso: best.endIso,
            gameStartTime: m.eventStartTime || m.startDate,
            acceptingOrders: true,
            closed: false,
            orderPriceMinTickSize: m.orderPriceMinTickSize,
            orderMinSize: m.orderMinSize ?? 5,
            negRisk: !!m.negRisk,
            windowDurationSec: durationSec,
            btcMarketWindowMinutes: minutes,
        };
    } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error(`[marketDiscovery] Error: ${msg}`);
        report.error = msg;
        lastScanReport = report;
        return null;
    }
}

/** @deprecated Use getActiveBtcUpDownMarket (respects config.btcMarketWindowMinutes). */
export async function getActive15mMarket(config: StrategyConfig): Promise<ActiveMarket | null> {
    return getActiveBtcUpDownMarket({
        ...config,
        btcMarketWindowMinutes: 15,
    });
}

/**
 * Parse round **start** unix (seconds) from Polymarket BTC Up/Down slug
 * `btc-updown-{5|15}m-{unix}`. This is the authoritative window open for that round.
 */
export function btcUpDownSlugWindowStartUnix(slug: string): number | null {
    const m = /^btc-updown-(?:5|15)m-(\d+)$/i.exec(String(slug || '').trim());
    if (!m) return null;
    const u = parseInt(m[1], 10);
    return Number.isFinite(u) ? u : null;
}

/**
 * Elapsed seconds and time remaining in the trading round, aligned to **slug window start + duration**.
 * Using only `endDateIso` and `windowDurationSec` can skew `elapsed` vs wall clock when Gamma `endDate`
 * does not match `slugStart + duration` (warped warmup, clip ramp, and “seconds into window” UX).
 */
export function btcUpDownWindowElapsedAndRemaining(params: {
    slug: string;
    endDateIso: string;
    windowDurationSec: number;
    gameStartTime?: string;
}): { elapsedSec: number; secondsLeft: number } {
    const dur = Math.max(1, Math.floor(params.windowDurationSec));
    const slugStart = btcUpDownSlugWindowStartUnix(params.slug);
    const now = Math.floor(Date.now() / 1000);

    if (slugStart != null) {
        const endSec = slugStart + dur;
        if (now >= endSec) {
            return { elapsedSec: dur, secondsLeft: 0 };
        }
        if (now < slugStart) {
            return { elapsedSec: 0, secondsLeft: Math.max(0, endSec - now) };
        }
        return {
            elapsedSec: Math.min(dur, now - slugStart),
            secondsLeft: Math.min(dur, endSec - now),
        };
    }

    const gst = params.gameStartTime ? Date.parse(params.gameStartTime) : NaN;
    if (Number.isFinite(gst)) {
        const startSec = Math.floor(gst / 1000);
        const endMs = Date.parse(params.endDateIso);
        if (now < startSec) {
            const endSec2 = Number.isFinite(endMs) ? Math.floor(endMs / 1000) : startSec + dur;
            return { elapsedSec: 0, secondsLeft: Math.max(0, endSec2 - now) };
        }
        const elapsedSec = Math.min(dur, Math.max(0, now - startSec));
        const secondsLeft = Number.isFinite(endMs)
            ? Math.max(0, Math.floor((endMs - Date.now()) / 1000))
            : Math.max(0, dur - elapsedSec);
        return { elapsedSec, secondsLeft };
    }

    const secondsLeft = Math.max(
        0,
        Math.floor((new Date(params.endDateIso).getTime() - Date.now()) / 1000)
    );
    const elapsedSec = Math.max(0, dur - Math.min(secondsLeft, dur));
    return { elapsedSec, secondsLeft };
}

export function secondsUntilWindowEnd(endDateIso: string): number {
    return Math.max(0, Math.floor((new Date(endDateIso).getTime() - Date.now()) / 1000));
}

export function shouldStopTradingForWindow(endDateIso: string, stopSecondsBeforeEnd: number): boolean {
    return secondsUntilWindowEnd(endDateIso) <= stopSecondsBeforeEnd;
}
