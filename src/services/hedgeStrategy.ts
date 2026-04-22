/**
 * Hedge strategy: maintain pair cost (avg_YES + avg_NO) < target (e.g. $0.99).
 * Only place orders that keep simulated pair cost below threshold; balance inventory.
 *
 * Key formulas (from CoinsBench article):
 *   avg_YES = Cost_YES / Qty_YES
 *   avg_NO  = Cost_NO  / Qty_NO
 *   Pair Cost = avg_YES + avg_NO        (must be < 1.00)
 *   Locked Profit = min(Qty_YES, Qty_NO) × (1 - avg_YES - avg_NO)   [matched pairs only]
 */

import type {
    StrategyConfig,
    WindowState,
    OrderBookSnapshot,
    StrategyDecision,
    OrderBookLevel,
    StrategyDecisionContext,
} from '../interfaces/strategyInterfaces';
import { inStopTradingSecondsBeforeEndWindow } from '../config/strategyConfig';
import { btcWindowDurationSec } from './marketDiscovery';
import {
    effectiveWarmupSeconds,
    buildSizeLadderFromConfig,
    referencePickBuySide,
    referencePickClipSize,
    defaultSecondsLeftForDemo,
    capClipForSettlementQtyParity,
} from './referencePairStrategy';
import {
    buyBinaryOutcomeLegUsd,
    takerCommissionUsdForBinaryBuy,
    type OrderLiquidityRole,
} from '../utils/polymarketFees';

export function createEmptyWindowState(
    marketSlug: string,
    conditionId: string,
    windowEndIso: string,
    opts?: { yesTokenId: string; noTokenId: string }
): WindowState {
    const base: WindowState = {
        marketSlug,
        conditionId,
        windowEndIso,
        qtyYes: 0,
        qtyNo: 0,
        costYes: 0,
        costNo: 0,
        avgYes: 0,
        avgNo: 0,
        pairCost: 0,
        lockedProfit: 0,
        totalSpentUsd: 0,
        takerCommissionPaidUsd: 0,
        lastUpdated: new Date().toISOString(),
    };
    if (opts?.yesTokenId && opts?.noTokenId) {
        return { ...base, yesTokenId: opts.yesTokenId, noTokenId: opts.noTokenId };
    }
    return base;
}

/**
 * Recompute avg prices, pair cost, locked profit, and total spent from qty + cost.
 */
export function recomputeWindowDerivedFields(state: WindowState): WindowState {
    const newState = { ...state };
    newState.avgYes = newState.qtyYes > 0 ? newState.costYes / newState.qtyYes : 0;
    newState.avgNo = newState.qtyNo > 0 ? newState.costNo / newState.qtyNo : 0;
    if (newState.qtyYes > 0 && newState.qtyNo > 0) {
        newState.pairCost = newState.avgYes + newState.avgNo;
    } else if (newState.qtyYes > 0) {
        newState.pairCost = newState.avgYes;
    } else if (newState.qtyNo > 0) {
        newState.pairCost = newState.avgNo;
    } else {
        newState.pairCost = 0;
    }
    newState.totalSpentUsd = newState.costYes + newState.costNo;
    if (newState.takerCommissionPaidUsd == null || !Number.isFinite(newState.takerCommissionPaidUsd)) {
        newState.takerCommissionPaidUsd = 0;
    }
    const minQty = Math.min(newState.qtyYes, newState.qtyNo);
    if (minQty > 0 && newState.avgYes > 0 && newState.avgNo > 0) {
        const matchedCost = minQty * newState.avgYes + minQty * newState.avgNo;
        newState.lockedProfit = minQty - matchedCost;
    } else {
        newState.lockedProfit = 0;
    }
    newState.lastUpdated = new Date().toISOString();
    return newState;
}

/** Max allowed simulated pair cost avg_YES + avg_NO (fee-inclusive costs in state / simulation). */
export function pairCostCeiling(config: StrategyConfig): number {
    const hard = config.strictMaxPairCostInclusive ?? 0.98;
    return Math.min(hard, config.safetyMargin, config.targetPairCostMax);
}

/**
 * Opposite leg's best ask as fee-inclusive $/share (taker model).
 * Used for the empty-book gate when simulating a **taker** completion, or as a fallback when the opposite bid is missing.
 * When the first leg is simulated as **MAKER**, {@link clampBuySizeForSimulatedGates} prefers `oppositeBidForFirstLegGate`
 * so the implied pair is bid + opposite bid (typical paired maker path), not bid + opposite ask.
 */
export function oppositeAskAllInForSide(
    side: 'YES' | 'NO',
    bookYes: OrderBookSnapshot,
    bookNo: OrderBookSnapshot,
    config: StrategyConfig
): number | undefined {
    const raw = side === 'YES' ? bookNo.bestAsk : bookYes.bestAsk;
    if (raw === undefined || !(raw > 0) || !(raw < 1)) return undefined;
    const feeBips = config.feeBips ?? 0;
    const feeScalar = config.binaryOutcomeTakerFeeScalar ?? 0;
    return buyBinaryOutcomeLegUsd(1, raw, 'TAKER', feeBips, feeScalar);
}

/** Min share delta to treat on-chain vs tracked as different (RPC + float noise). */
export const CHAIN_QTY_SYNC_EPS = 0.05;

export interface ChainSyncPriceHints {
    bestBidYes: number;
    bestBidNo: number;
}

/**
 * Align window inventory with on-chain conditional token balances (source of truth in live mode).
 * - Lower qty than tracked: scale cost proportionally (order never filled or over-counted).
 * - Higher qty than tracked: treat extra shares as bought at best-bid hint (or prior avg, else 0.5).
 *
 * When the position API still reports ~0 on a leg but fill reconciliation already increased
 * tracked qty, **do not** scale down to zero — that lags behind CLOB fills and makes the next
 * tick behave like paper with no inventory (imbalanced clips, wrong After PnL). Same behavior as
 * paper where there is no chain sync.
 */
export function syncWindowStateWithChain(
    state: WindowState,
    chainYesRaw: number,
    chainNoRaw: number,
    hints: ChainSyncPriceHints
): { state: WindowState; adjusted: boolean } {
    const chainYes = Math.max(0, chainYesRaw);
    const chainNo = Math.max(0, chainNoRaw);
    const py = hints.bestBidYes > 0 ? hints.bestBidYes : state.avgYes > 0 ? state.avgYes : 0.5;
    const pn = hints.bestBidNo > 0 ? hints.bestBidNo : state.avgNo > 0 ? state.avgNo : 0.5;

    let adjusted = false;
    let s = { ...state };

    if (chainYes < s.qtyYes - CHAIN_QTY_SYNC_EPS) {
        const chainNearZero = chainYes < CHAIN_QTY_SYNC_EPS;
        if (chainNearZero && s.qtyYes > CHAIN_QTY_SYNC_EPS) {
            // Stale chain read; keep fill-tracked qty/cost until chain catches up.
        } else {
            const ratio = s.qtyYes > 0 ? chainYes / s.qtyYes : 0;
            s.qtyYes = chainYes;
            s.costYes = s.costYes * ratio;
            if ((s.takerCommissionPaidUsd ?? 0) > 0) {
                s.takerCommissionPaidUsd = (s.takerCommissionPaidUsd ?? 0) * ratio;
            }
            adjusted = true;
        }
    } else if (chainYes > s.qtyYes + CHAIN_QTY_SYNC_EPS) {
        const d = chainYes - s.qtyYes;
        s.qtyYes = chainYes;
        s.costYes = s.costYes + d * py;
        adjusted = true;
    }

    if (chainNo < s.qtyNo - CHAIN_QTY_SYNC_EPS) {
        const chainNearZero = chainNo < CHAIN_QTY_SYNC_EPS;
        if (chainNearZero && s.qtyNo > CHAIN_QTY_SYNC_EPS) {
            // Stale chain read; keep fill-tracked qty/cost until chain catches up.
        } else {
            const ratio = s.qtyNo > 0 ? chainNo / s.qtyNo : 0;
            s.qtyNo = chainNo;
            s.costNo = s.costNo * ratio;
            if ((s.takerCommissionPaidUsd ?? 0) > 0) {
                s.takerCommissionPaidUsd = (s.takerCommissionPaidUsd ?? 0) * ratio;
            }
            adjusted = true;
        }
    } else if (chainNo > s.qtyNo + CHAIN_QTY_SYNC_EPS) {
        const d = chainNo - s.qtyNo;
        s.qtyNo = chainNo;
        s.costNo = s.costNo + d * pn;
        adjusted = true;
    }

    s = recomputeWindowDerivedFields(s);
    return { state: s, adjusted };
}

export function updateWindowStateFromFill(
    state: WindowState,
    side: 'YES' | 'NO',
    addedQty: number,
    addedCost: number,
    opts?: { takerCommissionUsd?: number }
): WindowState {
    const rawQ = Math.max(0, addedQty);
    const dq = Math.floor(rawQ + 1e-9);
    const costScale = rawQ > 1e-12 ? Math.min(1, dq / rawQ) : 1;
    const dc = addedCost * costScale;
    const newState = { ...state };
    if (side === 'YES') {
        newState.qtyYes = state.qtyYes + dq;
        newState.costYes = state.costYes + dc;
    } else {
        newState.qtyNo = state.qtyNo + dq;
        newState.costNo = state.costNo + dc;
    }
    const addFee = opts?.takerCommissionUsd;
    if (addFee != null && Number.isFinite(addFee) && addFee > 0) {
        newState.takerCommissionPaidUsd = (state.takerCommissionPaidUsd ?? 0) + addFee * costScale;
    }
    return recomputeWindowDerivedFields(newState);
}

/**
 * Update window state after SELLING shares back (emergency exit / rebalance).
 * Reduces position on the given side. Cost is reduced proportionally at average cost.
 * The difference between average cost and sale price is the realized spread loss.
 */
export function updateWindowStateFromSell(
    state: WindowState,
    side: 'YES' | 'NO',
    soldQty: number,
    _saleProceeds: number
): WindowState {
    const newState = { ...state };
    if (side === 'YES') {
        const avgCostPerShare = state.qtyYes > 0 ? state.costYes / state.qtyYes : 0;
        newState.qtyYes = Math.max(0, state.qtyYes - soldQty);
        newState.costYes = newState.qtyYes > 0 ? newState.qtyYes * avgCostPerShare : 0;
    } else {
        const avgCostPerShare = state.qtyNo > 0 ? state.costNo / state.qtyNo : 0;
        newState.qtyNo = Math.max(0, state.qtyNo - soldQty);
        newState.costNo = newState.qtyNo > 0 ? newState.qtyNo * avgCostPerShare : 0;
    }
    return recomputeWindowDerivedFields(newState);
}

const SETTLEMENT_PNL_EPS = 1e-6;

/** Default floor for both After PnL If Up/Down (net of modeled fees) when both legs are held (config override). */
export function minDualAfterPnlUsd(config: StrategyConfig): number {
    const v = config.minDualAfterPnlUsd;
    return typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : 0.7;
}

export function minDualAfterPnlStrictAbove(config: StrategyConfig): boolean {
    return config.minDualAfterPnlStrictAbove === true;
}

/** Slack cap: slightly above min when strict so clip stays strictly above floor after discrete shares. */
export function effectiveMinDualForSlackUsd(config: StrategyConfig): number {
    const base = minDualAfterPnlUsd(config);
    return minDualAfterPnlStrictAbove(config) ? base + 1e-4 : base;
}

export function dualAfterPnlMeetsMin(
    afterUp: number,
    afterDown: number,
    minD: number,
    strictAbove: boolean
): boolean {
    if (strictAbove) return afterUp > minD && afterDown > minD;
    return (
        afterUp >= minD - SETTLEMENT_PNL_EPS && afterDown >= minD - SETTLEMENT_PNL_EPS
    );
}

const LADDER_QTY_EPS = 1e-8;

/**
 * Ladder: `minDualAfterPnlUsd` and strict dual-leg settlement simulation apply only to **Stock B**
 * (hedging the open leg). **Stock A** is any buy that is not that hedge:
 * - first fill from empty, or stacking the same leg while one-sided, or
 * - starting a new rung from a balanced book, or adding to the heavier leg while two-sided.
 * Stock B is: opposite leg while one-sided, or the lighter leg while two-sided imbalanced (toward parity).
 */
export function requiresMinDualAfterPnlForSimulatedBuy(state: WindowState, side: 'YES' | 'NO'): boolean {
    const z = LADDER_QTY_EPS;
    const y = state.qtyYes;
    const n = state.qtyNo;
    if (y <= z && n <= z) return false;
    /** One-sided: enforce min-dual / Stock B only on the hedge (opposite) leg — not when stacking the heavy side. */
    if (y > z && n <= z) return side === 'NO';
    if (n > z && y <= z) return side === 'YES';
    if (Math.abs(y - n) <= z) return false;
    if (y < n) return side === 'YES';
    return side === 'NO';
}

/**
 * True when this buy is the **hedge that completes** a strictly one-sided book (buy opposite outcome).
 * Pair-cost ceiling applies here and on two-sided parity hedges — not on empty-book Stock A, stacking, or balanced rungs.
 */
export function completingOneSidedHedgeLeg(state: WindowState, side: 'YES' | 'NO'): boolean {
    const z = LADDER_QTY_EPS;
    const y = state.qtyYes;
    const n = state.qtyNo;
    if (y > z && n <= z) return side === 'NO';
    if (n > z && y <= z) return side === 'YES';
    return false;
}

/**
 * Which outcome (YES=Up / NO=Down) BTC momentum gap favors for final-window one-sided chase.
 * Only meaningful when inventory is one-sided; null = neutral band (wait, re-evaluate next tick).
 */
export function momentumGapPreferredOutcomeSide(
    state: WindowState,
    btcGapUsd: number,
    favorDownGapUsd: number,
    favorUpGapUsd: number
): 'YES' | 'NO' | null {
    const z = 1e-8;
    const y = state.qtyYes;
    const n = state.qtyNo;
    const longUp = y > z && n <= z;
    const longDown = n > z && y <= z;
    if (!longUp && !longDown) return null;
    if (longUp) {
        if (btcGapUsd <= favorDownGapUsd) return 'NO';
        if (btcGapUsd >= favorUpGapUsd) return 'YES';
        return null;
    }
    if (btcGapUsd >= favorUpGapUsd) return 'YES';
    if (btcGapUsd <= favorDownGapUsd) return 'NO';
    return null;
}

/**
 * **Balanced** book (matched pair-ladder rung): next Stock A leg — pick Up vs Down from BTC gap vs window open.
 * Uses dead zone, then `momentumBiasGapUsd`, then final-window favor thresholds, then sign of gap.
 * Null = gap inside dead zone only — keep caller’s side (tilt / cheaper bid).
 */
export function predictWinnerSideFromBtcGapForPairLadderStockA(
    config: StrategyConfig,
    btcUsdDeltaFromWindowOpen: number | null | undefined
): 'YES' | 'NO' | null {
    if (btcUsdDeltaFromWindowOpen == null || !Number.isFinite(btcUsdDeltaFromWindowOpen)) {
        return null;
    }
    const dead = config.btcGapSignDeadZoneUsd ?? 5;
    const g = btcUsdDeltaFromWindowOpen;
    if (Math.abs(g) <= dead) return null;

    const thr = config.momentumBiasGapUsd ?? 35;
    if (g >= thr) return 'YES';
    if (g <= -thr) return 'NO';

    const favorUp = config.finalOneSidedMomentumFavorUpGapUsd ?? 15;
    const favorDown = config.finalOneSidedMomentumFavorDownGapUsd ?? -15;
    if (g >= favorUp) return 'YES';
    if (g <= favorDown) return 'NO';

    return g > 0 ? 'YES' : 'NO';
}

/**
 * Which outcome’s best ask is rising faster (simple YES velocity − NO velocity).
 * Returns null when samples are missing or the spread is below `minAbsDeltaUsdPerSec`.
 */
export function predictWinnerSideFromAskVelocityDelta(
    yesVel: number | null | undefined,
    noVel: number | null | undefined,
    minAbsDeltaUsdPerSec: number
): 'YES' | 'NO' | null {
    if (yesVel == null || noVel == null || !Number.isFinite(yesVel) || !Number.isFinite(noVel)) {
        return null;
    }
    const d = yesVel - noVel;
    if (!Number.isFinite(d) || Math.abs(d) < minAbsDeltaUsdPerSec) return null;
    return d > 0 ? 'YES' : 'NO';
}

/** Optional book / BTC extrapolation for pair-ladder Stock A when the spot gap is neutral. */
export interface PairLadderStockAMomentumPickInput {
    yesAskVelocityUsdPerSec: number | null;
    noAskVelocityUsdPerSec: number | null;
    /** e.g. extrapolated gap +60s from rolling samples */
    btcGapPredictedUsd?: number | null;
    bestAskYes?: number;
    bestAskNo?: number;
    bestBidYes?: number;
    bestBidNo?: number;
}

/**
 * Matched pair-ladder Stock A: pick predicted winner from BTC gap (primary), then ask momentum,
 * extrapolated gap, then higher best ask / best bid tie-break — always returns YES or NO so the bot
 * does not idle after a completed pair when the gap sits in the dead zone.
 */
export function predictWinnerForPairLadderStockA(
    config: StrategyConfig,
    btcUsdDeltaFromWindowOpen: number | null | undefined,
    input: PairLadderStockAMomentumPickInput
): 'YES' | 'NO' {
    const byGap = predictWinnerSideFromBtcGapForPairLadderStockA(config, btcUsdDeltaFromWindowOpen);
    if (byGap !== null) return byGap;

    const minSep = config.pairLadderAskVelocityMinSepUsdPerSec ?? 0.0008;
    const byVel = predictWinnerSideFromAskVelocityDelta(
        input.yesAskVelocityUsdPerSec,
        input.noAskVelocityUsdPerSec,
        minSep
    );
    if (byVel !== null) return byVel;

    const pred = input.btcGapPredictedUsd;
    if (pred != null && Number.isFinite(pred)) {
        const dead = config.btcGapSignDeadZoneUsd ?? 5;
        if (Math.abs(pred) > dead) return pred > 0 ? 'YES' : 'NO';
        if (Math.abs(pred) > 1e-9) return pred > 0 ? 'YES' : 'NO';
    }

    const ya = input.bestAskYes ?? 0;
    const na = input.bestAskNo ?? 0;
    if (ya > na + 1e-6) return 'YES';
    if (na > ya + 1e-6) return 'NO';

    const by = input.bestBidYes ?? 0;
    const bn = input.bestBidNo ?? 0;
    return by >= bn ? 'YES' : 'NO';
}

/** Inputs for entry rise signal (BTC gap + dual-leg ask velocity + spreads). */
export interface EntryRiseSignalInput {
    /** spot − btcUsdAtWindowOpen; null if spot or open missing */
    btcUsdDeltaFromWindowOpen: number | null;
    yesAsk: number;
    noAsk: number;
    yesAskVelocityUsdPerSec: number | null;
    noAskVelocityUsdPerSec: number | null;
    /** bestAsk − bestBid per leg */
    spreadYes: number;
    spreadNo: number;
}

export interface EntryRiseSignalResult {
    side: 'YES' | 'NO' | null;
    /** Composite tilt in [-1,1]: positive favors YES (Up). */
    tilt: number;
    detail: string;
}

/**
 * Combine BTC gap (vs window open), relative best-ask rise velocity (YES vs NO), and spread tightness
 * to infer which outcome’s ask is more likely to keep rising. Null side = inconclusive composite score.
 * Used by {@link predictLikelyRisingSide} and pair-ladder equal/initiation picks regardless of `entryRiseSignalEnabled`.
 */
export function evaluateLikelyRisingSideSignal(
    config: StrategyConfig,
    input: EntryRiseSignalInput
): EntryRiseSignalResult {
    const dead = config.btcGapSignDeadZoneUsd ?? 5;
    const btcScale = Math.max(1e-9, config.entryRiseBtcGapScaleUsd ?? 40);
    const btcW = config.entryRiseBtcWeight ?? 1;
    const velW = config.entryRiseVelWeight ?? 1;
    const sprW = config.entryRiseSpreadWeight ?? 0.35;
    const velScale = Math.max(1e-9, config.entryRiseAskVelScaleUsdPerSec ?? 0.005);
    const spreadScale = Math.max(1e-9, config.entryRiseSpreadScaleUsd ?? 0.04);
    const sep = Math.max(0, config.entryRiseMinScoreSeparation ?? 0.25);

    let btcTilt = 0;
    const g = input.btcUsdDeltaFromWindowOpen;
    if (g != null && Number.isFinite(g)) {
        const mag = Math.max(0, Math.abs(g) - dead);
        if (mag > 0) {
            btcTilt = Math.sign(g) * Math.min(1, mag / btcScale);
        }
    }

    const vy = input.yesAskVelocityUsdPerSec;
    const vn = input.noAskVelocityUsdPerSec;
    const d = (vy ?? 0) - (vn ?? 0);
    const velTilt = Math.max(-1, Math.min(1, d / velScale));

    const spreadDelta = input.spreadNo - input.spreadYes;
    const spreadTilt = Math.max(-1, Math.min(1, spreadDelta / spreadScale));

    const tilt = btcW * btcTilt + velW * velTilt + sprW * spreadTilt;

    let side: 'YES' | 'NO' | null = null;
    if (tilt >= sep) side = 'YES';
    else if (tilt <= -sep) side = 'NO';

    const detail = `tilt=${tilt.toFixed(3)} btc=${btcTilt.toFixed(2)} vel=${velTilt.toFixed(2)} spr=${spreadTilt.toFixed(2)}`;
    return { side, tilt, detail };
}

/**
 * Combine BTC gap (vs window open), relative best-ask rise velocity (YES vs NO), and spread tightness
 * to infer which outcome’s ask is more likely to keep rising. Null = inconclusive (keep baseline side).
 */
export function predictLikelyRisingSide(
    config: StrategyConfig,
    input: EntryRiseSignalInput
): EntryRiseSignalResult {
    if (config.entryRiseSignalEnabled !== true) {
        return { side: null, tilt: 0, detail: 'entryRiseSignalEnabled=false' };
    }
    return evaluateLikelyRisingSideSignal(config, input);
}

/**
 * Min integer shares @ ask to move After PnL on `side` to target (used by final 30s one-sided FOK chase).
 */
export function sharesToReachOutcomeAfterPnlTarget(
    state: WindowState,
    side: 'YES' | 'NO',
    askPrice: number,
    targetUsd: number,
    strictAbove: boolean
): number {
    const p = askPrice;
    if (p <= 0 || p >= 1 || !Number.isFinite(p)) return 0;
    const o = 1 - p;
    // After PnL targets are evaluated net of modeled fees (totalSpentUsd is fee-inclusive).
    const S = state.totalSpentUsd;
    const y = state.qtyYes;
    const n = state.qtyNo;

    if (side === 'NO') {
        const cur = n - S;
        if (strictAbove) {
            if (cur > targetUsd) return 0;
            return Math.max(1, Math.floor((targetUsd - cur) / o) + 1);
        }
        if (cur >= targetUsd - SETTLEMENT_PNL_EPS) return 0;
        return Math.max(1, Math.ceil((targetUsd - cur) / o + 1e-9));
    }
    if (side === 'YES') {
        const cur = y - S;
        if (strictAbove) {
            if (cur > targetUsd) return 0;
            return Math.max(1, Math.floor((targetUsd - cur) / o) + 1);
        }
        if (cur >= targetUsd - SETTLEMENT_PNL_EPS) return 0;
        return Math.max(1, Math.ceil((targetUsd - cur) / o + 1e-9));
    }
    return 0;
}

/**
 * After a fill, dashboard "After PnL If Up/Down" are qtyYes/No − totalSpentUsd.
 * Used inside simulated sizing for **ladder Stock B** only (see `requiresMinDualAfterPnlForSimulatedBuy`).
 */
export function violatesDualLegSettlementGate(
    s: WindowState,
    minAfterPnlUsd: number = 0,
    strictAbove?: boolean
): boolean {
    if (s.qtyYes <= 0 || s.qtyNo <= 0) return false;
    const ap = afterPnlsFromState(s);
    // Gate is defined as net profit after modeled fees.
    const up = ap.afterPnlIfUp;
    const down = ap.afterPnlIfDown;
    if (up < SETTLEMENT_PNL_EPS || down < SETTLEMENT_PNL_EPS) return true;
    if (minAfterPnlUsd > 0) {
        if (strictAbove) {
            if (up <= minAfterPnlUsd || down <= minAfterPnlUsd) return true;
        } else if (up < minAfterPnlUsd || down < minAfterPnlUsd) {
            return true;
        }
    }
    return false;
}

/**
 * Settlement scenarios: gross PnL uses full cash spent; **excluding commission** uses notional spend
 * (`totalSpent −` tracked taker commission) — this is what `minDualAfterPnlUsd` / Stock B gates use.
 */
export function afterPnlsFromState(state: WindowState): {
    afterPnlIfUp: number;
    afterPnlIfDown: number;
    afterPnlIfUpExcludingCommission: number;
    afterPnlIfDownExcludingCommission: number;
    notionalSpentUsd: number;
    takerCommissionPaidUsd: number;
} {
    const spent = state.totalSpentUsd;
    const fee = state.takerCommissionPaidUsd ?? 0;
    const notional = spent - fee;
    return {
        afterPnlIfUp: state.qtyYes - spent,
        afterPnlIfDown: state.qtyNo - spent,
        afterPnlIfUpExcludingCommission: state.qtyYes - notional,
        afterPnlIfDownExcludingCommission: state.qtyNo - notional,
        notionalSpentUsd: notional,
        takerCommissionPaidUsd: fee,
    };
}

/**
 * After buying `shares` of `side` at `unitPrice`, return both After PnLs and the derived state.
 */
export function projectedAfterPnlsAfterBuy(
    state: WindowState,
    side: 'YES' | 'NO',
    shares: number,
    rawUnitPrice: number,
    config: StrategyConfig,
    fillLiquidity: OrderLiquidityRole = 'MAKER'
): { afterPnlIfUp: number; afterPnlIfDown: number; newState: WindowState } {
    const addedCost = buyBinaryOutcomeLegUsd(
        shares,
        rawUnitPrice,
        fillLiquidity,
        config.feeBips ?? 0,
        config.binaryOutcomeTakerFeeScalar ?? 0
    );
    const takerCommissionUsd = takerCommissionUsdForBinaryBuy(
        shares,
        rawUnitPrice,
        fillLiquidity,
        config.feeBips ?? 0,
        config.binaryOutcomeTakerFeeScalar ?? 0
    );
    const newState = updateWindowStateFromFill(state, side, shares, addedCost, {
        takerCommissionUsd,
    });
    const { afterPnlIfUp, afterPnlIfDown } = afterPnlsFromState(newState);
    return { afterPnlIfUp, afterPnlIfDown, newState };
}

/**
 * True iff both legs are held after the fill, both After PnLs are ≥ minDualAfterPnlUsd, and pair cost &lt; 1.
 */
export function isDualOutcomeProfitableFill(
    state: WindowState,
    side: 'YES' | 'NO',
    shares: number,
    rawUnitPrice: number,
    config: StrategyConfig,
    fillLiquidity: OrderLiquidityRole = 'TAKER'
): boolean {
    const minD = minDualAfterPnlUsd(config);
    const strictAbove = minDualAfterPnlStrictAbove(config);
    const { newState } = projectedAfterPnlsAfterBuy(
        state,
        side,
        shares,
        rawUnitPrice,
        config,
        fillLiquidity
    );
    if (newState.qtyYes <= 0 || newState.qtyNo <= 0) return false;
    const ap = afterPnlsFromState(newState);
    const pairCeil = pairCostCeiling(config);
    return (
        dualAfterPnlMeetsMin(
            ap.afterPnlIfUp,
            ap.afterPnlIfDown,
            minD,
            strictAbove
        ) &&
        newState.pairCost <= pairCeil + 1e-9 &&
        newState.pairCost < 1.0 - 1e-9
    );
}

/**
 * Max shares on this side without pushing the *other* outcome's After PnL below `minAfterPnlUsd`
 * (0 = same as legacy “below zero” only).
 * Only applies when both legs already have inventory; skipped one-sided.
 */
export function capClipByAfterPnlSlack(
    state: WindowState,
    side: 'YES' | 'NO',
    price: number,
    shares: number,
    orderMinSize: number,
    minAfterPnlUsd: number = 0
): number {
    if (price <= 0 || !Number.isFinite(price)) return shares;
    const y = state.qtyYes;
    const n = state.qtyNo;
    const S = state.totalSpentUsd;
    if (y <= 0 || n <= 0) return shares;

    /** Match `afterPnlsFromState` net-of-fee definition: qty − totalSpentUsd. */
    const slackUsd = side === 'YES' ? n - S - minAfterPnlUsd : y - S - minAfterPnlUsd;
    const maxS = Math.floor(Math.max(0, slackUsd) / price + 1e-9);
    if (maxS < orderMinSize) {
        return 0;
    }
    return Math.min(shares, maxS);
}

/**
 * Sizes a buy subject to CLOB minimum, dual After-PnL simulation on **hedge** paths, and **pair-cost ceiling
 * only on hedge legs** (not on Stock A).
 *
 * **Stock A** (empty-book entry, momentum / BTC-gap legs, stacking one-sided, balanced new rung, heavy-side adds):
 * no {@link pairCostCeiling} check — entries follow momentum without waiting for implied pair at the opposite side.
 *
 * **Pair cost** applies when {@link completingOneSidedHedgeLeg} (buy opposite outcome from one-sided) or when
 * `requiresMinDualAfterPnlForSimulatedBuy` on a **two-sided** book (lighter-leg parity hedge), or when
 * `forceDualAfterPnlEnforcement` (e.g. aggressive dual-PnL path). Pass **raw** price and {@link OrderLiquidityRole}
 * for fee-accurate simulation (`buyBinaryOutcomeLegUsd`).
 *
 * `bypassPairCostAndSettlement`: only CLOB $1 notional minimum (no pair / settlement simulation).
 */
export function clampBuySizeForSimulatedGates(
    state: WindowState,
    side: 'YES' | 'NO',
    price: number,
    initialSize: number,
    config: StrategyConfig,
    opts?: {
        bypassPairCostAndSettlement?: boolean;
        forceDualAfterPnlEnforcement?: boolean;
        /** Opposite best ask (fee-inclusive $/sh, taker). Used for empty-book gate when simulating a taker hedge or bid is unavailable. */
        oppositeAskAllInForFirstLegGate?: number;
        /**
         * Opposite outcome's **best bid** (raw $/sh). When the first leg is simulated as **MAKER** at bid, the
         * realistic paired entry is hedging at the opposite **bid** (not lift at ask). Using ask here made
         * `bid + oppositeAsk + fees` almost always exceed a tight pair ceiling and blocked all first entries.
         */
        oppositeBidForFirstLegGate?: number;
        /** How the simulated fill on `side` is priced for fees (maker = notional only in model). */
        simulatedFillLiquidity?: OrderLiquidityRole;
    }
): number {
    const minSize = Math.max(1, Math.floor(config.orderMinSize || 1));
    const CLOB_MIN_ORDER_USD = 1.0;
    let s = Math.floor(initialSize);
    const liq = opts?.simulatedFillLiquidity ?? 'MAKER';
    const feeBips = config.feeBips ?? 0;
    const feeScalar = config.binaryOutcomeTakerFeeScalar ?? 0;
    const legEffPerShare = (rawPx: number) =>
        buyBinaryOutcomeLegUsd(1, rawPx, liq, feeBips, feeScalar);

    /** Implied opposite $/sh for “can we pair under cap?” when the book is still empty. */
    const impliedOppositePerShareForEmptyBook = (): number | undefined => {
        const oppAsk = opts?.oppositeAskAllInForFirstLegGate;
        const oppBidRaw = opts?.oppositeBidForFirstLegGate;
        if (
            liq === 'MAKER' &&
            oppBidRaw != null &&
            oppBidRaw > 0 &&
            Number.isFinite(oppBidRaw)
        ) {
            return buyBinaryOutcomeLegUsd(1, oppBidRaw, 'MAKER', feeBips, feeScalar);
        }
        return oppAsk;
    };

    if (opts?.bypassPairCostAndSettlement) {
        while (s >= minSize) {
            if (price * s < CLOB_MIN_ORDER_USD) {
                s--;
                continue;
            }
            return s;
        }
        return 0;
    }

    const dualPriority = config.dualOutcomePurchasePriority !== false;
    const pairCeil = pairCostCeiling(config);
    const minD = minDualAfterPnlUsd(config);
    const strictAbove = minDualAfterPnlStrictAbove(config);
    const enforceDual =
        opts?.forceDualAfterPnlEnforcement === true || requiresMinDualAfterPnlForSimulatedBuy(state, side);

    const z0 = 1e-8;
    const y0 = state.qtyYes;
    const n0 = state.qtyNo;
    const oneSidedBefore = (y0 > z0 && n0 <= z0) || (n0 > z0 && y0 <= z0);
    const applyPairCost =
        opts?.forceDualAfterPnlEnforcement === true ||
        completingOneSidedHedgeLeg(state, side) ||
        (enforceDual && !oneSidedBefore);

    while (s >= minSize) {
        if (price * s < CLOB_MIN_ORDER_USD) {
            s--;
            continue;
        }
        const addedCost = buyBinaryOutcomeLegUsd(s, price, liq, feeBips, feeScalar);
        const commFill = takerCommissionUsdForBinaryBuy(s, price, liq, feeBips, feeScalar);
        const newState = updateWindowStateFromFill(state, side, s, addedCost, {
            takerCommissionUsd: commFill,
        });
        const z = 1e-8;
        const emptyBefore = state.qtyYes <= z && state.qtyNo <= z;
        const both = newState.qtyYes > 0 && newState.qtyNo > 0;
        if (!both) {
            if (emptyBefore) {
                if (applyPairCost) {
                    const oppImplied = impliedOppositePerShareForEmptyBook();
                    const ladder = config.pairLadderMatchEnabled === true;
                    if (ladder) {
                        if (oppImplied == null || !(oppImplied > 0) || !Number.isFinite(oppImplied)) {
                            s--;
                            continue;
                        }
                        if (legEffPerShare(price) + oppImplied > pairCeil + 1e-9) {
                            s--;
                            continue;
                        }
                    } else if (oppImplied != null && oppImplied > 0 && Number.isFinite(oppImplied)) {
                        if (legEffPerShare(price) + oppImplied > pairCeil + 1e-9) {
                            s--;
                            continue;
                        }
                    }
                }
                return s;
            }
            if (!enforceDual) return s;
            s--;
            continue;
        }

        const apSim = afterPnlsFromState(newState);
        const afterUp = apSim.afterPnlIfUp;
        const afterDown = apSim.afterPnlIfDown;

        if (enforceDual) {
            const dualOk = dualAfterPnlMeetsMin(afterUp, afterDown, minD, strictAbove);
            const settlementBad = violatesDualLegSettlementGate(newState, minD, strictAbove);
            const pairAboveCeiling = newState.pairCost > pairCeil + 1e-9;
            const pairAtOrAboveDollar = newState.pairCost >= 1.0 - 1e-9;

            if (
                dualPriority &&
                dualOk &&
                !settlementBad &&
                (!applyPairCost || (!pairAboveCeiling && !pairAtOrAboveDollar))
            ) {
                return s;
            }

            if (applyPairCost && (pairAboveCeiling || pairAtOrAboveDollar)) {
                s--;
                continue;
            }

            if (settlementBad) {
                s--;
                continue;
            }
            if (dualPriority && !dualOk) {
                s--;
                continue;
            }
            return s;
        }

        // Stock A with both legs after fill: pair-cost only when completing the one-sided hedge.
        if (!completingOneSidedHedgeLeg(state, side) || newState.pairCost <= pairCeil + 1e-9) {
            return s;
        }
        s--;
    }
    return 0;
}

/** Simulate state after buying deltaQty at price on side */
function simulateState(
    state: WindowState,
    side: 'YES' | 'NO',
    deltaQty: number,
    rawPrice: number,
    config: StrategyConfig,
    fillLiquidity: OrderLiquidityRole
): { newPairCost: number; newState: WindowState } {
    const feeBips = config.feeBips ?? 0;
    const feeScalar = config.binaryOutcomeTakerFeeScalar ?? 0;
    const addedCost = buyBinaryOutcomeLegUsd(
        deltaQty,
        rawPrice,
        fillLiquidity,
        feeBips,
        feeScalar
    );
    const comm = takerCommissionUsdForBinaryBuy(
        deltaQty,
        rawPrice,
        fillLiquidity,
        feeBips,
        feeScalar
    );
    const newState = updateWindowStateFromFill(state, side, deltaQty, addedCost, {
        takerCommissionUsd: comm,
    });
    return { newPairCost: newState.pairCost, newState };
}

/** Min |Down bid − Up bid| (Down favored) or |Up − Down| (Up favored) for directional skew entry. */
export const DIRECTIONAL_SKEW_MIN_BID_SPREAD = 0.22;

/** BTC/USD move vs window open: Down skew needs ≤ −this; Up skew needs ≥ +this. */
export const DIRECTIONAL_SKEW_BTC_USD_THRESHOLD = 18;

/** Target extra shares on the favored leg vs the other (e.g. Down ≈ Up + edge). */
export const DIRECTIONAL_SKEW_SHARE_EDGE = 4;

function directionalSkewBtcOkForDown(
    btcUsdDeltaFromWindowOpen: number | null | undefined,
    thresholdUsd: number
): boolean {
    if (btcUsdDeltaFromWindowOpen === undefined) return true;
    if (btcUsdDeltaFromWindowOpen === null || !Number.isFinite(btcUsdDeltaFromWindowOpen))
        return false;
    return btcUsdDeltaFromWindowOpen <= -thresholdUsd;
}

function directionalSkewBtcOkForUp(
    btcUsdDeltaFromWindowOpen: number | null | undefined,
    thresholdUsd: number
): boolean {
    if (btcUsdDeltaFromWindowOpen === undefined) return true;
    if (btcUsdDeltaFromWindowOpen === null || !Number.isFinite(btcUsdDeltaFromWindowOpen))
        return false;
    return btcUsdDeltaFromWindowOpen >= thresholdUsd;
}

/**
 * When spot is materially down/up vs window open AND the orderbook favors Down/Up by a min bid spread,
 * and inventory is short the favored leg, buy that leg toward ~(larger leg + shareEdge).
 * Size uses ladder rules in `clampBuySizeForSimulatedGates` (dual After PnL floor only on hedge leg). Maker @ best bid.
 * Returns null when rule does not apply.
 */
export function buildDirectionalSkewInventoryDecision(
    config: StrategyConfig,
    state: WindowState,
    bookYes: OrderBookSnapshot,
    bookNo: OrderBookSnapshot,
    ctx: {
        btcUsdDeltaFromWindowOpen?: number | null;
    }
): StrategyDecision | null {
    const minSpread = config.directionalSkewMinBidSpread ?? DIRECTIONAL_SKEW_MIN_BID_SPREAD;
    const btcTh = config.directionalSkewBtcUsdThreshold ?? DIRECTIONAL_SKEW_BTC_USD_THRESHOLD;
    const shareEdge = config.directionalSkewShareEdge ?? DIRECTIONAL_SKEW_SHARE_EDGE;
    const tickSize = config.tickSize || 0.01;
    const CLOB_MIN_ORDER_USD = 1.0;
    const bestBidYes = bookYes.bids && bookYes.bids.length > 0 ? bookYes.bids[0] : undefined;
    const bestBidNo = bookNo.bids && bookNo.bids.length > 0 ? bookNo.bids[0] : undefined;
    const bestAskYes = bookYes.asks && bookYes.asks.length > 0 ? bookYes.asks[0] : undefined;
    const bestAskNo = bookNo.asks && bookNo.asks.length > 0 ? bookNo.asks[0] : undefined;
    if (!bestBidYes || !bestBidNo || !bestAskYes || !bestAskNo) return null;

    const yesBidPrice = roundToTick(bestBidYes.price, tickSize);
    const noBidPrice = roundToTick(bestBidNo.price, tickSize);
    const yesAskPrice = roundToTick(bestAskYes.price, tickSize);
    const noAskPrice = roundToTick(bestAskNo.price, tickSize);
    if (yesBidPrice >= yesAskPrice || noBidPrice >= noAskPrice) return null;

    const btcD = ctx.btcUsdDeltaFromWindowOpen;
    const minSz = Math.max(1, Math.floor(config.orderMinSize || 1));

    let side: 'YES' | 'NO' | null = null;
    let rawWant = 0;

    if (
        noBidPrice - yesBidPrice + 1e-9 >= minSpread &&
        state.qtyNo + QTY_EPS < state.qtyYes &&
        directionalSkewBtcOkForDown(btcD, btcTh)
    ) {
        rawWant = Math.floor(state.qtyYes + shareEdge - state.qtyNo);
        if (rawWant > 0) side = 'NO';
    }

    if (
        side === null &&
        yesBidPrice - noBidPrice + 1e-9 >= minSpread &&
        state.qtyYes + QTY_EPS < state.qtyNo &&
        directionalSkewBtcOkForUp(btcD, btcTh)
    ) {
        rawWant = Math.floor(state.qtyNo + shareEdge - state.qtyYes);
        if (rawWant > 0) side = 'YES';
    }

    if (side === null || rawWant <= 0) return null;

    const price = side === 'YES' ? yesBidPrice : noBidPrice;
    const tokenId = side === 'YES' ? bookYes.tokenId : bookNo.tokenId;
    let size = Math.max(rawWant, minSz);
    const slackMin = requiresMinDualAfterPnlForSimulatedBuy(state, side)
        ? effectiveMinDualForSlackUsd(config)
        : 0;
    size = capClipByAfterPnlSlack(state, side, price, size, minSz, slackMin);
    const zSk = 1e-8;
    const emptySk = state.qtyYes <= zSk && state.qtyNo <= zSk;
    const oppAskSk = emptySk ? oppositeAskAllInForSide(side, bookYes, bookNo, config) : undefined;
    const oppBidSk = emptySk ? (side === 'YES' ? noBidPrice : yesBidPrice) : undefined;
    size = clampBuySizeForSimulatedGates(state, side, price, size, config, {
        oppositeAskAllInForFirstLegGate: oppAskSk,
        oppositeBidForFirstLegGate: oppBidSk,
        simulatedFillLiquidity: 'MAKER',
    });
    if (size <= 0 || price * size < CLOB_MIN_ORDER_USD) return null;

    const { newPairCost } = simulateState(state, side, size, price, config, 'MAKER');
    const spotNote =
        btcD === undefined || btcD === null || !Number.isFinite(btcD)
            ? 'BTCΔ=n/a'
            : `BTCΔ$${btcD.toFixed(1)}`;

    return {
        action: side === 'YES' ? 'BUY_YES' : 'BUY_NO',
        tokenId,
        price,
        size,
        reason:
            `DIR_SKEW ${side} +${size} @ bid $${price.toFixed(4)} → ~${side === 'NO' ? 'Down' : 'Up'} ` +
            `${shareEdge} ahead | ${spotNote} | bidSpread Down−Up $${(noBidPrice - yesBidPrice).toFixed(2)} ` +
            `pairCost→$${newPairCost.toFixed(4)}`,
        simulatedPairCost: newPairCost,
    };
}

/** Round price to tick size */
function roundToTick(price: number, tickSize: number): number {
    if (tickSize <= 0) return price;
    return Math.round(price / tickSize) * tickSize;
}

const QTY_EPS = 1e-8;

/**
 * In the last N seconds (finalOneSidedHedgeSeconds), or when bypassFinalTimeWindow (momentum flip):
 * if strictly one-sided, buy the opposite leg at best ask (FOK). Size is reduced if needed so that
 * after the fill both After PnL If Up/Down are ≥ minDualAfterPnlUsd, pair cost &lt; 1, and
 * pair cost ≤ min(safetyMargin, targetPairCostMax) using **taker all-in** $/share (fee scalar).
 */
export function buildFinalOneSidedHedgeDecision(
    config: StrategyConfig,
    state: WindowState,
    bookYes: OrderBookSnapshot,
    bookNo: OrderBookSnapshot,
    secondsLeft: number,
    ctx?: { btcUsdDeltaFromWindowOpen?: number | null; bypassFinalTimeWindow?: boolean }
): StrategyDecision | null {
    const absCut = config.absoluteNoOrderSeconds ?? 2;
    const finalSec = config.finalOneSidedHedgeSeconds ?? 30;
    if (secondsLeft <= absCut) return null;
    if (!ctx?.bypassFinalTimeWindow && secondsLeft > finalSec) return null;

    const yesOnly = state.qtyYes > QTY_EPS && state.qtyNo <= QTY_EPS;
    const noOnly = state.qtyNo > QTY_EPS && state.qtyYes <= QTY_EPS;
    if (!yesOnly && !noOnly) return null;

    const side: 'YES' | 'NO' = yesOnly ? 'NO' : 'YES';
    const sharesTarget = Math.floor(yesOnly ? state.qtyYes : state.qtyNo);
    if (sharesTarget < 1) {
        return {
            action: 'HOLD',
            tokenId: '',
            price: 0,
            size: 0,
            reason: 'Final hedge: filled leg < 1 share',
        };
    }

    const tickSize = config.tickSize || 0.01;
    const bestAskLevel = side === 'YES' ? bookYes.asks?.[0] : bookNo.asks?.[0];
    if (!bestAskLevel || bestAskLevel.price <= 0) {
        return {
            action: 'HOLD',
            tokenId: '',
            price: 0,
            size: 0,
            reason: 'Final hedge: no ask on opposite leg',
        };
    }
    const price = roundToTick(bestAskLevel.price, tickSize);
    const pairCeil = pairCostCeiling(config);

    const minD = minDualAfterPnlUsd(config);
    const strictAbove = minDualAfterPnlStrictAbove(config);
    const minSize = Math.max(1, Math.floor(config.orderMinSize || 1));
    const pairLadderOn = config.pairLadderMatchEnabled === true;
    const cfgPairClipMin = Math.floor(
        pairLadderOn ? (config.pairStockARandomSharesMin ?? 25) : 1
    );
    const floorClip = pairLadderOn ? Math.max(minSize, cfgPairClipMin) : minSize;
    let size = Math.max(sharesTarget, pairLadderOn ? floorClip : sharesTarget);
    while (size >= floorClip) {
        const { newState } = projectedAfterPnlsAfterBuy(state, side, size, price, config, 'TAKER');
        const apFin = afterPnlsFromState(newState);
        if (
            newState.qtyYes > 0 &&
            newState.qtyNo > 0 &&
            dualAfterPnlMeetsMin(
                apFin.afterPnlIfUpExcludingCommission,
                apFin.afterPnlIfDownExcludingCommission,
                minD,
                strictAbove
            ) &&
            newState.pairCost < 1.0 - 1e-9 &&
            newState.pairCost <= pairCeil + 1e-9
        ) {
            const { newPairCost } = simulateState(state, side, size, price, config, 'TAKER');
            const tokenId = side === 'YES' ? bookYes.tokenId : bookNo.tokenId;
            const tag = ctx?.bypassFinalTimeWindow ? 'Momentum flip hedge' : 'Final one-sided hedge';
            const cmp = strictAbove ? '>' : '≥';
            const reason =
                `${tag}: ${size} ${side} @ ask $${price.toFixed(2)} (both P/L ex-commission ${cmp} $${minD.toFixed(2)}; pairCost→${newPairCost.toFixed(4)}; ${secondsLeft}s left)`;
            return {
                action: side === 'YES' ? 'BUY_YES' : 'BUY_NO',
                tokenId,
                price,
                size,
                reason,
                simulatedPairCost: newPairCost,
            };
        }
        size--;
    }

    return {
        action: 'HOLD',
        tokenId: '',
        price: 0,
        size: 0,
        reason: `Final hedge: no size from ${sharesTarget}→${floorClip} keeps both P/L ex-commission ≥ $${minD.toFixed(2)}, pair < 1, pair ≤ $${pairCeil.toFixed(4)} (all-in @ ask)${
            pairLadderOn ? `, clip ≥ ${floorClip}` : ''
        }`,
    };
}

/**
 * Decide next action: BUY_YES, BUY_NO, or HOLD — same reference logic as HedgeBot.
 * Maker @ best bid; tilt + parity + forced switch; clip ladder.
 */
export function decide(
    config: StrategyConfig,
    state: WindowState,
    bookYes: OrderBookSnapshot,
    bookNo: OrderBookSnapshot,
    excludeSide?: 'YES' | 'NO',
    ctx?: StrategyDecisionContext
): StrategyDecision {
    const tickSize = config.tickSize || 0.01;
    const CLOB_MIN_ORDER_USD = 1.0;

    const bestBidYes = bookYes.bids && bookYes.bids.length > 0 ? bookYes.bids[0] : undefined;
    const bestBidNo = bookNo.bids && bookNo.bids.length > 0 ? bookNo.bids[0] : undefined;
    const bestAskYes = bookYes.asks && bookYes.asks.length > 0 ? bookYes.asks[0] : undefined;
    const bestAskNo = bookNo.asks && bookNo.asks.length > 0 ? bookNo.asks[0] : undefined;

    if (!bestBidYes || !bestBidNo) {
        return {
            action: 'HOLD',
            tokenId: '',
            price: 0,
            size: 0,
            reason:
                `No bid liquidity. YES bid: ${bestBidYes ? '$' + bestBidYes.price.toFixed(2) : 'none'}, ` +
                `NO bid: ${bestBidNo ? '$' + bestBidNo.price.toFixed(2) : 'none'}`,
        };
    }

    if (!bestAskYes || !bestAskNo) {
        return {
            action: 'HOLD',
            tokenId: '',
            price: 0,
            size: 0,
            reason:
                `No ask liquidity (market inactive). YES ask: ${bestAskYes ? '$' + bestAskYes.price.toFixed(2) : 'none'}, ` +
                `NO ask: ${bestAskNo ? '$' + bestAskNo.price.toFixed(2) : 'none'}`,
        };
    }

    // Do not short-circuit when pairCost >= 1 with both legs held: further maker clips can still
    // improve the blended average (or satisfy dual-outcome / ceiling rules). Per-fill gates live in
    // clampBuySizeForSimulatedGates; if no size passes, we HOLD below with an explicit reason.

    const yesBidPrice = roundToTick(bestBidYes.price, tickSize);
    const noBidPrice = roundToTick(bestBidNo.price, tickSize);
    const yesAskPrice = roundToTick(bestAskYes.price, tickSize);
    const noAskPrice = roundToTick(bestAskNo.price, tickSize);

    if (yesBidPrice >= yesAskPrice || noBidPrice >= noAskPrice) {
        return {
            action: 'HOLD',
            tokenId: '',
            price: 0,
            size: 0,
            reason:
                `Crossed book: YES bid=$${yesBidPrice.toFixed(2)} ask=$${yesAskPrice.toFixed(2)}, ` +
                `NO bid=$${noBidPrice.toFixed(2)} ask=$${noAskPrice.toFixed(2)}`,
        };
    }

    // Note: no hard gate on (yesBid + noBid); reference wallet traded in both regimes.
    const combined = yesBidPrice + noBidPrice;

    const windowSec = btcWindowDurationSec(config);
    const secondsLeft = ctx?.secondsLeft ?? defaultSecondsLeftForDemo(config);
    const elapsed = Math.max(0, windowSec - secondsLeft);
    if (elapsed < effectiveWarmupSeconds(config, windowSec)) {
        const w = effectiveWarmupSeconds(config, windowSec);
        return {
            action: 'HOLD',
            tokenId: '',
            price: 0,
            size: 0,
            reason: `Warmup: elapsed ${elapsed}s < ${w}s`,
        };
    }

    const finalHedge = buildFinalOneSidedHedgeDecision(
        config,
        state,
        bookYes,
        bookNo,
        secondsLeft,
        {
            btcUsdDeltaFromWindowOpen: ctx?.btcUsdDeltaFromWindowOpen,
        }
    );
    if (finalHedge !== null) return finalHedge;

    const rounds = ctx?.roundsThisWindow ?? 0;
    const lastSide = ctx?.lastExecutedSide ?? null;

    const skewOn = config.directionalSkewEnabled !== false;
    const skewDecision = skewOn
        ? buildDirectionalSkewInventoryDecision(config, state, bookYes, bookNo, {
              btcUsdDeltaFromWindowOpen: ctx?.btcUsdDeltaFromWindowOpen,
          })
        : null;
    if (skewDecision !== null) return skewDecision;

    let side = referencePickBuySide(state, yesBidPrice, noBidPrice, rounds, lastSide, config, {
        secondsLeft,
        windowSec,
    });
    if (excludeSide === side) {
        side = side === 'YES' ? 'NO' : 'YES';
    }

    const price = side === 'YES' ? yesBidPrice : noBidPrice;
    const tokenId = side === 'YES' ? bookYes.tokenId : bookNo.tokenId;
    const ladder = buildSizeLadderFromConfig(config);
    let size = referencePickClipSize(state, price, secondsLeft, windowSec, config, ladder, {
        availableBalanceUsd: ctx?.availableBalanceUsd,
    });
    size = Math.max(size, config.orderMinSize || 1);
    const minSz = Math.max(1, Math.floor(config.orderMinSize || 1));
    const slackMin = requiresMinDualAfterPnlForSimulatedBuy(state, side)
        ? effectiveMinDualForSlackUsd(config)
        : 0;
    size = capClipByAfterPnlSlack(state, side, price, size, minSz, slackMin);
    const zPar = 1e-8;
    if (
        state.qtyYes <= zPar ||
        state.qtyNo <= zPar ||
        requiresMinDualAfterPnlForSimulatedBuy(state, side)
    ) {
        size = capClipForSettlementQtyParity(state, side, size, minSz);
    }

    // Late-window parity: don't overshoot the hedge leg when we're just trying to balance.
    const diff = Math.abs(state.qtyYes - state.qtyNo);
    if (
        inStopTradingSecondsBeforeEndWindow(secondsLeft, config.stopTradingSecondsBeforeEnd) &&
        diff > 0 &&
        requiresMinDualAfterPnlForSimulatedBuy(state, side)
    ) {
        size = Math.min(size, diff);
    }

    const zEm = 1e-8;
    const emptyDecide = state.qtyYes <= zEm && state.qtyNo <= zEm;
    const oppAskDecide = emptyDecide ? oppositeAskAllInForSide(side, bookYes, bookNo, config) : undefined;
    const oppBidDecide = emptyDecide ? (side === 'YES' ? noBidPrice : yesBidPrice) : undefined;
    size = clampBuySizeForSimulatedGates(state, side, price, size, config, {
        oppositeAskAllInForFirstLegGate: oppAskDecide,
        oppositeBidForFirstLegGate: oppBidDecide,
        simulatedFillLiquidity: 'MAKER',
    });

    if (size <= 0 || price * size < CLOB_MIN_ORDER_USD) {
        const minD = minDualAfterPnlUsd(config);
        const hedgeLeg = requiresMinDualAfterPnlForSimulatedBuy(state, side);
        return {
            action: 'HOLD',
            tokenId: '',
            price: 0,
            size: 0,
            reason:
                size <= 0
                    ? hedgeLeg
                        ? `No clip satisfies pair cost + ladder hedge (both After PnL ≥ $${minD.toFixed(2)} after fill)`
                        : `No clip satisfies Stock A gates (CLOB $1 / orderMin / dual simulation only — pair cap not applied)`
                    : `Clip size ${size} @ $${price.toFixed(4)} below CLOB $1`,
        };
    }

    const { newPairCost } = simulateState(state, side, size, price, config, 'MAKER');

    return {
        action: side === 'YES' ? 'BUY_YES' : 'BUY_NO',
        tokenId,
        price,
        size,
        reason: `REFERENCE ${side} ${size}@$${price.toFixed(4)} pairCost→$${newPairCost.toFixed(4)} sum=$${combined.toFixed(4)}`,
        simulatedPairCost: newPairCost,
    };
}

/**
 * Build orderbook snapshot from CLOB orderbook response (bids/asks arrays with price, size).
 */
export function orderBookFromClob(
    tokenId: string,
    side: 'YES' | 'NO',
    bids: Array<{ price: string | number; size: string | number }>,
    asks: Array<{ price: string | number; size: string | number }>
): OrderBookSnapshot {
    const toLevel = (p: { price: string | number; size: string | number }): OrderBookLevel => ({
        price: typeof p.price === 'string' ? parseFloat(p.price) : p.price,
        size: typeof p.size === 'string' ? parseFloat(p.size) : p.size,
    });
    const bidLevels = (bids || []).map(toLevel).filter((l) => l.price > 0 && l.size > 0);
    const askLevels = (asks || []).map(toLevel).filter((l) => l.price > 0 && l.size > 0);
    // Sort: bids descending, asks ascending
    bidLevels.sort((a, b) => b.price - a.price);
    askLevels.sort((a, b) => a.price - b.price);
    return {
        tokenId,
        side,
        bids: bidLevels,
        asks: askLevels,
        bestBid: bidLevels.length > 0 ? bidLevels[0].price : undefined,
        bestAsk: askLevels.length > 0 ? askLevels[0].price : undefined,
    };
}
