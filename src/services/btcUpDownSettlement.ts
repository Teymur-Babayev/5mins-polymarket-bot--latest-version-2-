/**
 * Settlement for Polymarket BTC Up/Down windows:
 * 1) Chainlink oracle prices from Gamma `eventMetadata` (Price to Beat / Final Price) when both present.
 * 2) Else Binance spot (window anchor vs end tick) as fallback.
 * 3) Else Gamma outcome text / flat oracle tie handling.
 */

export type SettlementWinnerSource =
    | 'chainlink_oracle'
    | 'btc_spot'
    | 'gamma'
    | 'gamma_btc_flat'
    | 'btc_tie_unknown'
    | 'none';

export function isBtcUpDownMarketSlug(slug: string): boolean {
    return /^btc-updown-\d+m-/i.test(slug);
}

/**
 * Polymarket rule: Up if end price >= open price (see market description); Down if end < open.
 * - Prefer `oraclePriceToBeat` + `oracleFinalPrice` from Gamma when both set (Chainlink stream).
 * - Else use Binance `btcUsdOpen` / `btcUsdEnd` when both set.
 */
export function resolveBtcUpDownWindowWinner(params: {
    slug: string;
    oraclePriceToBeat?: number | null;
    oracleFinalPrice?: number | null;
    btcUsdOpen?: number | null;
    btcUsdEnd?: number | null;
    gammaWinner: 'YES' | 'NO' | null;
}): { winner: 'YES' | 'NO' | 'UNKNOWN'; source: SettlementWinnerSource } {
    const {
        slug,
        oraclePriceToBeat: opb,
        oracleFinalPrice: ofp,
        btcUsdOpen: bo,
        btcUsdEnd: be,
        gammaWinner: g,
    } = params;

    const open = opb ?? bo;
    const end = ofp ?? be;
    const usedChainlink =
        opb != null &&
        ofp != null &&
        Number.isFinite(opb) &&
        Number.isFinite(ofp);

    if (isBtcUpDownMarketSlug(slug) && open != null && end != null && Number.isFinite(open) && Number.isFinite(end)) {
        if (end >= open) {
            return { winner: 'YES', source: usedChainlink ? 'chainlink_oracle' : 'btc_spot' };
        }
        return { winner: 'NO', source: usedChainlink ? 'chainlink_oracle' : 'btc_spot' };
    }

    if (g === 'YES' || g === 'NO') return { winner: g, source: 'gamma' };
    return { winner: 'UNKNOWN', source: 'none' };
}
