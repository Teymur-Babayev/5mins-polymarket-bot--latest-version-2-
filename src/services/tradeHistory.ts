/**
 * Paper-trading history: records every simulated order and per-window P&L
 * for the dashboard "Trading History" page. Used when liveTrading is false.
 */

import type { SettlementWinnerSource } from './btcUpDownSettlement';
import type { OrderLiquidityRole } from '../utils/polymarketFees';

export interface RecordedOrder {
    id: string;
    timestamp: string;
    windowSlug: string;
    windowEndIso: string;
    side: 'YES' | 'NO';
    sideLabel: string;
    price: number;
    size: number;
    costUsd: number;
    /** MAKER = limit bid resting fill (no taker fee); TAKER = FOK / ask / instant (Polymarket taker fee). */
    liquidity?: OrderLiquidityRole;
    roundInWindow: number;
    /** Filled in at window resolution */
    winnerSide?: 'YES' | 'NO';
    /** Per-order realized P/L at resolution (ignores fees): +size*(1-price) if winner, else -size*price */
    realizedPnlUsd?: number;
}

export interface CompletedWindowDetail {
    windowSlug: string;
    windowEndIso: string;
    /** 5 or 15 — which BTC up/down series this window belongs to */
    btcMarketWindowMinutes?: 5 | 15;
    windowStartedAt: string;
    windowEndedAt: string;
    orderCount: number;
    orders: RecordedOrder[];
    totalSpentUsd: number;
    costYes: number;
    costNo: number;
    qtyYes: number;
    qtyNo: number;
    pairCost: number;
    lockedProfit: number;
    feeEstimate: number;
    /** Realized net P/L including winning payout and fee estimate */
    netProfit: number;
    payoutReceived: number;
    /** Which outcome won (YES=Up, NO=Down) */
    winnerSide: 'YES' | 'NO' | 'UNKNOWN';
    /** BTC/USD at window start (Binance), snapshot at settlement */
    btcUsdWindowOpen?: number | null;
    /** BTC/USD at window end (Binance), snapshot at settlement */
    btcUsdWindowEnd?: number | null;
    /** How `winnerSide` was chosen */
    settlementWinnerSource?: SettlementWinnerSource;
    /** Balance after applying payout and fees (paper mode) */
    balanceAfterUsd: number;
}

let simulatedBalanceUsd = 0;
let balanceInitialized = false;
/** Session open balance — used to derive per-window Balance = start + cumulative netProfit (always matches Net P/L column). */
let sessionStartingBalanceUsd = 0;
const orders: RecordedOrder[] = [];
const completedWindowsDetail: CompletedWindowDetail[] = [];
let orderIdCounter = 0;

function nextId(): string {
    orderIdCounter += 1;
    return `paper-${Date.now()}-${orderIdCounter}`;
}

/** Initialize simulated balance (call once when bot starts in paper mode). */
export function initSimulatedBalance(startingUsd: number): void {
    if (!balanceInitialized) {
        simulatedBalanceUsd = startingUsd;
        sessionStartingBalanceUsd = startingUsd;
        balanceInitialized = true;
    }
}

/** Reset for a new session (e.g. when restarting bot). */
export function resetPaperSession(startingUsd: number): void {
    simulatedBalanceUsd = startingUsd;
    sessionStartingBalanceUsd = startingUsd;
    balanceInitialized = true;
    orders.length = 0;
    completedWindowsDetail.length = 0;
}

/** Get current simulated balance. */
export function getSimulatedBalance(): number {
    return simulatedBalanceUsd;
}

/** Starting USDC for the current paper session (after resetPaperSession / initSimulatedBalance). */
export function getPaperSessionStartingBalanceUsd(): number {
    return sessionStartingBalanceUsd;
}

/** Record a simulated buy (paper fill). Deducts cost from balance. */
export function recordOrder(params: {
    windowSlug: string;
    windowEndIso: string;
    side: 'YES' | 'NO';
    price: number;
    size: number;
    costUsd: number;
    roundInWindow: number;
    liquidity?: OrderLiquidityRole;
}): void {
    const order: RecordedOrder = {
        id: nextId(),
        timestamp: new Date().toISOString(),
        windowSlug: params.windowSlug,
        windowEndIso: params.windowEndIso,
        side: params.side,
        sideLabel: params.side === 'YES' ? 'Up' : 'Down',
        price: params.price,
        size: params.size,
        costUsd: params.costUsd,
        liquidity: params.liquidity ?? 'MAKER',
        roundInWindow: params.roundInWindow,
    };
    orders.push(order);
    simulatedBalanceUsd -= params.costUsd;
}

/**
 * Record window end: P&L and payout. Adds the redeemed amount to simulated balance.
 * At resolution we receive $1 per winning share (YES or NO).
 */
export function recordWindowEnd(params: {
    windowSlug: string;
    windowEndIso: string;
    btcMarketWindowMinutes?: 5 | 15;
    ordersInWindow: RecordedOrder[];
    totalSpentUsd: number;
    costYes: number;
    costNo: number;
    qtyYes: number;
    qtyNo: number;
    pairCost: number;
    lockedProfit: number;
    feeEstimate: number;
    /** Winner side; if unknown, uses matched-pairs payout as conservative fallback */
    winnerSide?: 'YES' | 'NO';
    btcUsdWindowOpen?: number | null;
    btcUsdWindowEnd?: number | null;
    settlementWinnerSource?: SettlementWinnerSource;
}): void {
    const winnerSide = params.winnerSide ?? 'UNKNOWN';
    const payoutReceived =
        winnerSide === 'YES' ? params.qtyYes :
        winnerSide === 'NO' ? params.qtyNo :
        Math.min(params.qtyYes, params.qtyNo);

    // Taker fees only (Polymarket: fee = C×feeRate×p×(1−p)); makers = 0. Paid at settlement in paper mode.
    const realizedNet = payoutReceived - params.totalSpentUsd - params.feeEstimate;

    simulatedBalanceUsd += payoutReceived;
    simulatedBalanceUsd -= params.feeEstimate;

    // Backfill per-order realized P/L (no fees) for UI clarity
    const resolvedOrders = params.ordersInWindow.map(o => {
        const win = winnerSide === 'UNKNOWN' ? undefined : winnerSide;
        const pnl = win
            ? (o.side === win ? (o.size * (1 - o.price)) : (-o.size * o.price))
            : undefined;
        return { ...o, winnerSide: win, realizedPnlUsd: pnl };
    });

    const windowOrders = params.ordersInWindow;
    const startedAt = windowOrders.length > 0
        ? windowOrders[0].timestamp
        : new Date().toISOString();

    completedWindowsDetail.push({
        windowSlug: params.windowSlug,
        windowEndIso: params.windowEndIso,
        btcMarketWindowMinutes: params.btcMarketWindowMinutes,
        windowStartedAt: startedAt,
        windowEndedAt: new Date().toISOString(),
        orderCount: resolvedOrders.length,
        orders: resolvedOrders,
        totalSpentUsd: params.totalSpentUsd,
        costYes: params.costYes,
        costNo: params.costNo,
        qtyYes: params.qtyYes,
        qtyNo: params.qtyNo,
        pairCost: params.pairCost,
        lockedProfit: params.lockedProfit,
        feeEstimate: params.feeEstimate,
        netProfit: realizedNet,
        payoutReceived,
        winnerSide,
        btcUsdWindowOpen: params.btcUsdWindowOpen,
        btcUsdWindowEnd: params.btcUsdWindowEnd,
        settlementWinnerSource: params.settlementWinnerSource,
        // balanceAfterUsd is overwritten in getCompletedWindowsDetail from session start + cumulative net
        balanceAfterUsd: simulatedBalanceUsd,
    });
}

/**
 * If the last window was settled as UNKNOWN (conservative min-pairs payout), patch it when Gamma
 * later reports the real winner. Adjusts simulated balance and per-order realized P/L.
 */
export function correctLastUnknownWindowSettlement(
    winner: 'YES' | 'NO',
    meta?: {
        btcUsdWindowOpen?: number | null;
        btcUsdWindowEnd?: number | null;
        settlementWinnerSource?: SettlementWinnerSource;
    }
): boolean {
    const last = completedWindowsDetail[completedWindowsDetail.length - 1];
    if (!last || last.winnerSide !== 'UNKNOWN') return false;

    const oldPayout = last.payoutReceived;
    const newPayout = winner === 'YES' ? last.qtyYes : last.qtyNo;
    const delta = newPayout - oldPayout;
    simulatedBalanceUsd += delta;

    const newNet = newPayout - last.totalSpentUsd - last.feeEstimate;
    const newOrders = last.orders.map((o) => ({
        ...o,
        winnerSide: winner,
        realizedPnlUsd:
            o.side === winner ? o.size * (1 - o.price) : -o.size * o.price,
    }));

    completedWindowsDetail[completedWindowsDetail.length - 1] = {
        ...last,
        winnerSide: winner,
        payoutReceived: newPayout,
        netProfit: newNet,
        orders: newOrders,
        balanceAfterUsd: simulatedBalanceUsd,
        btcUsdWindowOpen: meta?.btcUsdWindowOpen ?? last.btcUsdWindowOpen,
        btcUsdWindowEnd: meta?.btcUsdWindowEnd ?? last.btcUsdWindowEnd,
        settlementWinnerSource: meta?.settlementWinnerSource ?? last.settlementWinnerSource ?? 'gamma',
    };
    return true;
}

/** All recorded orders (chronological). */
export function getRecordedOrders(): RecordedOrder[] {
    return [...orders];
}

/**
 * All completed windows with orders and P&L.
 * `balanceAfterUsd` is **session start + cumulative netProfit** (chronological), so it always matches
 * the Net P/L column; raw `simulatedBalanceUsd` snapshots can drift vs. nets after settlement patches.
 */
export function getCompletedWindowsDetail(): CompletedWindowDetail[] {
    let running = sessionStartingBalanceUsd;
    return completedWindowsDetail.map((w) => {
        running += w.netProfit;
        return { ...w, balanceAfterUsd: running };
    });
}

/** Orders for a given window (by windowEndIso). */
export function getOrdersForWindow(windowEndIso: string): RecordedOrder[] {
    return orders.filter(o => o.windowEndIso === windowEndIso);
}

/** Cumulative P&L over last N milliseconds (e.g. 24h). */
export function getCumulativePnLSinceMs(ms: number): { netProfit: number; windows: number } {
    const since = Date.now() - ms;
    let net = 0;
    let count = 0;
    for (const w of completedWindowsDetail) {
        const ended = new Date(w.windowEndedAt).getTime();
        if (ended >= since) {
            net += w.netProfit;
            count += 1;
        }
    }
    return { netProfit: net, windows: count };
}

/** Summary for last 24 hours. */
export function getLast24hSummary(): {
    netProfit: number;
    windowsCount: number;
    ordersCount: number;
    totalSpent: number;
    totalPayout: number;
} {
    const TWENTY_FOUR_H = 24 * 60 * 60 * 1000;
    const since = Date.now() - TWENTY_FOUR_H;
    let netProfit = 0;
    let windowsCount = 0;
    let totalSpent = 0;
    let totalPayout = 0;
    const orderIds = new Set<string>();
    for (const w of completedWindowsDetail) {
        const ended = new Date(w.windowEndedAt).getTime();
        if (ended >= since) {
            netProfit += w.netProfit;
            windowsCount += 1;
            totalSpent += w.totalSpentUsd;
            totalPayout += w.payoutReceived;
            w.orders.forEach(o => orderIds.add(o.id));
        }
    }
    return {
        netProfit,
        windowsCount,
        ordersCount: orderIds.size,
        totalSpent,
        totalPayout,
    };
}
