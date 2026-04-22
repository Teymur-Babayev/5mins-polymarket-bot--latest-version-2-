/**
 * Polymarket-style **taker** fee on binary outcome shares (approximation used by the CLOB):
 *   fee = C × feeRate × p × (1 − p)
 * where C = shares traded, p = trade price in (0,1), feeRate from config (e.g. feeBips / 10_000).
 * Maker fills: fee = 0 (not modeled here).
 */

const P_CLAMP = 1e-9;

/**
 * Per-share **all-in** USD cost for buying outcome shares at trade price `p`, using the common
 * Polymarket-style taker term `k * p * (1 - p)` added to notional: `p + k * p * (1 - p)`.
 * Example: p=0.56, k=0.072 → 0.56 + 0.072*0.56*0.44.
 */
export function binaryOutcomeBuyAllInPerShare(price: number, feeScalar: number): number {
    if (!(feeScalar > 0) || !Number.isFinite(feeScalar)) return price;
    const p = Math.min(Math.max(price, P_CLAMP), 1 - P_CLAMP);
    if (!Number.isFinite(p)) return price;
    return p + feeScalar * p * (1 - p);
}

/** Fee-only USD per share (all-in minus raw price). */
export function binaryOutcomeTakerFeePerShareUsd(price: number, feeScalar: number): number {
    return Math.max(0, binaryOutcomeBuyAllInPerShare(price, feeScalar) - price);
}

/**
 * After buying one leg at all-in `firstLegAllInPerShare`, max **other** leg bid (per $1 payout share)
 * so that first + second + margin ≤ 1 (binary complement budget).
 */
export function pairOpposingLegMaxBidAfterFirst(firstLegAllInPerShare: number, margin: number): number {
    const m = Math.max(0, margin);
    const x = Math.min(Math.max(firstLegAllInPerShare, 0), 1);
    return Math.max(0, 1 - x - m);
}

/** Taker fee in USD for one fill: `C × feeRate × p × (1 − p)`. Use `feeRate = k` (e.g. 0.072). */
export function polymarketBinaryTakerFeeUsd(shares: number, price: number, feeRate: number): number {
    const C = Math.floor(Math.max(0, shares) + 1e-12);
    if (C <= 0 || !(feeRate > 0) || !Number.isFinite(feeRate)) return 0;
    const p = Math.min(Math.max(price, P_CLAMP), 1 - P_CLAMP);
    if (!Number.isFinite(p)) return 0;
    return C * feeRate * p * (1 - p);
}

export type OrderLiquidityRole = 'MAKER' | 'TAKER';

/**
 * Commission-only USD for a binary buy (same fee term as {@link polymarketBinaryTakerFeeUsd}).
 * MAKER → 0. TAKER → `C × k × p × (1−p)` when `feeScalar > 0`, else `feeBips`-based rate.
 */
export function takerCommissionUsdForBinaryBuy(
    shares: number,
    rawPricePerShare: number,
    liquidity: OrderLiquidityRole,
    feeBips: number,
    feeScalar: number
): number {
    if (liquidity === 'MAKER') return 0;
    const sh = Math.floor(Math.max(0, shares) + 1e-12);
    if (sh <= 0 || !Number.isFinite(rawPricePerShare)) return 0;
    if (feeScalar > 0 && Number.isFinite(feeScalar)) {
        return polymarketBinaryTakerFeeUsd(sh, rawPricePerShare, feeScalar);
    }
    const feeRate = (feeBips ?? 0) / 10000;
    return polymarketBinaryTakerFeeUsd(sh, rawPricePerShare, feeRate);
}

/**
 * Total USD for buying `shares` at **raw** trade price per share `rawPricePerShare` (0..1).
 * - **MAKER:** notional only (no commission in this model).
 * - **TAKER:** notional + commission. If `feeScalar > 0`, fee/share = `feeScalar * p * (1-p)` (matches
 *   `binaryOutcomeBuyAllInPerShare` − p). Otherwise commission = `polymarketBinaryTakerFeeUsd` using `feeBips`.
 *
 * Pair cost uses (cost_YES/qty_YES) + (cost_NO/qty_NO); each fill should use this for `addedCost` so both
 * legs include their respective commissions before comparing to e.g. $0.98.
 */
export function buyBinaryOutcomeLegUsd(
    shares: number,
    rawPricePerShare: number,
    liquidity: OrderLiquidityRole,
    feeBips: number,
    feeScalar: number
): number {
    const sh = Math.floor(Math.max(0, shares) + 1e-12);
    if (sh <= 0 || !Number.isFinite(rawPricePerShare)) return 0;
    const p = Math.min(Math.max(rawPricePerShare, P_CLAMP), 1 - P_CLAMP);
    const notional = sh * p;
    if (liquidity === 'MAKER') return notional;
    if (feeScalar > 0 && Number.isFinite(feeScalar)) {
        return sh * (p + feeScalar * p * (1 - p));
    }
    const feeRate = (feeBips ?? 0) / 10000;
    return notional + polymarketBinaryTakerFeeUsd(sh, rawPricePerShare, feeRate);
}

/** Sum taker fees for paper orders that recorded `liquidity: 'TAKER'`. */
export function sumPaperRecordedTakerFeesUsd(
    orders: ReadonlyArray<{ size: number; price: number; liquidity?: OrderLiquidityRole }>,
    feeBips: number
): number {
    const feeRate = feeBips / 10000;
    let sum = 0;
    for (const o of orders) {
        if (o.liquidity === 'TAKER') {
            sum += polymarketBinaryTakerFeeUsd(o.size, o.price, feeRate);
        }
    }
    return sum;
}

/**
 * When per-fill maker/taker is unknown (e.g. live), approximate settlement taker fee using VWAP per leg
 * and the same formula on full leg size — treats all volume as taker (conservative vs a maker-heavy book).
 */
export function estimateTakerFeesFromLegVwapUsd(
    qtyYes: number,
    avgYes: number,
    qtyNo: number,
    avgNo: number,
    feeBips: number
): number {
    const feeRate = feeBips / 10000;
    let sum = 0;
    const y = Math.floor(Math.max(0, qtyYes) + 1e-12);
    const n = Math.floor(Math.max(0, qtyNo) + 1e-12);
    if (y > 0 && avgYes > 0 && avgYes < 1) sum += polymarketBinaryTakerFeeUsd(y, avgYes, feeRate);
    if (n > 0 && avgNo > 0 && avgNo < 1) sum += polymarketBinaryTakerFeeUsd(n, avgNo, feeRate);
    return sum;
}
