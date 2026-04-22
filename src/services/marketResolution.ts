/**
 * Market resolution helper (Gamma API).
 * Attempts to determine which outcome won for btc-updown-* markets.
 */
import axios from 'axios';
import { parseTokenIds } from './marketDiscovery';

const GAMMA_API = 'https://gamma-api.polymarket.com';

export type WinnerSide = 'YES' | 'NO';

type GammaMarketMaybeResolved = {
    slug?: string;
    closed?: boolean;
    acceptingOrders?: boolean;
    resolved?: boolean;
    clobTokenIds?: string | string[];
    tokens?: Array<{ token_id: string; outcome: string }>;
    /** JSON string array e.g. ["Up","Down"] or ["Yes","No"] — aligns with outcomePrices indices */
    outcomes?: string;
    /** JSON string array e.g. ["0","1"] when resolved — winning side has price ~1 */
    outcomePrices?: string;
    umaResolutionStatus?: string;
    resolution?: string;
    outcome?: string;
    winningOutcome?: string;
    winning_outcome?: string;
    finalOutcome?: string;
    final_outcome?: string;
    result?: string;
    answer?: string;
};

function mapOutcomeToSide(raw: unknown): WinnerSide | null {
    const s = String(raw ?? '').trim().toLowerCase();
    if (!s) return null;
    // Common binary outcomes
    if (s === 'yes' || s === 'y' || s === 'true' || s === '1') return 'YES';
    if (s === 'no' || s === 'n' || s === 'false' || s === '0') return 'NO';

    // Up/down naming (btc-updown markets sometimes expose outcome text)
    if (s === 'up') return 'YES';
    if (s === 'down') return 'NO';
    if (s.includes(' up')) return 'YES';
    if (s.includes(' down')) return 'NO';

    // Higher/lower variants (common on Polymarket crypto resolution strings)
    if (s.includes('higher') || s.includes('increase') || s.includes('above') || s.includes('greater')) return 'YES';
    if (s.includes('lower') || s.includes('decrease') || s.includes('below') || s.includes('less')) return 'NO';
    return null;
}

function parseJsonStringArray(raw: unknown): string[] | null {
    if (raw == null) return null;
    if (Array.isArray(raw)) return raw.map((x) => String(x));
    if (typeof raw === 'string') {
        try {
            const a = JSON.parse(raw) as unknown;
            return Array.isArray(a) ? a.map((x) => String(x)) : null;
        } catch {
            return null;
        }
    }
    return null;
}

/**
 * Gamma often exposes resolution via outcomePrices (["1","0"]) before text fields are filled.
 * Align with `outcomes` by index when present (Up/Down vs Yes/No).
 */
function pickWinnerFromOutcomePrices(m: GammaMarketMaybeResolved): WinnerSide | null {
    const prices = parseJsonStringArray(m.outcomePrices);
    if (!prices || prices.length < 2) return null;
    const p0 = parseFloat(prices[0]);
    const p1 = parseFloat(prices[1]);
    if (!Number.isFinite(p0) || !Number.isFinite(p1)) return null;
    const hi = 0.92;
    const lo = 0.08;
    let winningIdx: 0 | 1 | null = null;
    if (p0 >= hi && p1 <= lo) winningIdx = 0;
    else if (p1 >= hi && p0 <= lo) winningIdx = 1;
    else return null;

    const layout = parseTokenIds(m.clobTokenIds, m.outcomes, m.tokens);
    if (layout) {
        return winningIdx === layout.yesSlot ? 'YES' : 'NO';
    }

    const outcomeNames = parseJsonStringArray(m.outcomes);
    if (outcomeNames && outcomeNames[winningIdx]) {
        const side = mapOutcomeToSide(outcomeNames[winningIdx]);
        if (side) return side;
    }
    return null;
}

function pickWinnerFromMarket(m: GammaMarketMaybeResolved): WinnerSide | null {
    return (
        pickWinnerFromOutcomePrices(m) ??
        mapOutcomeToSide(m.winningOutcome) ??
        mapOutcomeToSide(m.winning_outcome) ??
        mapOutcomeToSide(m.outcome) ??
        mapOutcomeToSide(m.finalOutcome) ??
        mapOutcomeToSide(m.final_outcome) ??
        mapOutcomeToSide(m.resolution) ??
        mapOutcomeToSide(m.result) ??
        mapOutcomeToSide(m.answer) ??
        null
    );
}

async function getGammaMarketBySlug(slug: string): Promise<GammaMarketMaybeResolved | null> {
    const r = await axios.get(`${GAMMA_API}/markets/slug/${slug}`, { timeout: 10_000 });
    const data = r.data;
    return Array.isArray(data) ? (data[0] || null) : (data || null);
}

/**
 * Polymarket BTC Up/Down stores official Chainlink stream snapshots on the event:
 * `events[0].eventMetadata.priceToBeat` (window open) and `.finalPrice` (window end).
 * These match the UI "Price to Beat" / "Final Price", not Binance spot.
 */
export function extractGammaBtcUpDownOraclePrices(market: unknown): {
    priceToBeat: number | null;
    finalPrice: number | null;
} {
    const m = market as {
        events?: Array<{ eventMetadata?: { priceToBeat?: unknown; finalPrice?: unknown } }>;
    };
    const meta = m.events?.[0]?.eventMetadata;
    if (!meta || typeof meta !== 'object') {
        return { priceToBeat: null, finalPrice: null };
    }
    const ptb = meta.priceToBeat != null ? Number(meta.priceToBeat) : NaN;
    const fp = meta.finalPrice != null ? Number(meta.finalPrice) : NaN;
    return {
        priceToBeat: Number.isFinite(ptb) ? ptb : null,
        finalPrice: Number.isFinite(fp) ? fp : null,
    };
}

export type GammaBtcUpDownWindowDetails = {
    winner: WinnerSide | null;
    priceToBeat: number | null;
    finalPrice: number | null;
};

/** Single Gamma GET: resolution winner + Chainlink oracle prices when present. */
export async function fetchGammaBtcUpDownWindowDetails(slug: string): Promise<GammaBtcUpDownWindowDetails> {
    const market = await getGammaMarketBySlug(slug);
    if (!market) {
        return { winner: null, priceToBeat: null, finalPrice: null };
    }
    const { priceToBeat, finalPrice } = extractGammaBtcUpDownOraclePrices(market);
    return {
        winner: pickWinnerFromMarket(market),
        priceToBeat,
        finalPrice,
    };
}

/**
 * Returns 'YES'/'NO' once winner is published; otherwise null.
 */
export async function fetchResolvedWinnerSideBySlug(slug: string): Promise<WinnerSide | null> {
    const market = await getGammaMarketBySlug(slug);
    if (!market) return null;
    return pickWinnerFromMarket(market);
}

