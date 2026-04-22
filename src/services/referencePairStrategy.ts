/**
 * Reference-wallet pair strategy (5m / 15m): single source of truth for side + clip sizing.
 * Used by HedgeBot and by hedgeStrategy.decide for demos/backtests.
 */

import type { StrategyConfig, WindowState } from '../interfaces/strategyInterfaces';
import { btcWindowDurationSec } from './marketDiscovery';

export type EntryDirectionReason =
    | 'PARITY_REBALANCE'
    | 'INVENTORY_IMBALANCE'
    | 'MARKET_TILT'
    | 'CHEAPER_BID_FALLBACK'
    | 'FORCED_SWITCH';

export interface EntryDirectionDecision {
    side: 'YES' | 'NO';
    reason: EntryDirectionReason;
    imbalanceShares: number;
    marketTilt: number;
    forcedSwitchApplied: boolean;
}

/**
 * Seconds after the window start before placing orders (0 = trade on the first eligible tick at open).
 * Uses `windowEntryWarmupSeconds`; if unset on a raw partial config, falls back to legacy `pairTiltMinElapsedSeconds`
 * (that field was historically overloaded for this gate — see `loadStrategyConfig` migration).
 */
export function effectiveWarmupSeconds(config: StrategyConfig, windowSec: number): number {
    const cap = Math.max(8, Math.floor(windowSec * 0.35));
    const w =
        config.windowEntryWarmupSeconds !== undefined && config.windowEntryWarmupSeconds !== null
            ? config.windowEntryWarmupSeconds
            : (config.pairTiltMinElapsedSeconds ?? 0);
    const raw = Math.max(0, Math.floor(w));
    return Math.min(raw, cap);
}

/** Ascending clip ladder from config. */
export function buildSizeLadderFromConfig(config: StrategyConfig): number[] {
    const configured = (config.sizeLadderShares || [])
        .map((v) => Math.max(0, Math.floor(v)))
        .filter((v) => v > 0);
    const fallback = [2, 8, 20, 35, Math.floor(config.maxClipShares ?? 54)];
    const base = (configured.length > 0 ? configured : fallback).sort((a, b) => a - b);
    const unique: number[] = [];
    for (const s of base) if (unique.length === 0 || unique[unique.length - 1] !== s) unique.push(s);
    return unique;
}

export function referencePickBuySide(
    state: WindowState,
    bestBidYes: number,
    bestBidNo: number,
    roundsThisWindow: number,
    lastExecutedSide: 'YES' | 'NO' | null,
    config: StrategyConfig,
    ctx?: { secondsLeft?: number; windowSec?: number }
): 'YES' | 'NO' {
    return explainReferenceBuySide(state, bestBidYes, bestBidNo, roundsThisWindow, lastExecutedSide, config, ctx).side;
}

export function explainReferenceBuySide(
    state: WindowState,
    bestBidYes: number,
    bestBidNo: number,
    roundsThisWindow: number,
    lastExecutedSide: 'YES' | 'NO' | null,
    config: StrategyConfig,
    ctx?: { secondsLeft?: number; windowSec?: number }
): EntryDirectionDecision {
    const eps = config.marketTiltEpsilon ?? 0.02;
    const imbTh = config.pairTiltImbalanceShares ?? 10;
    const G = state.qtyYes - state.qtyNo;
    let side: 'YES' | 'NO';
    let reason: EntryDirectionReason = 'CHEAPER_BID_FALLBACK';
    let forcedSwitchApplied = false;

    // End-of-window behavior in the reference wallet data:
    // intervals finish holding BOTH sides (no one-sided leftovers).
    // So late in the window we prioritize rebalancing to parity over tilt.
    const secondsLeft = ctx?.secondsLeft;
    const windowSec = ctx?.windowSec;
    if (
        typeof secondsLeft === 'number' &&
        typeof windowSec === 'number' &&
        secondsLeft <= Math.max(15, Math.min(config.stopTradingSecondsBeforeEnd ?? 120, Math.floor(windowSec * 0.5))) &&
        state.qtyYes !== state.qtyNo
    ) {
        side = G < 0 ? 'YES' : 'NO';
        return {
            side,
            reason: 'PARITY_REBALANCE',
            imbalanceShares: G,
            marketTilt: bestBidYes - bestBidNo,
            forcedSwitchApplied: false,
        };
    }

    if (Math.abs(G) >= imbTh) {
        side = G < 0 ? 'YES' : 'NO';
        reason = 'INVENTORY_IMBALANCE';
    } else {
        const upTilt = bestBidYes > bestBidNo + eps;
        const downTilt = bestBidNo > bestBidYes + eps;
        if (upTilt && !downTilt) {
            side = 'YES';
            reason = 'MARKET_TILT';
        } else if (downTilt && !upTilt) {
            side = 'NO';
            reason = 'MARKET_TILT';
        } else {
            side = bestBidYes <= bestBidNo ? 'YES' : 'NO';
            reason = 'CHEAPER_BID_FALLBACK';
        }
    }

    const switchEvery = config.forcedSwitchEveryNOrders ?? 4;
    // Do not override inventory parity: switching to the other leg while imbalanced
    // increases After PnL If Up vs Down separation (qtyYes − qtyNo).
    if (
        switchEvery > 0 &&
        roundsThisWindow > 0 &&
        roundsThisWindow % switchEvery === 0 &&
        lastExecutedSide &&
        Math.abs(G) < imbTh
    ) {
        side = lastExecutedSide === 'YES' ? 'NO' : 'YES';
        reason = 'FORCED_SWITCH';
        forcedSwitchApplied = true;
    }
    return {
        side,
        reason,
        imbalanceShares: G,
        marketTilt: bestBidYes - bestBidNo,
        forcedSwitchApplied,
    };
}

/**
 * Cap clip size so we do not buy more of the "light" leg than needed to match the heavy leg.
 * After PnL If Up − After PnL If Down = qtyYes − qtyNo (same totalSpent), so matching share counts
 * keeps both settlement outcomes similarly profitable.
 */
export function capClipForSettlementQtyParity(
    state: WindowState,
    side: 'YES' | 'NO',
    shares: number,
    orderMinSize: number,
    opts?: { firstOppositeLegExtraShares?: number }
): number {
    const y = state.qtyYes;
    const n = state.qtyNo;
    const G = y - n;
    const extra = Math.max(0, Math.floor(opts?.firstOppositeLegExtraShares ?? 0));

    let maxAdd = Number.POSITIVE_INFINITY;
    if (y <= 0 && n <= 0) {
        maxAdd = Number.POSITIVE_INFINITY;
    } else if (y > 0 && n <= 0) {
        maxAdd = side === 'NO' ? Math.floor(y) + extra : 0;
    } else if (n > 0 && y <= 0) {
        maxAdd = side === 'YES' ? Math.floor(n) + extra : 0;
    } else {
        if (G === 0) {
            maxAdd = Number.POSITIVE_INFINITY;
        } else if (side === 'YES') {
            maxAdd = G < 0 ? Math.floor(-G) : 0;
        } else {
            maxAdd = G > 0 ? Math.floor(G) : 0;
        }
    }

    if (!Number.isFinite(maxAdd) || maxAdd >= shares) {
        return shares;
    }

    let capped = Math.min(shares, maxAdd);
    if (capped <= 0) {
        return 0;
    }
    if (capped < orderMinSize) {
        if (maxAdd > 0) {
            return Math.min(shares, orderMinSize);
        }
        return 0;
    }
    return capped;
}

export function referencePickClipSize(
    state: WindowState,
    currentBid: number,
    secondsLeft: number,
    windowSec: number,
    config: StrategyConfig,
    ladder: number[],
    opts?: { availableBalanceUsd?: number }
): number {
    const maxClip = Math.max(1, Math.floor(config.maxClipShares ?? 54));
    const remainingBudget = Math.max(0, config.maxPositionPerWindowUsd - state.totalSpentUsd);
    const maxByBudget = currentBid > 0 ? Math.floor(remainingBudget / currentBid) : 0;

    let shareCapFromUsd: number | null = null;
    if (currentBid > 0 && config.maxSingleOrderUsd != null && config.maxSingleOrderUsd > 0) {
        shareCapFromUsd = Math.floor(config.maxSingleOrderUsd / currentBid);
    }
    const bal = opts?.availableBalanceUsd;
    const frac = config.orderSpendBalanceFraction;
    if (
        currentBid > 0 &&
        bal != null &&
        bal > 0 &&
        frac != null &&
        frac > 0
    ) {
        const fromBal = Math.floor((bal * frac) / currentBid);
        shareCapFromUsd = shareCapFromUsd != null ? Math.min(shareCapFromUsd, fromBal) : fromBal;
    }
    const maxBySingleOrder = shareCapFromUsd != null ? shareCapFromUsd : maxClip;

    const hardCap = Math.max(0, Math.min(maxClip, maxByBudget, maxBySingleOrder));
    if (hardCap <= 0) return 0;

    const elapsed = Math.max(0, windowSec - secondsLeft);
    const warmup = effectiveWarmupSeconds(config, windowSec);
    // Bias toward large clips; ramp to max size sooner, taper only in the last fraction of the window.
    const rampFrac = config.clipRampExtraFraction ?? 0.08;
    const tailFrac = config.clipTailFraction ?? 0.15;
    const rampEnd = warmup + Math.floor(windowSec * rampFrac);
    const tailSec = Math.max(20, Math.floor(windowSec * tailFrac));
    const big = ladder[Math.max(0, ladder.length - 1)] ?? maxClip;
    const small = ladder[0] ?? 5;
    const mid = ladder[Math.floor(Math.max(0, ladder.length - 1) / 2)] ?? Math.floor((small + big) / 2);

    let pick: number;
    if (elapsed < rampEnd) pick = mid;
    else if (secondsLeft > tailSec) pick = big;
    else pick = Math.max(small, Math.floor(big * 0.65));

    let shares = Math.min(hardCap, pick);
    if (currentBid > 0 && shares * currentBid < 1.0) {
        shares = Math.max(shares, Math.ceil(1.0 / currentBid));
    }
    return Math.min(shares, hardCap);
}

/** Default timing when demos do not pass a live clock (mid-window). */
export function defaultSecondsLeftForDemo(config: StrategyConfig): number {
    return Math.floor(btcWindowDurationSec(config) / 2);
}
