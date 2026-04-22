/**
 * HTTP dashboard to control and monitor the bot.
 * - Auto-refreshing UI with real-time metrics
 * - Kill switch toggle
 * - JSON API for programmatic access
 * - P/L summary endpoint
 * - Trading history: paper uses simulated windows; live uses full persisted order log + CLOB per condition
 * Serves on port from env DASHBOARD_PORT or 7106.
 */

import * as http from 'http';
import {
    getSimulatedBalance,
    getPaperSessionStartingBalanceUsd,
    getCompletedWindowsDetail,
    getLast24hSummary,
    getOrdersForWindow,
} from './tradeHistory';
import {
    buildOrderHistoryExcelBuffer,
    flushOrderHistoryToDisk,
    getOrderHistoryEntries,
    listOrderHistoryWindowsDesc,
    getLast24hOrderHistorySummary,
} from './orderHistoryLog';
import type { LiveVerifiedBuyTrade } from './clobTradeHistory';
import { polymarketBinaryTakerFeeUsd } from '../utils/polymarketFees';
const DEFAULT_PORT = 7106;

/** Paper orders for the window, or live: CLOB getTrades (authoritative) with fallback to internal log. */
function getOrdersForWindowDisplay(s: DashboardState): Array<{
    timestamp: string;
    side: 'YES' | 'NO';
    sideLabel: string;
    size: number;
    price: number;
    costUsd: number;
    source: 'paper' | 'clob' | 'log';
}> {
    const windowEndIso = s.windowEndIso;
    if (!windowEndIso) return [];
    const paper = getOrdersForWindow(windowEndIso)
        .slice()
        .sort((a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime());
    if (paper.length > 0) {
        return paper.map((o) => ({
            timestamp: o.timestamp,
            side: o.side,
            sideLabel: o.sideLabel,
            size: o.size,
            price: o.price,
            costUsd: o.costUsd,
            source: 'paper' as const,
        }));
    }
    if (!s.liveTrading) return [];

    const fromLog = getOrderHistoryEntries().filter(
        (e) => e.liveTrading && e.windowEndIso === windowEndIso
    );
    const cid = fromLog.find((e) => e.conditionId)?.conditionId ?? s.activeConditionId ?? null;

    let clobRows: LiveVerifiedBuyTrade[] | undefined;
    if (cid && s.sessionClobTradesByCondition[cid] !== undefined) {
        clobRows = s.sessionClobTradesByCondition[cid];
    }

    if (clobRows !== undefined) {
        return clobRows.map((t) => ({
            timestamp: t.timestampIso,
            side: t.side,
            sideLabel: t.side === 'YES' ? 'Up' : 'Down',
            size: t.size,
            price: t.price,
            costUsd: t.costUsd,
            source: 'clob' as const,
        }));
    }

    return fromLog
        .sort((a, b) => new Date(a.timestampIso).getTime() - new Date(b.timestampIso).getTime())
        .map((e) => ({
            timestamp: e.timestampIso,
            side: e.side,
            sideLabel: e.side === 'YES' ? 'Up' : 'Down',
            size: e.orderSizeShares,
            price: e.fillPriceUsd,
            costUsd: e.costUsd,
            source: 'log' as const,
        }));
}

function escapeHtmlAttr(s: string): string {
    return s
        .replace(/&/g, '&amp;')
        .replace(/"/g, '&quot;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;');
}

/**
 * Live: full history from persisted `order-history.json` + in-memory rows (same as export API).
 * Windows grouped by end time + condition id so 5m and 15m rounds stay distinct. CLOB fills only
 * for the matching condition — never the whole session’s unscoped trade list.
 */
function buildLiveSessionOrderHistoryHtml(state: DashboardState): string {
    const liveEntries = getOrderHistoryEntries().filter((e) => e.liveTrading);
    const windows = listOrderHistoryWindowsDesc(liveEntries);
    const h24 = getLast24hOrderHistorySummary(true);
    const netColor24 = h24.netProfit >= 0 ? '#10b981' : '#ef4444';

    if (windows.length === 0) {
        return (
            '<div class="section-title">Live session &mdash; order history</div>' +
            '<div style="background:var(--bg-card);border:1px solid var(--border);border-radius:12px;padding:18px;margin-bottom:24px;">' +
            '<p style="font-size:0.85rem;color:var(--text-muted);margin:0 0 8px 0;">No live rows in the order log yet. Fills are appended on each trade and persisted to <code>data/order-history.json</code> (restart loads full history).</p>' +
            (state.liveClobTradesError
                ? '<p style="font-size:0.78rem;color:#ef4444;margin:0 0 8px 0;">Last CLOB fetch error: ' +
                  escapeHtml(state.liveClobTradesError) +
                  '</p>'
                : '') +
            '<p style="font-size:0.72rem;color:var(--text-muted);margin:0;">Polymarket balance: <strong>$' +
            state.polymarketBalanceUsdc.toFixed(2) +
            '</strong> &middot; Export: <a href="/api/order-history.json" style="color:#f59e0b;">JSON</a> &middot; <a href="/api/order-history.xlsx" style="color:#f59e0b;">Excel</a></p>' +
            '</div>'
        );
    }

    let html = '<div class="section-title">Live session &mdash; full trading history</div>';
    html +=
        '<div style="background:linear-gradient(135deg,rgba(245,158,11,0.12),rgba(217,119,6,0.08));border:1px solid var(--border);border-radius:12px;padding:18px;margin-bottom:24px;">';
    html +=
        '<div style="display:flex;flex-wrap:wrap;gap:16px;align-items:center;margin-bottom:14px;font-size:0.78rem;color:var(--text-muted);">';
    html +=
        '<span>Trading balance: <strong style="color:var(--text-primary);">$' +
        state.polymarketBalanceUsdc.toFixed(2) +
        '</strong></span>';
    html +=
        '<span>Total USDC: <strong style="color:var(--text-primary);">$' +
        state.totalBalanceUsdc.toFixed(2) +
        '</strong></span>';
    html +=
        '<span style="margin-left:12px;padding-left:12px;border-left:1px solid var(--border);">Last 24h (log): windows <strong>' +
        h24.windowsCount +
        '</strong> &middot; orders <strong>' +
        h24.ordersCount +
        '</strong> &middot; spent $' +
        h24.totalSpent.toFixed(2) +
        ' &middot; net P/L <strong style="color:' +
        netColor24 +
        ';">' +
        (h24.netProfit >= 0 ? '+' : '') +
        '$' +
        h24.netProfit.toFixed(2) +
        '</strong></span>';
    html += '</div>';
    html +=
        '<div style="font-size:0.72rem;color:var(--text-muted);margin-bottom:12px;">All windows from the order log (newest first). <strong>BTC</strong> column is the market series (5m vs 15m). Expand: <strong>CLOB getTrades BUY</strong> for that condition only when synced; else internal log rows.</div>';
    html += '<table style="width:100%;border-collapse:collapse;font-size:0.78rem;">';
    html +=
        '<thead><tr style="text-align:left;border-bottom:1px solid var(--border);"><th style="padding:8px 10px;">Window end</th><th style="padding:8px 10px;">BTC</th><th style="padding:8px 10px;">Market</th><th style="padding:8px 10px;"># Orders</th><th style="padding:8px 10px;">Spent</th><th style="padding:8px 10px;">Net P/L</th><th style="padding:8px 10px;">Winner</th><th style="padding:8px 10px;">Outcome</th><th style="padding:8px 10px;"></th></tr></thead><tbody>';

    windows.forEach((win, idx) => {
        const winEntries = win.orders;
        const wEnd = win.windowEndIso;
        const btcMin = win.btcMarketWindowMinutes;
        const cid = win.conditionId ?? null;
        let clobWin: LiveVerifiedBuyTrade[] | undefined =
            cid && state.sessionClobTradesByCondition[cid] !== undefined
                ? state.sessionClobTradesByCondition[cid]
                : undefined;
        const useClob = clobWin !== undefined && clobWin.length > 0;
        const spent = useClob
            ? clobWin!.reduce((acc, t) => acc + t.costUsd, 0)
            : winEntries.reduce((acc, e) => acc + e.costUsd, 0);
        const netPl =
            winEntries.find((e) => e.windowNetProfitUsd != null)?.windowNetProfitUsd ?? null;
        const outcome = winEntries[0]?.marketOutcome ?? 'pending';
        const slug = winEntries[0]?.windowSlug ?? state.marketSlug ?? '';
        const winner = winEntries[0]?.winnerSide;
        const winnerLabel =
            winner === 'YES' ? 'Up' : winner === 'NO' ? 'Down' : winner === 'UNKNOWN' ? 'Pending' : '—';
        const rowId = 'lw-' + idx;
        const netColor =
            netPl != null && netPl >= 0
                ? '#10b981'
                : netPl != null
                  ? '#ef4444'
                  : 'var(--text-muted)';
        html += '<tr style="border-bottom:1px solid rgba(42,48,80,0.5);">';
        html += '<td style="padding:8px 10px;">' + new Date(wEnd).toLocaleString() + '</td>';
        html += '<td style="padding:8px 10px;">' + btcMin + 'm</td>';
        html += '<td style="padding:8px 10px;">' + escapeHtmlAttr(slug.slice(0, 36)) + '</td>';
        html +=
            '<td style="padding:8px 10px;">' +
            (useClob ? clobWin!.length : winEntries.length) +
            '</td>';
        html += '<td style="padding:8px 10px;">$' + spent.toFixed(2) + '</td>';
        html +=
            '<td style="padding:8px 10px;font-weight:600;color:' +
            netColor +
            ';">' +
            (netPl == null ? '—' : (netPl >= 0 ? '+' : '') + '$' + netPl.toFixed(2)) +
            '</td>';
        html += '<td style="padding:8px 10px;">' + winnerLabel + '</td>';
        html += '<td style="padding:8px 10px;">' + outcome + '</td>';
        html +=
            '<td style="padding:8px 10px;"><button type="button" onclick="var r=document.getElementById(\'' +
            rowId +
            "'); r.style.display=r.style.display==='none'?'':'none';\" style=\"background:var(--border);border:none;color:var(--text-secondary);padding:4px 10px;border-radius:6px;cursor:pointer;font-size:0.7rem;\">Orders</button></td></tr>";
        html +=
            '<tr id="' +
            rowId +
            '" style="display:none;"><td colspan="9" style="padding:0 10px 12px;background:rgba(0,0,0,0.2);">';
        html +=
            '<table style="width:100%;font-size:0.72rem;margin-top:8px;"><tr style="color:var(--text-muted);"><th style="text-align:left;padding:4px 8px;">#</th><th style="padding:4px 8px;">Time</th><th style="padding:4px 8px;">Side</th><th style="padding:4px 8px;">Price</th><th style="padding:4px 8px;">Size</th><th style="padding:4px 8px;">Cost</th><th style="padding:4px 8px;">After PnL Up</th><th style="padding:4px 8px;">After PnL Dn</th><th style="text-align:left;padding:4px 8px;">' +
            (useClob ? 'Source' : 'Reason') +
            '</th></tr>';
        if (useClob) {
            let runY = 0;
            let runN = 0;
            let runSpent = 0;
            clobWin!.forEach((t, ei) => {
                runSpent += t.costUsd;
                if (t.side === 'YES') runY += t.size;
                else runN += t.size;
                const pUp = runY - runSpent;
                const pDown = runN - runSpent;
                html += '<tr>';
                html += '<td style="padding:4px 8px;">' + (ei + 1) + '</td>';
                html +=
                    '<td style="padding:4px 8px;">' +
                    new Date(t.timestampIso).toLocaleTimeString() +
                    '</td>';
                html +=
                    '<td style="padding:4px 8px;">' + (t.side === 'YES' ? 'Up' : 'Down') + '</td>';
                html += '<td style="padding:4px 8px;">$' + t.price.toFixed(4) + '</td>';
                html += '<td style="padding:4px 8px;">' + t.size + '</td>';
                html += '<td style="padding:4px 8px;">$' + t.costUsd.toFixed(2) + '</td>';
                html +=
                    '<td style="padding:4px 8px;">' +
                    (pUp >= 0 ? '+' : '') +
                    '$' +
                    pUp.toFixed(2) +
                    '</td>';
                html +=
                    '<td style="padding:4px 8px;">' +
                    (pDown >= 0 ? '+' : '') +
                    '$' +
                    pDown.toFixed(2) +
                    '</td>';
                html +=
                    '<td style="padding:4px 8px;font-size:0.65rem;">CLOB · ' +
                    escapeHtmlAttr(t.tradeId.slice(0, 14)) +
                    '…</td>';
                html += '</tr>';
            });
        } else {
            winEntries.forEach((e, ei) => {
                const rc = e.reasonCode ?? '';
                html += '<tr>';
                html += '<td style="padding:4px 8px;">' + (ei + 1) + '</td>';
                html +=
                    '<td style="padding:4px 8px;">' +
                    new Date(e.timestampIso).toLocaleTimeString() +
                    '</td>';
                html +=
                    '<td style="padding:4px 8px;">' + (e.side === 'YES' ? 'Up' : 'Down') + '</td>';
                html += '<td style="padding:4px 8px;">$' + e.fillPriceUsd.toFixed(4) + '</td>';
                html += '<td style="padding:4px 8px;">' + e.orderSizeShares + '</td>';
                html += '<td style="padding:4px 8px;">$' + e.costUsd.toFixed(2) + '</td>';
                html +=
                    '<td style="padding:4px 8px;">' +
                    (e.afterPnlIfUpUsd >= 0 ? '+' : '') +
                    '$' +
                    e.afterPnlIfUpUsd.toFixed(2) +
                    '</td>';
                html +=
                    '<td style="padding:4px 8px;">' +
                    (e.afterPnlIfDownUsd >= 0 ? '+' : '') +
                    '$' +
                    e.afterPnlIfDownUsd.toFixed(2) +
                    '</td>';
                html +=
                    '<td style="padding:4px 8px;font-size:0.65rem;max-width:240px;overflow:hidden;text-overflow:ellipsis;" title="' +
                    escapeHtmlAttr(rc) +
                    '">' +
                    escapeHtmlAttr(rc.slice(0, 96)) +
                    (rc.length > 96 ? '…' : '') +
                    '</td>';
                html += '</tr>';
            });
        }
        html += '</table></td></tr>';
    });
    html += '</tbody></table>';
    html +=
        '<div style="margin-top:12px;font-size:0.72rem;color:var(--text-muted);">Export (full log): <a href="/api/order-history.json" style="color:#f59e0b;">/api/order-history.json</a> &middot; <a href="/api/order-history.xlsx" style="color:#f59e0b;">Excel</a></div>';
    html += '</div>';
    return html;
}

/** Default on; set DASHBOARD_ENABLED=0|false|no|off to run without the local HTTP UI. */
export function isDashboardEnabled(): boolean {
    const v = process.env.DASHBOARD_ENABLED?.trim().toLowerCase();
    if (v === undefined || v === '') return true;
    return !['0', 'false', 'no', 'off'].includes(v);
}

export interface DashboardState {
    running: boolean;
    killSwitch: boolean;
    marketSlug: string | null;
    windowEndIso: string | null;
    pairCost: number;
    qtyYes: number;
    qtyNo: number;
    trackedQtyYes: number;
    trackedQtyNo: number;
    actualQtyYes: number;
    actualQtyNo: number;
    lockedProfit: number;
    totalSpentUsd: number;
    consecutiveFailures: number;
    pendingOrders: number;
    lastTick: string | null;
    message: string;
    walletBalanceUsdc: number;
    polymarketBalanceUsdc: number;
    totalBalanceUsdc: number;
    walletAddress: string;
    proxyWalletAddress: string;
    liveTrading: boolean;
    completedWindows: number;
    cumulativeProfitUsd: number;
    uptimeSeconds: number;
    // BTC 15m scan
    scanSlugsChecked: string[];
    scanMarketsReturned: number;
    scanTotalApiFetched: number;
    scanActiveMarket: {
        question: string;
        slug: string;
        endTime: string;
        secondsLeft: number;
        acceptingOrders: boolean;
    } | null;
    scanRejected: Array<{ slug: string; reason: string }>;
    scanError: string | null;
    scanTimestamp: string | null;
    // Config limits (for display)
    maxPositionPerWindowUsd: number;
    // Live orderbook prices
    liveBestAskYes: number;
    liveBestAskNo: number;
    liveCombinedAsk: number;
    liveBestBidYes: number;
    liveBestBidNo: number;
    liveCombinedBid: number;
    livePairCostCeiling: number;
    liveEffectiveMinShares: number;
    // Pending order tracking (entry prices)
    entryOrderYes: { price: number; size: number; placedAt: string } | null;
    entryOrderNo: { price: number; size: number; placedAt: string } | null;
    // Per-side fill details (for "Active Pair Position" display)
    costYes: number;
    costNo: number;
    avgYes: number;
    avgNo: number;
    // Balance freshness
    balanceLastCheckedIso: string;
    // Auto redemption monitoring
    redeemQueueSize: number;
    lastRedeemSweepIso: string | null;
    lastRedeemSweepResult: string;
    // Accounting
    feeBipsAssumption: number;
    positionValueUsd: number;
    positionCostUsd: number;
    unrealizedPnlUsd: number;
    portfolioValueUsd: number;
    sessionPnlUsd: number;
    sessionStartPortfolioUsd: number;
    /** Net P/L if Up (YES) wins: qtyYes×$1 − total spent (includes modeled taker fee in spend). */
    afterPnlIfUpUsd: number;
    /** Net P/L if Down (NO) wins: qtyNo×$1 − total spent (includes modeled taker fee in spend). */
    afterPnlIfDownUsd: number;
    /** Same scenarios using notional spend only (total spent minus cumulative taker commission). Stock B vs `minDualAfterPnlUsd`. */
    afterPnlIfUpExcludingCommissionUsd: number;
    afterPnlIfDownExcludingCommissionUsd: number;
    /** Cumulative modeled taker commission: Σ C×k×p×(1−p). */
    takerCommissionPaidUsd: number;
    /** Fee scalar k in commission (e.g. 0.072). */
    binaryOutcomeTakerFeeScalar?: number;
    /** Realized net for the most recently closed window (paper: from settlement; includes fees model). */
    lastClosedWindowNetUsd: number | null;
    /** Which side won the last closed window (UNKNOWN = Gamma not yet resolved). */
    lastClosedWindowWinner: 'YES' | 'NO' | 'UNKNOWN' | null;
    /** Polymarket market question (e.g. Bitcoin Up or Down — … time range ET). */
    activeMarketTitle: string | null;
    /** Configured window length for ET fallback label (5 or 15). */
    tradingWindowMinutes: 5 | 15 | null;
    /** Entry decision telemetry: now and historical snapshots. */
    entryDecisionNow: EntryDecisionSnapshot | null;
    entryDecision30sAgo: EntryDecisionSnapshot | null;
    entryDecision60sAgo: EntryDecisionSnapshot | null;
    lastExecutedEntry: ExecutedEntrySnapshot | null;
    marketTiltEpsilon: number;
    pairTiltImbalanceShares: number;
    forcedSwitchEveryNOrders: number;
    /** Spot BTC/USD anchor at window start (from bot feed). */
    btcUsdWindowOpen: number | null;
    /** Last BTC/USD spot used for gap (updated each tick). */
    btcUsdSpot: number | null;
    /** BTC USD move vs window open (spot − open). */
    btcGapUsd: number | null;
    /** Rough trend: $/s from oldest gap sample in ~2m buffer. */
    btcGapVelocityUsdPerSec: number | null;
    /** Naive extrapolation: current gap + velocity × 60s (display only). */
    btcGapPredicted60sUsd: number | null;
    /** True on ticks where gap sign crossed ±dead zone vs prior non-neutral sign. */
    btcGapFlipDetectedThisTick: boolean;
    /** Config: ±USD band treated as neutral for sign / flip detection. */
    btcGapSignDeadZoneUsd: number;
    /** Config: allow FOK hedge on BTC gap sign flip when one-sided. */
    momentumInversionHedgeEnabled: boolean;
    /**
     * Down (NO) best ask orderbook momentum: $/s from rolling samples (not BTC).
     * Distinct from BTC gap velocity above.
     */
    downAskMomentumUsdPerSec: number | null;
    /** Linear extrapolation: Down ask now + velocity × secondsLeft until window end. */
    downAskPredictedAtWindowEndUsd: number | null;
    /** Config: early FOK Down hedge when ask rises and stays above floor (before final 30s). */
    earlyDownMomentumHedgeEnabled: boolean;

    /** Active market condition id (live) — maps CLOB trade list to the current window. */
    activeConditionId: string | null;
    /** Latest CLOB BUY trades for the active condition (from authenticated getTrades). */
    liveClobVerifiedTrades: LiveVerifiedBuyTrade[];
    /** All conditions fetched this session → trades (for per-window history). */
    sessionClobTradesByCondition: Record<string, LiveVerifiedBuyTrade[]>;
    liveClobTradesFetchedAtIso: string | null;
    liveClobTradesError: string | null;
}

export interface EntryDecisionSnapshot {
    timestampIso: string;
    suggestedSide: 'YES' | 'NO';
    reasonCode: string;
    bestBidYes: number;
    bestBidNo: number;
    imbalanceShares: number;
    marketTilt: number;
    secondsLeft: number;
    roundInWindow: number;
}

export interface ExecutedEntrySnapshot {
    timestampIso: string;
    side: 'YES' | 'NO';
    shares: number;
    price: number;
    reasonCode: string;
}

/** Wired from index.ts after HedgeBot is constructed (avoids circular imports). */
export type ManualBuyHandler = (
    side: 'YES' | 'NO',
    shares: number
) => Promise<{
    ok: boolean;
    error?: string;
    snapshot?: unknown;
    orderId?: string;
}>;

export type AutoOppositeBuyHandler = () => Promise<{
    ok: boolean;
    error?: string;
    snapshot?: unknown;
    orderId?: string;
    analysis?: unknown;
}>;

let manualBuyHandler: ManualBuyHandler | null = null;
let autoOppositeBuyHandler: AutoOppositeBuyHandler | null = null;

export function setManualBuyHandler(handler: ManualBuyHandler | null): void {
    manualBuyHandler = handler;
}

export function setAutoOppositeBuyHandler(handler: AutoOppositeBuyHandler | null): void {
    autoOppositeBuyHandler = handler;
}

let sharedState: DashboardState = {
    running: false,
    killSwitch: false,
    marketSlug: null,
    windowEndIso: null,
    pairCost: 0,
    qtyYes: 0,
    qtyNo: 0,
    trackedQtyYes: 0,
    trackedQtyNo: 0,
    actualQtyYes: 0,
    actualQtyNo: 0,
    lockedProfit: 0,
    totalSpentUsd: 0,
    consecutiveFailures: 0,
    pendingOrders: 0,
    lastTick: null,
    message: 'Bot not started',
    walletBalanceUsdc: 0,
    polymarketBalanceUsdc: 0,
    totalBalanceUsdc: 0,
    walletAddress: '',
    proxyWalletAddress: '',
    liveTrading: false,
    completedWindows: 0,
    cumulativeProfitUsd: 0,
    uptimeSeconds: 0,
    scanSlugsChecked: [],
    scanMarketsReturned: 0,
    scanTotalApiFetched: 0,
    scanActiveMarket: null,
    scanRejected: [],
    scanError: null,
    scanTimestamp: null,
    maxPositionPerWindowUsd: 0,
    liveBestAskYes: 0,
    liveBestAskNo: 0,
    liveCombinedAsk: 0,
    liveBestBidYes: 0,
    liveBestBidNo: 0,
    liveCombinedBid: 0,
    livePairCostCeiling: 0,
    liveEffectiveMinShares: 0,
    entryOrderYes: null,
    entryOrderNo: null,
    costYes: 0,
    costNo: 0,
    avgYes: 0,
    avgNo: 0,
    balanceLastCheckedIso: '',
    redeemQueueSize: 0,
    lastRedeemSweepIso: null,
    lastRedeemSweepResult: 'Not run yet',
    feeBipsAssumption: 10,
    positionValueUsd: 0,
    positionCostUsd: 0,
    unrealizedPnlUsd: 0,
    portfolioValueUsd: 0,
    sessionPnlUsd: 0,
    sessionStartPortfolioUsd: 0,
    afterPnlIfUpUsd: 0,
    afterPnlIfDownUsd: 0,
    afterPnlIfUpExcludingCommissionUsd: 0,
    afterPnlIfDownExcludingCommissionUsd: 0,
    takerCommissionPaidUsd: 0,
    binaryOutcomeTakerFeeScalar: 0.072,
    lastClosedWindowNetUsd: null,
    lastClosedWindowWinner: null,
    activeMarketTitle: null,
    tradingWindowMinutes: null,
    entryDecisionNow: null,
    entryDecision30sAgo: null,
    entryDecision60sAgo: null,
    lastExecutedEntry: null,
    marketTiltEpsilon: 0.02,
    pairTiltImbalanceShares: 10,
    forcedSwitchEveryNOrders: 4,
    btcUsdWindowOpen: null,
    btcUsdSpot: null,
    btcGapUsd: null,
    btcGapVelocityUsdPerSec: null,
    btcGapPredicted60sUsd: null,
    btcGapFlipDetectedThisTick: false,
    btcGapSignDeadZoneUsd: 5,
    momentumInversionHedgeEnabled: true,
    downAskMomentumUsdPerSec: null,
    downAskPredictedAtWindowEndUsd: null,
    earlyDownMomentumHedgeEnabled: false,
    activeConditionId: null,
    liveClobVerifiedTrades: [],
    sessionClobTradesByCondition: {},
    liveClobTradesFetchedAtIso: null,
    liveClobTradesError: null,
};

export function updateDashboardState(update: Partial<DashboardState>): void {
    sharedState = { ...sharedState, ...update };
}

export function getDashboardState(): DashboardState {
    const s = { ...sharedState };
    const spent = s.totalSpentUsd;
    const fee = s.takerCommissionPaidUsd ?? 0;
    const notional = spent - fee;
    return {
        ...s,
        afterPnlIfUpUsd: s.qtyYes - spent,
        afterPnlIfDownUsd: s.qtyNo - spent,
        afterPnlIfUpExcludingCommissionUsd: s.qtyYes - notional,
        afterPnlIfDownExcludingCommissionUsd: s.qtyNo - notional,
        takerCommissionPaidUsd: fee,
        binaryOutcomeTakerFeeScalar: s.binaryOutcomeTakerFeeScalar ?? 0.072,
    };
}

function formatUptime(seconds: number): string {
    const h = Math.floor(seconds / 3600);
    const m = Math.floor((seconds % 3600) / 60);
    const s = seconds % 60;
    if (h > 0) return `${h}h ${m}m ${s}s`;
    if (m > 0) return `${m}m ${s}s`;
    return `${s}s`;
}

function shortAddr(addr: string): string {
    if (!addr || addr.length < 12) return addr || '—';
    return addr.slice(0, 6) + '...' + addr.slice(-4);
}

function escapeHtml(str: string): string {
    return str
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
}

function formatEntryReason(reasonCode: string): string {
    switch (reasonCode) {
        case 'PARITY_REBALANCE':
            return 'Parity rebalance';
        case 'INVENTORY_IMBALANCE':
            return 'Inventory imbalance';
        case 'MARKET_TILT':
            return 'Market tilt';
        case 'CHEAPER_BID_FALLBACK':
            return 'Cheaper bid fallback';
        case 'FORCED_SWITCH':
            return 'Forced switch';
        default:
            return reasonCode || 'Unknown';
    }
}

/** Prominent market line for top of dashboard (API question or ET window from window end). */
/** Configured BTC window length (defaults to 5 when unknown). */
function getTradingWindowMinutesForDashboard(s: DashboardState): 5 | 15 {
    return s.tradingWindowMinutes === 5 ? 5 : s.tradingWindowMinutes === 15 ? 15 : 5;
}

function marketHeadlineHtml(s: DashboardState): string {
    const raw = (s.activeMarketTitle || s.scanActiveMarket?.question || '').trim();
    if (raw) return escapeHtml(raw);
    if (s.windowEndIso) {
        const endMs = new Date(s.windowEndIso).getTime();
        const mins = getTradingWindowMinutesForDashboard(s);
        const startMs = endMs - mins * 60 * 1000;
        const opts: Intl.DateTimeFormatOptions = {
            timeZone: 'America/New_York',
            weekday: 'long',
            month: 'long',
            day: 'numeric',
            hour: 'numeric',
            minute: '2-digit',
        };
        const startStr = new Date(startMs).toLocaleString('en-US', opts);
        const endStr = new Date(endMs).toLocaleString('en-US', {
            ...opts,
            timeZoneName: 'short',
        });
        return escapeHtml(`Bitcoin Up or Down — ${startStr} – ${endStr}`);
    }
    return '<span style="opacity:0.75;color:var(--text-muted)">Waiting for active BTC Up/Down market…</span>';
}

function buildDashboardLiveInnerHtml(s: DashboardState): string {
    const windowLenMin = getTradingWindowMinutesForDashboard(s);
    const windowLenSec = windowLenMin * 60;
    const statusColor = s.running ? '#10b981' : '#ef4444';
    const statusGlow = s.running ? 'rgba(16,185,129,0.3)' : 'rgba(239,68,68,0.3)';
    const modeColor = s.liveTrading ? '#f59e0b' : '#6366f1';
    const modeLabel = s.liveTrading ? 'LIVE' : 'PAPER';
    const killColor = s.killSwitch ? '#ef4444' : '#10b981';
    const pairColor = s.pairCost < 0.98 ? '#10b981' : s.pairCost < 0.98 ? '#f59e0b' : '#ef4444';
    const profitColor = s.lockedProfit >= 0 ? '#10b981' : '#ef4444';
    const cumulColor = s.cumulativeProfitUsd >= 0 ? '#10b981' : '#ef4444';
    const walletBalStr = s.walletBalanceUsdc.toFixed(2);
    const polyBalStr = s.polymarketBalanceUsdc.toFixed(2);
    const totalBalStr = s.totalBalanceUsdc.toFixed(2);
    const windowTimeLeft = s.windowEndIso
        ? Math.max(0, Math.floor((new Date(s.windowEndIso).getTime() - Date.now()) / 1000))
        : 0;
    /** Elapsed fraction of the current window (matches 5m or 15m from config, not hardcoded 15m). */
    const windowProgress = s.windowEndIso
        ? Math.max(0, Math.min(100, ((windowLenSec - windowTimeLeft) / windowLenSec) * 100))
        : 0;
    return `
    <!-- Header -->
    <div class="header" style="flex-wrap:wrap;">
      <div class="header-left">
        <div class="logo">H</div>
        <div>
          <h1>Polymarket Hedge Bot 04 22*1</h1>
          <div class="tagline">${windowLenMin}-minute crypto arbitrage &mdash; pair cost &lt; $1.00</div>
        </div>
      </div>
      <div class="header-badges">
        <span class="badge ${s.running ? 'badge-running' : 'badge-stopped'}">
          <span class="badge-dot ${s.running ? 'animate' : ''}" style="background:${statusColor}"></span>
          ${s.running ? 'Running' : 'Stopped'}
        </span>
        <span class="badge ${s.liveTrading ? 'badge-live' : 'badge-paper'}">
          <span class="badge-dot" style="background:${modeColor}"></span>
          ${modeLabel}
        </span>
        <span class="badge ${s.killSwitch ? 'badge-kill-on' : 'badge-kill-off'}">
          Kill Switch: ${s.killSwitch ? 'ON' : 'OFF'}
        </span>
      </div>
      <div style="width:100%;display:flex;flex-wrap:wrap;align-items:center;gap:10px;padding-top:10px;border-top:1px solid var(--border);margin-top:4px;">
        <span style="font-size:0.72rem;color:var(--text-muted);text-transform:uppercase;letter-spacing:0.06em;">Order history log</span>
        <button type="button" id="downloadOrderHistoryXlsx" title="Download Excel workbook"
          style="padding:8px 14px;border-radius:8px;border:none;background:linear-gradient(135deg,#0ea5e9,#0284c7);color:#fff;font-weight:700;cursor:pointer;font-size:0.78rem;">
          Download Excel
        </button>
        <button type="button" id="downloadOrderHistoryJson" title="Download JSON"
          style="padding:8px 14px;border-radius:8px;border:none;background:linear-gradient(135deg,#6366f1,#4f46e5);color:#fff;font-weight:700;cursor:pointer;font-size:0.78rem;">
          Download JSON
        </button>
        <span style="font-size:0.68rem;color:var(--text-muted);">(snapshots every 5 min + on window end; Excel sheets: all / profitable / unprofitable / pending)</span>
      </div>
    </div>

    <!-- Wallet Banner -->
    <div class="wallet-banner" style="flex-direction:column;gap:18px;">
      <div style="display:flex;justify-content:space-between;align-items:center;width:100%;flex-wrap:wrap;gap:12px;">
        <div style="display:flex;gap:28px;flex-wrap:wrap;">
          <div class="wallet-info">
            <span class="wallet-label">Public Wallet (MetaMask)</span>
            <span class="wallet-addr">${shortAddr(s.walletAddress)}</span>
          </div>
          <div class="wallet-info">
            <span class="wallet-label">Proxy Wallet (Polymarket)</span>
            <span class="wallet-addr">${shortAddr(s.proxyWalletAddress)}</span>
          </div>
          <div class="wallet-info">
            <span class="wallet-label">Uptime</span>
            <span class="wallet-addr">${formatUptime(s.uptimeSeconds)}</span>
          </div>
        </div>
        <div class="wallet-balance">
          <div class="amount">$${s.portfolioValueUsd.toFixed(2)}</div>
          <div class="currency">Total Value (USDC + positions)</div>
        </div>
      </div>
      ${(() => {
          const positionValue = s.positionValueUsd;
          const positionCost = s.positionCostUsd;
          const unrealizedPL = s.unrealizedPnlUsd;
          const sessionPnl = s.sessionPnlUsd;
          const unrealColor = unrealizedPL >= 0 ? '#10b981' : '#ef4444';
          const sessionColor = sessionPnl >= 0 ? '#10b981' : '#ef4444';
          const hasPositions =
              s.qtyYes > 0 || s.qtyNo > 0 || s.actualQtyYes > 0 || s.actualQtyNo > 0;
          return `
      <div style="display:flex;gap:12px;width:100%;flex-wrap:wrap;">
        <div style="flex:1;min-width:180px;background:rgba(16,185,129,0.06);border:1px solid rgba(16,185,129,0.2);border-radius:10px;padding:14px 18px;">
          <div style="font-size:0.68rem;color:var(--text-muted);text-transform:uppercase;letter-spacing:0.06em;font-weight:500;margin-bottom:6px;">Polymarket USDC</div>
          <div style="font-family:'JetBrains Mono',monospace;font-size:1.5rem;font-weight:700;color:#10b981;">$${polyBalStr}</div>
          <div style="font-size:0.7rem;color:var(--text-muted);margin-top:2px;">Proxy wallet &mdash; for trading</div>
          ${(() => {
              if (!s.balanceLastCheckedIso) return '';
              const ageS = Math.floor(
                  (Date.now() - new Date(s.balanceLastCheckedIso).getTime()) / 1000
              );
              const ageColor = ageS <= 15 ? '#10b981' : ageS <= 30 ? '#f59e0b' : '#ef4444';
              return (
                  '<div style="font-size:0.65rem;color:' +
                  ageColor +
                  ';margin-top:3px;">checked ' +
                  ageS +
                  's ago</div>'
              );
          })()}
        </div>
        ${
            hasPositions
                ? `
        <div style="flex:1;min-width:180px;background:rgba(245,158,11,0.06);border:1px solid rgba(245,158,11,0.2);border-radius:10px;padding:14px 18px;">
          <div style="font-size:0.68rem;color:var(--text-muted);text-transform:uppercase;letter-spacing:0.06em;font-weight:500;margin-bottom:6px;">Open Positions Value</div>
          <div style="font-family:'JetBrains Mono',monospace;font-size:1.5rem;font-weight:700;color:#f59e0b;">$${positionValue.toFixed(2)}</div>
          <div style="font-size:0.7rem;color:var(--text-muted);margin-top:2px;">
            ${s.qtyYes.toFixed(0)} UP &times; $${s.liveBestBidYes.toFixed(2)} + ${s.qtyNo.toFixed(0)} DN &times; $${s.liveBestBidNo.toFixed(2)}
          </div>
          <div style="font-size:0.72rem;color:${unrealColor};font-weight:600;margin-top:4px;">
            Position P/L: ${unrealizedPL >= 0 ? '+' : ''}$${unrealizedPL.toFixed(2)} vs $${positionCost.toFixed(2)} cost
          </div>
          <div style="font-size:0.72rem;color:${sessionColor};font-weight:600;margin-top:2px;">
            Session P/L: ${sessionPnl >= 0 ? '+' : ''}$${sessionPnl.toFixed(2)} vs start $${s.sessionStartPortfolioUsd.toFixed(2)}
          </div>
        </div>`
                : ''
        }
        <div style="flex:1;min-width:180px;background:rgba(59,130,246,0.06);border:1px solid rgba(59,130,246,0.2);border-radius:10px;padding:14px 18px;">
          <div style="font-size:0.68rem;color:var(--text-muted);text-transform:uppercase;letter-spacing:0.06em;font-weight:500;margin-bottom:6px;">MetaMask Wallet</div>
          <div style="font-family:'JetBrains Mono',monospace;font-size:1.5rem;font-weight:700;color:#3b82f6;">$${walletBalStr}</div>
          <div style="font-size:0.7rem;color:var(--text-muted);margin-top:2px;">Public wallet &mdash; available to deposit</div>
        </div>
      </div>`;
      })()}
    </div>

    <!-- Window Progress -->
    ${
        s.windowEndIso
            ? `
    <div class="progress-bar-container">
      <div class="progress-header">
        <span class="label">Window (${windowLenMin}m): ${s.marketSlug ?? '—'}</span>
        <span class="time">${windowTimeLeft > 0 ? windowTimeLeft + 's remaining' : 'Ended'} &mdash; ends ${new Date(s.windowEndIso).toLocaleTimeString()}</span>
      </div>
      <div class="progress-track">
        <div class="progress-fill" style="width:${windowProgress.toFixed(1)}%"></div>
      </div>
    </div>
    `
            : `
    <div class="progress-bar-container">
      <div class="progress-header">
        <span class="label">No active window</span>
        <span class="time">Waiting for BTC Up/Down market...</span>
      </div>
      <div class="progress-track">
        <div class="progress-fill" style="width:0%"></div>
      </div>
    </div>
    `
    }

    <!-- Current Window Metrics -->
    ${(() => {
        const matchedQty = Math.min(s.qtyYes, s.qtyNo);
        const matchedCost =
            matchedQty > 0 && s.qtyYes > 0 && s.qtyNo > 0
                ? matchedQty * s.avgYes + matchedQty * s.avgNo
                : 0;
        const matchedPayout = matchedQty;
        const matchedGross = matchedPayout - matchedCost;
        const feeRate = (s.feeBipsAssumption || 0) / 10000;
        const matchedFee =
            matchedQty > 0 && s.qtyYes > 0 && s.qtyNo > 0
                ? polymarketBinaryTakerFeeUsd(matchedQty, s.avgYes, feeRate) +
                  polymarketBinaryTakerFeeUsd(matchedQty, s.avgNo, feeRate)
                : 0;
        const matchedNet = matchedGross - matchedFee;
        const matchedColor = matchedNet >= 0 ? '#10b981' : '#ef4444';

        const excessQty = Math.abs(s.qtyYes - s.qtyNo);
        const excessSide = s.qtyYes > s.qtyNo ? 'UP' : 'DOWN';
        const excessAvg = s.qtyYes > s.qtyNo ? s.avgYes : s.avgNo;
        const excessCost = excessQty * excessAvg;
        const excessColor = excessQty > 0 ? '#f59e0b' : '#10b981';
        const excessLabel = excessQty > 0 ? excessQty.toFixed(1) + ' ' + excessSide : 'Balanced';

        return `
    <div class="section-title">Current Window</div>
    <div class="grid grid-4">
      <div class="card card-accent">
        <div class="label">Pair Cost</div>
        <div class="value" style="color:${pairColor}">${s.pairCost.toFixed(4)}</div>
        <div class="sub">target &lt; $1.00</div>
      </div>
      <div class="card">
        <div class="label">Matched Profit</div>
        <div class="value" style="color:${matchedColor}">$${matchedNet.toFixed(2)}</div>
        <div class="sub">${matchedQty.toFixed(0)} pairs @ $${s.pairCost > 0 ? s.pairCost.toFixed(4) : '—'}</div>
      </div>
      <div class="card">
        <div class="label">Unmatched Exposure</div>
        <div class="value" style="color:${excessColor}">${excessLabel}</div>
        <div class="sub">${excessQty > 0 ? '$' + excessCost.toFixed(2) + ' catching up' : 'all paired'}</div>
      </div>
      <div class="card">
        <div class="label">Tracked Qty Up / Down</div>
        <div class="value">${s.trackedQtyYes.toFixed(1)} / ${s.trackedQtyNo.toFixed(1)}</div>
        <div class="sub">Actual wallet: ${s.actualQtyYes.toFixed(1)} / ${s.actualQtyNo.toFixed(1)}</div>
        <div class="sub">spent $${s.totalSpentUsd.toFixed(2)} / $${s.maxPositionPerWindowUsd.toFixed(0)}</div>
      </div>
    </div>
    <div style="display:grid;grid-template-columns:repeat(2,1fr);gap:14px;margin-top:14px;">
      <div class="card" style="border-color:rgba(59,130,246,0.35);">
        <div class="label">After PnL If Up <span style="font-weight:500;color:var(--text-muted);">(gross)</span></div>
        <div class="value" style="color:${s.afterPnlIfUpUsd >= 0 ? '#10b981' : '#ef4444'};">
          ${s.afterPnlIfUpUsd >= 0 ? '+' : ''}$${s.afterPnlIfUpUsd.toFixed(2)}
          <span style="font-size:0.75rem;color:var(--text-muted);"> · cum. fee $${(s.takerCommissionPaidUsd ?? 0).toFixed(2)}</span>
        </div>
        <div style="font-family:'JetBrains Mono',monospace;font-size:1.15rem;font-weight:700;color:${s.afterPnlIfUpExcludingCommissionUsd >= 0 ? '#10b981' : '#ef4444'};margin-top:8px;">
          Ex-commission profit: ${s.afterPnlIfUpExcludingCommissionUsd >= 0 ? '+' : ''}$${s.afterPnlIfUpExcludingCommissionUsd.toFixed(2)}
        </div>
        <div class="sub"><strong>Stock B / minDualAfterPnlUsd</strong> uses ex-commission (above), not gross. Notional spent $${(s.totalSpentUsd - (s.takerCommissionPaidUsd ?? 0)).toFixed(2)} · modeled cum. fee $${(s.takerCommissionPaidUsd ?? 0).toFixed(2)} = Σ&nbsp;C×k×p×(1−p) per taker fill, k=${(s.binaryOutcomeTakerFeeScalar ?? 0.072).toFixed(3)}.</div>
        <div class="sub">Gross: $${s.qtyYes.toFixed(0)} payout if Up wins &minus; $${s.totalSpentUsd.toFixed(2)} all-in spent (fee embedded in spend).</div>
      </div>
      <div class="card" style="border-color:rgba(139,92,246,0.35);">
        <div class="label">After PnL If Down <span style="font-weight:500;color:var(--text-muted);">(gross)</span></div>
        <div class="value" style="color:${s.afterPnlIfDownUsd >= 0 ? '#10b981' : '#ef4444'};">
          ${s.afterPnlIfDownUsd >= 0 ? '+' : ''}$${s.afterPnlIfDownUsd.toFixed(2)}
          <span style="font-size:0.75rem;color:var(--text-muted);"> · cum. fee $${(s.takerCommissionPaidUsd ?? 0).toFixed(2)}</span>
        </div>
        <div style="font-family:'JetBrains Mono',monospace;font-size:1.15rem;font-weight:700;color:${s.afterPnlIfDownExcludingCommissionUsd >= 0 ? '#10b981' : '#ef4444'};margin-top:8px;">
          Ex-commission profit: ${s.afterPnlIfDownExcludingCommissionUsd >= 0 ? '+' : ''}$${s.afterPnlIfDownExcludingCommissionUsd.toFixed(2)}
        </div>
        <div class="sub"><strong>Stock B / minDualAfterPnlUsd</strong> uses ex-commission (above), not gross. Notional spent $${(s.totalSpentUsd - (s.takerCommissionPaidUsd ?? 0)).toFixed(2)} · modeled cum. fee $${(s.takerCommissionPaidUsd ?? 0).toFixed(2)} (same window total as Up; Σ&nbsp;C×k×p×(1−p) per taker fill).</div>
        <div class="sub">Gross: $${s.qtyNo.toFixed(0)} payout if Down wins &minus; $${s.totalSpentUsd.toFixed(2)} all-in spent.</div>
      </div>
    </div>
    ${(() => {
        const nowSide = s.entryDecisionNow?.suggestedSide ?? null;
        const sentimentBg =
            nowSide === 'YES'
                ? 'rgba(59,130,246,0.15)'
                : nowSide === 'NO'
                  ? 'rgba(139,92,246,0.15)'
                  : 'rgba(148,163,184,0.12)';
        const sentimentBorder =
            nowSide === 'YES'
                ? 'rgba(59,130,246,0.45)'
                : nowSide === 'NO'
                  ? 'rgba(139,92,246,0.45)'
                  : 'rgba(148,163,184,0.35)';
        const sentimentText =
            nowSide === 'YES' ? '#60a5fa' : nowSide === 'NO' ? '#a78bfa' : 'var(--text-muted)';
        const gap = s.btcGapUsd;
        const maxGapUsd = 150;
        let meterLeftPct = 50;
        let meterWidthPct = 0;
        let gapColor = 'var(--text-muted)';
        let gapStr = '—';
        let meterFillBg = 'linear-gradient(90deg,#334155,#475569)';
        if (gap != null && Number.isFinite(gap)) {
            gapStr = (gap >= 0 ? '+' : '') + gap.toFixed(1) + ' USD';
            gapColor = gap >= 0 ? '#10b981' : '#ef4444';
            meterWidthPct = Math.min(50, (Math.abs(gap) / maxGapUsd) * 50);
            meterLeftPct = gap >= 0 ? 50 : 50 - meterWidthPct;
            meterFillBg =
                gap >= 0
                    ? 'linear-gradient(90deg,#10b981,#059669)'
                    : 'linear-gradient(90deg,#ef4444,#b91c1c)';
        }
        const spotStr =
            s.btcUsdSpot != null && Number.isFinite(s.btcUsdSpot)
                ? '$' + s.btcUsdSpot.toLocaleString('en-US', { maximumFractionDigits: 0 })
                : '—';
        const openStr =
            s.btcUsdWindowOpen != null && Number.isFinite(s.btcUsdWindowOpen)
                ? '$' + s.btcUsdWindowOpen.toLocaleString('en-US', { maximumFractionDigits: 0 })
                : '—';
        const vel = s.btcGapVelocityUsdPerSec;
        const velStr =
            vel == null || !Number.isFinite(vel)
                ? '—'
                : (vel >= 0 ? '+' : '') + vel.toFixed(2) + ' $/s';
        const pred = s.btcGapPredicted60sUsd;
        const predStr =
            pred == null || !Number.isFinite(pred)
                ? '—'
                : (pred >= 0 ? '+' : '') + pred.toFixed(1) + ' USD';
        const momOn = s.momentumInversionHedgeEnabled !== false;
        const flipLine = s.btcGapFlipDetectedThisTick
            ? '<span style="color:#fca5a5;font-weight:700;">Sign flip → momentum hedge eligible</span>'
            : '<span style="color:var(--text-muted);">No sign flip this tick</span>';
        return `
      <div id="floatingEntrySignal" class="floating-entry-signal pos-left-center" style="background:${sentimentBg};border-color:${sentimentBorder};">
        <div class="title">Mandatory Purchase Signal</div>
        <div class="market-line">${marketHeadlineHtml(s)}</div>
        <div class="next" style="color:${sentimentText};">
          ${nowSide === 'YES' ? 'BUY UP NEXT (YES)' : nowSide === 'NO' ? 'BUY DOWN NEXT (NO)' : 'WAITING FOR SIGNAL'}
        </div>
        <div id="momMomentumRoot" class="mom-momentum-block">
          <div class="mom-label">BTC momentum · spot − window open (updates ~1.5s)</div>
          <div id="momGapHero" class="mom-gap-hero" style="color:${gapColor};">${gapStr}</div>
          <div class="momentum-meter-track" aria-hidden="true">
            <div class="momentum-meter-mid"></div>
            <div id="momMeterFill" class="momentum-meter-fill" style="left:${meterLeftPct}%;width:${meterWidthPct}%;background:${meterFillBg};"></div>
          </div>
          <div class="mom-stat-grid">
            <div><span class="k">Spot / Open</span><br><span id="momSpotOpen">${spotStr} / ${openStr}</span></div>
            <div><span class="k">±$${s.btcGapSignDeadZoneUsd.toFixed(0)} neutral · hedge</span><br><span id="momHedgeOn" style="color:${momOn ? '#10b981' : '#94a3b8'}">${momOn ? 'ON' : 'OFF'}</span></div>
            <div><span class="k">Trend ($/s)</span><br><span id="momVel">${velStr}</span></div>
            <div><span class="k">Est. gap +60s</span><br><span id="momPred" style="color:#a78bfa;">${predStr}</span></div>
          </div>
          <div id="momFlipLine" style="font-size:0.8rem;margin-top:8px;line-height:1.4;">${flipLine}</div>
          <div style="font-size:0.78rem;color:var(--text-muted);margin-top:12px;padding-top:10px;border-top:1px solid rgba(148,163,184,0.2);line-height:1.5;">
            <strong style="color:#a78bfa;">Down ask momentum</strong> (CLOB, separate from BTC):<br/>
            <span id="momDownVel">—</span> · est. at expiry: <span id="momDownPred">—</span><br/>
            <span id="momDownEarly" style="font-size:0.74rem;">Early hedge: </span>
          </div>
        </div>
        <form method="post" action="/killSwitch" style="margin:8px 0 10px;">
          <input type="hidden" name="on" value="${s.killSwitch ? '0' : '1'}" />
          <button type="submit" style="width:100%;padding:10px 12px;border-radius:8px;border:none;cursor:pointer;font-weight:700;font-size:0.86rem;color:#fff;background:${s.killSwitch ? 'linear-gradient(135deg,#059669,#047857)' : 'linear-gradient(135deg,#dc2626,#b91c1c)'};">
            ${s.killSwitch ? 'Resume Trading' : 'Emergency Stop'}
          </button>
        </form>
        <div class="floating-entry-controls">
          <label for="fixedSignalPos">Position</label>
          <select id="fixedSignalPos">
            <option value="left-center">Left Center</option>
            <option value="right-center">Right Center</option>
            <option value="top-left">Top Left</option>
            <option value="top-right">Top Right</option>
            <option value="bottom-left">Bottom Left</option>
            <option value="bottom-right">Bottom Right</option>
          </select>
        </div>
        <div class="mini">
          ${s.entryDecisionNow ? `Current next-rule: <strong>${formatEntryReason(s.entryDecisionNow.reasonCode)}</strong>` : 'No current decision snapshot yet.'}
          ${s.lastExecutedEntry ? `<br>Last executed reason: <strong>${s.lastExecutedEntry.shares.toFixed(0)} ${s.lastExecutedEntry.side === 'YES' ? 'UP' : 'DOWN'}</strong> @ $${s.lastExecutedEntry.price.toFixed(4)} (${formatEntryReason(s.lastExecutedEntry.reasonCode)})` : ''}
        </div>
        <div id="manualBuyDock" style="margin-top:10px;padding-top:10px;border-top:1px solid rgba(148,163,184,0.2);">
          <div style="font-size:0.76rem;color:var(--text-muted);text-transform:uppercase;letter-spacing:0.07em;margin-bottom:8px;">Manual buy (FOK at ask)</div>
          <div style="display:flex;flex-wrap:wrap;gap:10px;align-items:flex-end;margin-bottom:10px;">
            <div>
              <div style="font-size:0.76rem;color:var(--text-muted);margin-bottom:4px;">Side</div>
              <label style="margin-right:12px;cursor:pointer;font-size:0.84rem;"><input type="radio" name="manualSide" value="YES" checked> Up</label>
              <label style="cursor:pointer;font-size:0.84rem;"><input type="radio" name="manualSide" value="NO"> Down</label>
            </div>
            <div>
              <div style="font-size:0.76rem;color:var(--text-muted);margin-bottom:4px;">Shares</div>
              <input type="number" id="manualShares" step="1" value="10" placeholder="shares" style="width:92px;padding:7px 9px;border-radius:8px;border:1px solid var(--border);background:var(--bg-secondary);color:var(--text-primary);font-family:'JetBrains Mono',monospace;font-size:0.84rem;">
            </div>
            <button type="button" id="manualBuyBtn" title="FOK at best ask + 1 tick (cap 0.99) for the entered share count. Cancels any resting bot order first; live syncs window from chain before buy. CLOB $1 min still applies." style="padding:9px 14px;border-radius:8px;border:none;background:linear-gradient(135deg,#f59e0b,#d97706);color:#0a0e1a;font-weight:700;cursor:pointer;font-size:0.84rem;">Buy now</button>
            <button type="button" id="manualAutoBuyBtn" title="Live: reads on-chain YES/NO balances, then FOK-buys the lighter side so quantities match (one-sided: full opposite leg). No strategy gates." style="padding:9px 14px;border-radius:8px;border:1px solid rgba(34,197,94,0.45);background:linear-gradient(135deg,#15803d,#166534);color:#ecfdf5;font-weight:700;cursor:pointer;font-size:0.84rem;">Auto buy</button>
          </div>
          <div style="font-size:0.72rem;color:var(--text-muted);margin-top:6px;line-height:1.45;">Auto buy: uses current inventory (After P/L Up/Down) to FOK the opposite side — one-sided: match share count; both legs: buy the lighter side by |Up−Down|.</div>
          <div style="font-size:0.76rem;color:var(--text-muted);margin-bottom:4px;">Last API result</div>
          <pre id="manualResult" style="font-size:0.78rem;overflow:auto;max-height:140px;background:rgba(0,0,0,0.35);padding:10px;border-radius:8px;color:#94a3b8;margin:0;">&mdash;</pre>
        </div>
      </div>
      `;
    })()}`;
    })()}

    <!-- Active Pair Position (shows when we have filled shares) -->
    ${
        s.qtyYes > 0 || s.qtyNo > 0
            ? (() => {
                  const hasBoth = s.qtyYes > 0 && s.qtyNo > 0;
                  const minQty = Math.min(s.qtyYes, s.qtyNo);
                  const totalCost = s.costYes + s.costNo;

                  // MATCHED pairs P/L (the REAL profit indicator)
                  const matchedCostYes = minQty * s.avgYes;
                  const matchedCostNo = minQty * s.avgNo;
                  const matchedCost = matchedCostYes + matchedCostNo;
                  const matchedPayout = minQty;
                  const matchedGross = matchedPayout - matchedCost;
                  const feeRateM = (s.feeBipsAssumption || 0) / 10000;
                  const matchedFee =
                      minQty > 0 && s.qtyYes > 0 && s.qtyNo > 0
                          ? polymarketBinaryTakerFeeUsd(minQty, s.avgYes, feeRateM) +
                            polymarketBinaryTakerFeeUsd(minQty, s.avgNo, feeRateM)
                          : 0;
                  const matchedNet = matchedGross - matchedFee;
                  const matchedNetColor = matchedNet >= 0 ? '#10b981' : '#ef4444';

                  // UNMATCHED excess shares (temporary — catching up)
                  const excessQty = Math.abs(s.qtyYes - s.qtyNo);
                  const excessSide = s.qtyYes > s.qtyNo ? 'UP (YES)' : 'DOWN (NO)';
                  const excessAvg = s.qtyYes > s.qtyNo ? s.avgYes : s.avgNo;
                  const excessCost = excessQty * excessAvg;

                  // Worst case = if unmatched shares are worth $0
                  const worstCase = matchedNet - excessCost;
                  const worstColor = worstCase >= 0 ? '#10b981' : '#ef4444';

                  const yesLive = s.liveBestBidYes;
                  const noLive = s.liveBestBidNo;
                  const yesDiff = s.avgYes > 0 ? yesLive - s.avgYes : 0;
                  const noDiff = s.avgNo > 0 ? noLive - s.avgNo : 0;
                  const yesDiffColor = yesDiff >= 0 ? '#10b981' : '#ef4444';
                  const noDiffColor = noDiff >= 0 ? '#10b981' : '#ef4444';
                  const yesArrow = yesDiff >= 0 ? '&#9650;' : '&#9660;';
                  const noArrow = noDiff >= 0 ? '&#9650;' : '&#9660;';

                  return `
    <div class="section-title">Active Pair Position</div>
    <div style="background:var(--bg-card);border:1px solid var(--border);border-radius:12px;padding:18px;margin-bottom:24px;">

      <!-- YES and NO side-by-side cards -->
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:14px;margin-bottom:16px;">

        <!-- YES (Up) Card -->
        <div style="background:rgba(59,130,246,0.06);border:1px solid rgba(59,130,246,0.2);border-radius:10px;padding:16px;">
          <div style="display:flex;align-items:center;gap:8px;margin-bottom:14px;">
            <span style="background:#3b82f6;color:white;font-size:0.68rem;font-weight:700;padding:3px 10px;border-radius:12px;letter-spacing:0.05em;">UP (YES)</span>
            <span style="font-size:0.7rem;color:var(--text-muted);">${s.qtyYes > 0 ? 'FILLED' : 'EMPTY'}</span>
          </div>
          ${
              s.qtyYes > 0
                  ? `
          <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px;">
            <div>
              <div style="font-size:0.62rem;color:var(--text-muted);text-transform:uppercase;margin-bottom:3px;">Shares</div>
              <div style="font-family:'JetBrains Mono',monospace;font-size:1.2rem;font-weight:700;">${s.qtyYes}</div>
              <div style="font-size:0.7rem;color:var(--text-muted);margin-top:2px;">Actual: ${s.actualQtyYes.toFixed(1)}</div>
            </div>
            <div>
              <div style="font-size:0.62rem;color:var(--text-muted);text-transform:uppercase;margin-bottom:3px;">Total Cost</div>
              <div style="font-family:'JetBrains Mono',monospace;font-size:1.2rem;font-weight:700;">$${s.costYes.toFixed(2)}</div>
            </div>
            <div>
              <div style="font-size:0.62rem;color:var(--text-muted);text-transform:uppercase;margin-bottom:3px;">Entry Price</div>
              <div style="font-family:'JetBrains Mono',monospace;font-size:1.1rem;font-weight:700;color:var(--text-primary);">$${s.avgYes.toFixed(4)}</div>
            </div>
            <div>
              <div style="font-size:0.62rem;color:var(--text-muted);text-transform:uppercase;margin-bottom:3px;">Live Price</div>
              <div style="font-family:'JetBrains Mono',monospace;font-size:1.1rem;font-weight:700;color:${yesDiffColor};">$${yesLive.toFixed(4)}</div>
              <div style="font-size:0.75rem;color:${yesDiffColor};font-family:'JetBrains Mono',monospace;margin-top:2px;">
                ${yesArrow} ${yesDiff >= 0 ? '+' : ''}${yesDiff.toFixed(4)}
              </div>
            </div>
          </div>
          `
                  : `
          <div style="text-align:center;padding:12px;color:var(--text-muted);font-size:0.82rem;">No YES shares yet</div>
          `
          }
        </div>

        <!-- NO (Down) Card -->
        <div style="background:rgba(139,92,246,0.06);border:1px solid rgba(139,92,246,0.2);border-radius:10px;padding:16px;">
          <div style="display:flex;align-items:center;gap:8px;margin-bottom:14px;">
            <span style="background:#8b5cf6;color:white;font-size:0.68rem;font-weight:700;padding:3px 10px;border-radius:12px;letter-spacing:0.05em;">DOWN (NO)</span>
            <span style="font-size:0.7rem;color:var(--text-muted);">${s.qtyNo > 0 ? 'FILLED' : 'EMPTY'}</span>
          </div>
          ${
              s.qtyNo > 0
                  ? `
          <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px;">
            <div>
              <div style="font-size:0.62rem;color:var(--text-muted);text-transform:uppercase;margin-bottom:3px;">Shares</div>
              <div style="font-family:'JetBrains Mono',monospace;font-size:1.2rem;font-weight:700;">${s.qtyNo}</div>
              <div style="font-size:0.7rem;color:var(--text-muted);margin-top:2px;">Actual: ${s.actualQtyNo.toFixed(1)}</div>
            </div>
            <div>
              <div style="font-size:0.62rem;color:var(--text-muted);text-transform:uppercase;margin-bottom:3px;">Total Cost</div>
              <div style="font-family:'JetBrains Mono',monospace;font-size:1.2rem;font-weight:700;">$${s.costNo.toFixed(2)}</div>
            </div>
            <div>
              <div style="font-size:0.62rem;color:var(--text-muted);text-transform:uppercase;margin-bottom:3px;">Entry Price</div>
              <div style="font-family:'JetBrains Mono',monospace;font-size:1.1rem;font-weight:700;color:var(--text-primary);">$${s.avgNo.toFixed(4)}</div>
            </div>
            <div>
              <div style="font-size:0.62rem;color:var(--text-muted);text-transform:uppercase;margin-bottom:3px;">Live Price</div>
              <div style="font-family:'JetBrains Mono',monospace;font-size:1.1rem;font-weight:700;color:${noDiffColor};">$${noLive.toFixed(4)}</div>
              <div style="font-size:0.75rem;color:${noDiffColor};font-family:'JetBrains Mono',monospace;margin-top:2px;">
                ${noArrow} ${noDiff >= 0 ? '+' : ''}${noDiff.toFixed(4)}
              </div>
            </div>
          </div>
          `
                  : `
          <div style="text-align:center;padding:12px;color:var(--text-muted);font-size:0.82rem;">No NO shares yet</div>
          `
          }
        </div>
      </div>

      <!-- Summary bar at bottom -->
      <div style="background:rgba(0,0,0,0.25);border-radius:10px;padding:14px 18px;">
        <div style="display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:10px;">
          <div style="display:flex;gap:20px;flex-wrap:wrap;">
            <div style="text-align:center;">
              <div style="font-size:0.6rem;color:var(--text-muted);text-transform:uppercase;margin-bottom:3px;">Matched Pairs</div>
              <div style="font-family:'JetBrains Mono',monospace;font-size:1.1rem;font-weight:700;color:#10b981;">${minQty.toFixed(0)}</div>
              <div style="font-size:0.65rem;color:var(--text-muted);">cost $${matchedCost.toFixed(2)} &rarr; payout $${matchedPayout.toFixed(2)}</div>
            </div>
            <div style="text-align:center;">
              <div style="font-size:0.6rem;color:var(--text-muted);text-transform:uppercase;margin-bottom:3px;">Pair Cost</div>
              <div style="font-family:'JetBrains Mono',monospace;font-size:1.1rem;font-weight:700;color:${s.pairCost < 0.98 ? '#10b981' : '#ef4444'};">${s.pairCost.toFixed(4)}</div>
              <div style="font-size:0.65rem;color:var(--text-muted);">avg $${s.avgYes.toFixed(2)} + $${s.avgNo.toFixed(2)}</div>
            </div>
            ${
                excessQty > 0
                    ? `
            <div style="text-align:center;">
              <div style="font-size:0.6rem;color:var(--text-muted);text-transform:uppercase;margin-bottom:3px;">Unmatched</div>
              <div style="font-family:'JetBrains Mono',monospace;font-size:1.1rem;font-weight:700;color:#f59e0b;">${excessQty.toFixed(1)} ${excessSide}</div>
              <div style="font-size:0.65rem;color:var(--text-muted);">$${excessCost.toFixed(2)} catching up</div>
            </div>`
                    : ''
            }
          </div>
          <div style="text-align:center;min-width:150px;">
            <div style="font-size:0.6rem;color:var(--text-muted);text-transform:uppercase;margin-bottom:3px;">Matched Net Profit</div>
            <div style="font-family:'JetBrains Mono',monospace;font-size:1.6rem;font-weight:700;color:${matchedNetColor};">${matchedNet >= 0 ? '+' : ''}$${matchedNet.toFixed(2)}</div>
            <div style="font-size:0.65rem;color:var(--text-muted);">gross $${matchedGross.toFixed(2)} &minus; fee ~$${matchedFee.toFixed(2)}</div>
            ${excessQty > 0 ? `<div style="font-size:0.62rem;color:${worstColor};margin-top:3px;">worst case: $${worstCase.toFixed(2)}</div>` : ''}
          </div>
        </div>
        ${!hasBoth ? '<div style="margin-top:10px;text-align:center;font-size:0.75rem;color:#f59e0b;font-weight:500;">&#9888; Only one side filled &mdash; bot is placing the other side to catch up</div>' : ''}
        ${hasBoth && excessQty > 0 ? '<div style="margin-top:10px;text-align:center;font-size:0.75rem;color:#f59e0b;font-weight:500;">&#9888; ' + excessQty.toFixed(0) + ' unmatched ' + excessSide + ' shares &mdash; bot is catching up on the other side</div>' : ''}
        ${hasBoth && excessQty === 0 ? '<div style="margin-top:10px;text-align:center;font-size:0.75rem;color:#10b981;font-weight:500;">&#9989; Perfectly hedged &mdash; all shares are paired</div>' : ''}
      </div>
    </div>`;
              })()
            : ''
    }

    ${(() => {
        if (!s.windowEndIso) return '';
        const windowOrders = getOrdersForWindowDisplay(s);
        if (windowOrders.length === 0) return '';
        let runY = 0;
        let runN = 0;
        let runSpent = 0;
        let rows = '';
        for (let i = 0; i < windowOrders.length; i++) {
            const o = windowOrders[i];
            runSpent += o.costUsd;
            if (o.side === 'YES') runY += o.size;
            else runN += o.size;
            const pUp = runY - runSpent;
            const pDown = runN - runSpent;
            const cUp = pUp >= 0 ? '#10b981' : '#ef4444';
            const cDown = pDown >= 0 ? '#10b981' : '#ef4444';
            rows +=
                '<tr style="border-bottom:1px solid rgba(42,48,80,0.5);">' +
                '<td style="padding:8px 10px;">' +
                (i + 1) +
                '</td>' +
                '<td style="padding:8px 10px;">' +
                new Date(o.timestamp).toLocaleTimeString() +
                '</td>' +
                '<td style="padding:8px 10px;">' +
                o.sideLabel +
                '</td>' +
                '<td style="padding:8px 10px;font-family:\'JetBrains Mono\',monospace;">' +
                o.size +
                '</td>' +
                '<td style="padding:8px 10px;font-family:\'JetBrains Mono\',monospace;">$' +
                o.price.toFixed(4) +
                '</td>' +
                '<td style="padding:8px 10px;font-family:\'JetBrains Mono\',monospace;">$' +
                o.costUsd.toFixed(2) +
                '</td>' +
                '<td style="padding:8px 10px;font-weight:600;color:' +
                cUp +
                ";font-family:'JetBrains Mono',monospace;\">" +
                (pUp >= 0 ? '+' : '') +
                '$' +
                pUp.toFixed(2) +
                '</td>' +
                '<td style="padding:8px 10px;font-weight:600;color:' +
                cDown +
                ";font-family:'JetBrains Mono',monospace;\">" +
                (pDown >= 0 ? '+' : '') +
                '$' +
                pDown.toFixed(2) +
                '</td>' +
                '</tr>';
        }
        return (
            `
    <div class="section-title">After each purchase &mdash; settlement P/L</div>
    <div style="background:var(--bg-card);border:1px solid var(--border);border-radius:12px;padding:18px;margin-bottom:24px;">
      <div style="font-size:0.72rem;color:var(--text-muted);margin-bottom:12px;">
        Running totals after each recorded fill (${s.liveTrading ? 'live: CLOB getTrades BUY (authoritative), else internal log' : 'paper session'}).${s.liveTrading && s.liveClobTradesFetchedAtIso ? ' CLOB synced ' + escapeHtml(s.liveClobTradesFetchedAtIso) + '.' : ''}${s.liveTrading && s.liveClobTradesError ? ' <span style="color:#ef4444;">CLOB error: ' + escapeHtml(s.liveClobTradesError) + '</span>' : ''} <strong>After PnL If Up/Down</strong> here are <em>gross</em> (payout minus cumulative all-in cost, which includes modeled taker commission on taker fills). Ex-commission P/L for gates is on the <strong>After PnL</strong> cards above. Realized session P/L is under <strong>Last closed window</strong> and <strong>Cumulative P/L</strong> after Polymarket settles.
      </div>
      <div style="overflow-x:auto;">
      <table style="width:100%;border-collapse:collapse;font-size:0.78rem;min-width:640px;">
        <thead><tr style="text-align:left;border-bottom:1px solid var(--border);">
          <th style="padding:8px 10px;">#</th>
          <th style="padding:8px 10px;">Time</th>
          <th style="padding:8px 10px;">Side</th>
          <th style="padding:8px 10px;">Size</th>
          <th style="padding:8px 10px;">Price</th>
          <th style="padding:8px 10px;">Cost</th>
          <th style="padding:8px 10px;">After PnL If Up</th>
          <th style="padding:8px 10px;">After PnL If Down</th>
        </tr></thead>
        <tbody>` +
            rows +
            `</tbody>
      </table>
      </div>
    </div>`
        );
    })()}

    <!-- Session & Risk -->
    <div class="section-title">Session &amp; Risk</div>
    ${(() => {
        const lastNet = s.lastClosedWindowNetUsd;
        const lastWin = s.lastClosedWindowWinner;
        const lastNetStr =
            lastNet == null || !Number.isFinite(lastNet)
                ? '—'
                : (lastNet >= 0 ? '+' : '') + '$' + lastNet.toFixed(2);
        const lastWinStr =
            lastWin === 'YES' ? 'Up (YES)' : lastWin === 'NO' ? 'Down (NO)' : lastWin === 'UNKNOWN' ? 'Pending' : '—';
        const lastNetColor =
            lastNet == null || !Number.isFinite(lastNet)
                ? 'var(--text-secondary)'
                : lastNet >= 0
                  ? '#10b981'
                  : '#ef4444';
        return `
    <div class="grid grid-4" style="margin-bottom:14px;">
      <div class="card" style="border-color:rgba(16,185,129,0.35);">
        <div class="label">Last closed window — realized P/L</div>
        <div class="value" style="color:${lastNetColor};font-size:1.35rem;">${lastNetStr}</div>
        <div class="sub">Sum of payouts $1/share on winning side &minus; spend &minus; fees (paper). Updates when Gamma reports the winner.</div>
      </div>
      <div class="card" style="border-color:rgba(59,130,246,0.35);">
        <div class="label">Winner (last closed)</div>
        <div class="value" style="font-size:1.15rem;">${lastWinStr}</div>
        <div class="sub">“Pending” means API had not resolved yet; bot will reconcile automatically.</div>
      </div>
    </div>`;
    })()}
    <div class="grid grid-4">
      <div class="card">
        <div class="label">Cumulative P/L</div>
        <div class="value" style="color:${cumulColor}">$${s.cumulativeProfitUsd.toFixed(2)}</div>
        <div class="sub">Sum of realized net per closed window (same basis as last window).</div>
      </div>
      <div class="card">
        <div class="label">Windows Completed</div>
        <div class="value">${s.completedWindows}</div>
      </div>
      <div class="card">
        <div class="label">Pending / Failures</div>
        <div class="value" style="color:${s.pendingOrders > 0 ? '#f59e0b' : s.consecutiveFailures > 0 ? '#ef4444' : 'var(--text-secondary)'}">
          ${s.pendingOrders} / ${s.consecutiveFailures}
        </div>
        <div class="sub">redeem queue ${s.redeemQueueSize}</div>
        <div class="sub">last sweep: ${s.lastRedeemSweepIso ? new Date(s.lastRedeemSweepIso).toLocaleTimeString() : '—'} (${s.lastRedeemSweepResult})</div>
      </div>
    </div>

    ${
        !s.liveTrading
            ? (() => {
                  const simBal = getSimulatedBalance();
                  const h24 = getLast24hSummary();
                  const wins = getCompletedWindowsDetail();
                  const netColor24 = h24.netProfit >= 0 ? '#10b981' : '#ef4444';
                  let historyHtml =
                      '<div class="section-title">📋 Paper Trading — Trading History</div>';
                  historyHtml +=
                      '<div style="background:linear-gradient(135deg,rgba(99,102,241,0.12),rgba(139,92,246,0.08));border:1px solid var(--border);border-radius:12px;padding:18px;margin-bottom:24px;">';
                  historyHtml +=
                      '<div style="display:flex;flex-wrap:wrap;gap:16px;align-items:center;margin-bottom:16px;">';
                  historyHtml +=
                      '<div><span style="font-size:0.68rem;color:var(--text-muted);text-transform:uppercase;">Simulated balance</span><div style="font-family:\'JetBrains Mono\',monospace;font-size:1.6rem;font-weight:700;color:#6366f1;">$' +
                      simBal.toFixed(2) +
                      '</div></div>';
                  historyHtml +=
                      '<div style="margin-left:20px;padding-left:20px;border-left:1px solid var(--border);"><span style="font-size:0.68rem;color:var(--text-muted);text-transform:uppercase;">Last 24h</span>';
                  historyHtml +=
                      '<div style="font-size:0.85rem;">Windows: <strong>' +
                      h24.windowsCount +
                      '</strong> &nbsp;|&nbsp; Orders: <strong>' +
                      h24.ordersCount +
                      '</strong> &nbsp;|&nbsp; Spent: $' +
                      h24.totalSpent.toFixed(2) +
                      ' &nbsp;|&nbsp; Payout: $' +
                      h24.totalPayout.toFixed(2) +
                      '</div>';
                  historyHtml +=
                      '<div style="font-size:1rem;font-weight:700;color:' +
                      netColor24 +
                      ';">Net P/L: ' +
                      (h24.netProfit >= 0 ? '+' : '') +
                      '$' +
                      h24.netProfit.toFixed(2) +
                      '</div></div>';
                  historyHtml += '</div>';
                  const startPaper = getPaperSessionStartingBalanceUsd();
                  historyHtml +=
                      '<div style="font-size:0.72rem;color:var(--text-muted);margin-bottom:12px;">Session start: <strong>$' +
                      startPaper.toFixed(2) +
                      '</strong> · <strong>Balance</strong> = start + cumulative Net P/L through that window (chronological). Each row is one market window; expand for orders.</div>';
                  historyHtml +=
                      '<table style="width:100%;border-collapse:collapse;font-size:0.78rem;">';
                  historyHtml +=
                      '<thead><tr style="text-align:left;border-bottom:1px solid var(--border);">';
                  historyHtml +=
                      '<th style="padding:8px 10px;">Window end</th><th style="padding:8px 10px;">BTC</th><th style="padding:8px 10px;">Market</th><th style="padding:8px 10px;"># Orders</th>';
                  historyHtml +=
                      '<th style="padding:8px 10px;">BTC open</th><th style="padding:8px 10px;">BTC end</th><th style="padding:8px 10px;">Src</th>';
                  historyHtml +=
                      '<th style="padding:8px 10px;">Winner</th><th style="padding:8px 10px;">Spent</th><th style="padding:8px 10px;">Payout</th><th style="padding:8px 10px;">Net P/L</th><th style="padding:8px 10px;">Balance</th><th style="padding:8px 10px;"></th></tr></thead><tbody>';
                  wins.slice()
                      .reverse()
                      .forEach((w, idx) => {
                          const netColor = w.netProfit >= 0 ? '#10b981' : '#ef4444';
                          const rowId = 'wh-' + idx;
                          const btcM = w.btcMarketWindowMinutes;
                          historyHtml += '<tr style="border-bottom:1px solid rgba(42,48,80,0.5);">';
                          historyHtml +=
                              '<td style="padding:8px 10px;">' +
                              new Date(w.windowEndIso).toLocaleString() +
                              '</td>';
                          historyHtml +=
                              '<td style="padding:8px 10px;">' +
                              (btcM != null ? btcM + 'm' : '—') +
                              '</td>';
                          historyHtml +=
                              '<td style="padding:8px 10px;">' +
                              (w.windowSlug || w.windowEndIso).slice(0, 28) +
                              '</td>';
                          historyHtml += '<td style="padding:8px 10px;">' + w.orderCount + '</td>';
                          const btcOpenCell =
                              w.btcUsdWindowOpen != null && Number.isFinite(w.btcUsdWindowOpen)
                                  ? w.btcUsdWindowOpen.toFixed(2)
                                  : '—';
                          const btcEndCell =
                              w.btcUsdWindowEnd != null && Number.isFinite(w.btcUsdWindowEnd)
                                  ? w.btcUsdWindowEnd.toFixed(2)
                                  : '—';
                          const srcCell = w.settlementWinnerSource ? String(w.settlementWinnerSource) : '—';
                          historyHtml += '<td style="padding:8px 10px;">' + btcOpenCell + '</td>';
                          historyHtml += '<td style="padding:8px 10px;">' + btcEndCell + '</td>';
                          historyHtml +=
                              '<td style="padding:8px 10px;font-size:0.7rem;">' + srcCell + '</td>';
                          const winnerLabel =
                              w.winnerSide === 'YES' ? 'Up' : w.winnerSide === 'NO' ? 'Down' : '—';
                          historyHtml += '<td style="padding:8px 10px;">' + winnerLabel + '</td>';
                          historyHtml +=
                              '<td style="padding:8px 10px;">$' +
                              w.totalSpentUsd.toFixed(2) +
                              '</td>';
                          historyHtml +=
                              '<td style="padding:8px 10px;">$' +
                              w.payoutReceived.toFixed(2) +
                              '</td>';
                          historyHtml +=
                              '<td style="padding:8px 10px;font-weight:600;color:' +
                              netColor +
                              '">' +
                              (w.netProfit >= 0 ? '+' : '') +
                              '$' +
                              w.netProfit.toFixed(2) +
                              '</td>';
                          historyHtml +=
                              '<td style="padding:8px 10px;">$' +
                              (w.balanceAfterUsd ?? 0).toFixed(2) +
                              '</td>';
                          historyHtml +=
                              '<td style="padding:8px 10px;"><button type="button" onclick="var r=document.getElementById(\'' +
                              rowId +
                              "'); r.style.display=r.style.display==='none'?'':'none';\" style=\"background:var(--border);border:none;color:var(--text-secondary);padding:4px 10px;border-radius:6px;cursor:pointer;font-size:0.7rem;\">Orders</button></td></tr>";
                          historyHtml +=
                              '<tr id="' +
                              rowId +
                              '" style="display:none;"><td colspan="13" style="padding:0 10px 12px;background:rgba(0,0,0,0.2);">';
                          historyHtml +=
                              '<table style="width:100%;font-size:0.72rem;margin-top:8px;"><tr style="color:var(--text-muted);"><th style="text-align:left;padding:4px 8px;">Time</th><th style="padding:4px 8px;">Side</th><th style="padding:4px 8px;">Price</th><th style="padding:4px 8px;">Size</th><th style="padding:4px 8px;">Cost</th><th style="padding:4px 8px;">Result</th><th style="padding:4px 8px;">P/L</th></tr>';
                          w.orders.forEach((o) => {
                              const resolved = o.winnerSide ? true : false;
                              const won = resolved && o.side === o.winnerSide;
                              const resLabel = !resolved ? '—' : won ? 'WIN' : 'LOSE';
                              const pnl = o.realizedPnlUsd ?? 0;
                              const pnlColor = !resolved
                                  ? 'var(--text-muted)'
                                  : pnl >= 0
                                    ? '#10b981'
                                    : '#ef4444';
                              historyHtml +=
                                  '<tr><td style="padding:4px 8px;">' +
                                  new Date(o.timestamp).toLocaleTimeString() +
                                  '</td>' +
                                  '<td style="padding:4px 8px;">' +
                                  o.sideLabel +
                                  '</td>' +
                                  '<td style="padding:4px 8px;">$' +
                                  o.price.toFixed(4) +
                                  '</td>' +
                                  '<td style="padding:4px 8px;">' +
                                  o.size +
                                  '</td>' +
                                  '<td style="padding:4px 8px;">$' +
                                  o.costUsd.toFixed(2) +
                                  '</td>' +
                                  '<td style="padding:4px 8px;">' +
                                  resLabel +
                                  '</td>' +
                                  '<td style="padding:4px 8px;font-weight:600;color:' +
                                  pnlColor +
                                  ';">' +
                                  (!resolved ? '—' : (pnl >= 0 ? '+' : '') + '$' + pnl.toFixed(2)) +
                                  '</td></tr>';
                          });
                          historyHtml += '</table></td></tr>';
                      });
                  historyHtml += '</tbody></table></div>';
                  return historyHtml;
              })()
            : buildLiveSessionOrderHistoryHtml(s)
    }

    <!-- Status message -->
    <div class="status-msg">${s.message}</div>

    <!-- Your Orders vs Market -->
    ${
        s.entryOrderYes || s.entryOrderNo
            ? (() => {
                  const rows: string[] = [];
                  if (s.entryOrderYes) {
                      const entry = s.entryOrderYes.price;
                      const current = s.liveBestBidYes;
                      const diff = current - entry;
                      const diffColor = diff >= 0 ? '#10b981' : '#ef4444';
                      const arrow = diff >= 0 ? '&#9650;' : '&#9660;';
                      const age = Math.floor(
                          (Date.now() - new Date(s.entryOrderYes.placedAt).getTime()) / 1000
                      );
                      rows.push(
                          '<div style="display:flex;align-items:center;justify-content:space-between;padding:10px 14px;' +
                              'background:rgba(59,130,246,0.06);border:1px solid rgba(59,130,246,0.15);border-radius:8px;flex-wrap:wrap;gap:8px;">' +
                              '<div style="display:flex;align-items:center;gap:10px;">' +
                              '<span style="font-size:0.72rem;font-weight:600;color:#3b82f6;min-width:60px;">UP (YES)</span>' +
                              '<span style="font-size:0.65rem;color:var(--text-muted);">Entry:</span>' +
                              '<span style="font-family:JetBrains Mono,monospace;font-size:1rem;font-weight:700;color:var(--text-primary);">$' +
                              entry.toFixed(2) +
                              '</span>' +
                              '<span style="font-size:0.65rem;color:var(--text-muted);">&rarr; Now:</span>' +
                              '<span style="font-family:JetBrains Mono,monospace;font-size:1rem;font-weight:700;color:' +
                              diffColor +
                              ';">$' +
                              current.toFixed(2) +
                              '</span>' +
                              '<span style="font-size:0.82rem;color:' +
                              diffColor +
                              ';">' +
                              arrow +
                              ' ' +
                              (diff >= 0 ? '+' : '') +
                              diff.toFixed(2) +
                              '</span>' +
                              '</div>' +
                              '<div style="font-size:0.7rem;color:var(--text-muted);">' +
                              s.entryOrderYes.size +
                              ' shares &middot; ' +
                              age +
                              's ago</div>' +
                              '</div>'
                      );
                  }
                  if (s.entryOrderNo) {
                      const entry = s.entryOrderNo.price;
                      const current = s.liveBestBidNo;
                      const diff = current - entry;
                      const diffColor = diff >= 0 ? '#10b981' : '#ef4444';
                      const arrow = diff >= 0 ? '&#9650;' : '&#9660;';
                      const age = Math.floor(
                          (Date.now() - new Date(s.entryOrderNo.placedAt).getTime()) / 1000
                      );
                      rows.push(
                          '<div style="display:flex;align-items:center;justify-content:space-between;padding:10px 14px;' +
                              'background:rgba(139,92,246,0.06);border:1px solid rgba(139,92,246,0.15);border-radius:8px;flex-wrap:wrap;gap:8px;">' +
                              '<div style="display:flex;align-items:center;gap:10px;">' +
                              '<span style="font-size:0.72rem;font-weight:600;color:#8b5cf6;min-width:60px;">DOWN (NO)</span>' +
                              '<span style="font-size:0.65rem;color:var(--text-muted);">Entry:</span>' +
                              '<span style="font-family:JetBrains Mono,monospace;font-size:1rem;font-weight:700;color:var(--text-primary);">$' +
                              entry.toFixed(2) +
                              '</span>' +
                              '<span style="font-size:0.65rem;color:var(--text-muted);">&rarr; Now:</span>' +
                              '<span style="font-family:JetBrains Mono,monospace;font-size:1rem;font-weight:700;color:' +
                              diffColor +
                              ';">$' +
                              current.toFixed(2) +
                              '</span>' +
                              '<span style="font-size:0.82rem;color:' +
                              diffColor +
                              ';">' +
                              arrow +
                              ' ' +
                              (diff >= 0 ? '+' : '') +
                              diff.toFixed(2) +
                              '</span>' +
                              '</div>' +
                              '<div style="font-size:0.7rem;color:var(--text-muted);">' +
                              s.entryOrderNo.size +
                              ' shares &middot; ' +
                              age +
                              's ago</div>' +
                              '</div>'
                      );
                  }
                  return (
                      '<div class="section-title">Your Pending Orders vs Market</div>' +
                      '<div style="background:var(--bg-card);border:1px solid var(--border);border-radius:12px;padding:14px;margin-bottom:24px;display:flex;flex-direction:column;gap:10px;">' +
                      rows.join('') +
                      '<div style="font-size:0.68rem;color:var(--text-muted);text-align:center;padding-top:4px;">' +
                      'Entry = your limit buy price &nbsp;|&nbsp; Now = current best bid &nbsp;|&nbsp; ' +
                      '<span style="color:#10b981;">&#9650; Green = market moved up (closer to fill)</span> &nbsp; ' +
                      '<span style="color:#ef4444;">&#9660; Red = market moved down</span>' +
                      '</div></div>'
                  );
              })()
            : ''
    }

    <!-- Live Market Prices -->
    <div class="section-title">Live Market Prices (Orderbook)</div>
    <div style="background:var(--bg-card);border:1px solid var(--border);border-radius:12px;padding:18px;margin-bottom:24px;">
      ${
          s.liveBestBidYes > 0 || s.liveBestBidNo > 0
              ? (() => {
                    const bidCombined = s.liveCombinedBid;
                    const askCombined = s.liveCombinedAsk;
                    const ceiling = s.livePairCostCeiling;
                    const gap = ceiling - bidCombined;
                    const isProfitable =
                        bidCombined > 0 && bidCombined < ceiling && bidCombined < 1.0;
                    const barColor = isProfitable
                        ? '#10b981'
                        : bidCombined >= 1.0
                          ? '#ef4444'
                          : '#f59e0b';
                    const statusText = isProfitable
                        ? 'PROFITABLE — bot is placing maker orders!'
                        : bidCombined >= 1.0
                          ? 'LOSING — bids sum >= $1.00'
                          : 'TOO TIGHT — bids sum > ceiling';
                    const statusIcon = isProfitable ? '&#9989;' : '&#10060;';
                    return `
        <div style="display:grid;grid-template-columns:1fr 1fr;gap:14px;margin-bottom:16px;">
          <div style="background:rgba(59,130,246,0.06);border:1px solid rgba(59,130,246,0.15);border-radius:10px;padding:14px;">
            <div style="font-size:0.68rem;color:var(--text-muted);text-transform:uppercase;letter-spacing:0.06em;margin-bottom:10px;text-align:center;">UP (YES)</div>
            <div style="display:flex;justify-content:space-around;">
              <div style="text-align:center;">
                <div style="font-size:0.62rem;color:var(--text-muted);margin-bottom:4px;">BID (our price)</div>
                <div style="font-family:'JetBrains Mono',monospace;font-size:1.4rem;font-weight:700;color:#10b981;">$${s.liveBestBidYes.toFixed(2)}</div>
              </div>
              <div style="text-align:center;">
                <div style="font-size:0.62rem;color:var(--text-muted);margin-bottom:4px;">ASK (taker)</div>
                <div style="font-family:'JetBrains Mono',monospace;font-size:1.4rem;font-weight:700;color:#ef4444;">$${s.liveBestAskYes.toFixed(2)}</div>
              </div>
            </div>
          </div>
          <div style="background:rgba(139,92,246,0.06);border:1px solid rgba(139,92,246,0.15);border-radius:10px;padding:14px;">
            <div style="font-size:0.68rem;color:var(--text-muted);text-transform:uppercase;letter-spacing:0.06em;margin-bottom:10px;text-align:center;">DOWN (NO)</div>
            <div style="display:flex;justify-content:space-around;">
              <div style="text-align:center;">
                <div style="font-size:0.62rem;color:var(--text-muted);margin-bottom:4px;">BID (our price)</div>
                <div style="font-family:'JetBrains Mono',monospace;font-size:1.4rem;font-weight:700;color:#10b981;">$${s.liveBestBidNo.toFixed(2)}</div>
              </div>
              <div style="text-align:center;">
                <div style="font-size:0.62rem;color:var(--text-muted);margin-bottom:4px;">ASK (taker)</div>
                <div style="font-family:'JetBrains Mono',monospace;font-size:1.4rem;font-weight:700;color:#ef4444;">$${s.liveBestAskNo.toFixed(2)}</div>
              </div>
            </div>
          </div>
        </div>
        <div style="display:grid;grid-template-columns:1fr 1fr;gap:14px;margin-bottom:14px;">
          <div style="text-align:center;background:rgba(16,185,129,0.08);border:1px solid rgba(16,185,129,0.2);border-radius:8px;padding:10px;">
            <div style="font-size:0.62rem;color:var(--text-muted);text-transform:uppercase;margin-bottom:4px;">OUR COST (Maker Bids)</div>
            <div style="font-family:'JetBrains Mono',monospace;font-size:1.5rem;font-weight:700;color:${barColor};">$${bidCombined.toFixed(4)}</div>
          </div>
          <div style="text-align:center;background:rgba(239,68,68,0.06);border:1px solid rgba(239,68,68,0.15);border-radius:8px;padding:10px;">
            <div style="font-size:0.62rem;color:var(--text-muted);text-transform:uppercase;margin-bottom:4px;">TAKER COST (Asks) — never profitable</div>
            <div style="font-family:'JetBrains Mono',monospace;font-size:1.5rem;font-weight:700;color:#ef4444;">$${askCombined.toFixed(4)}</div>
          </div>
        </div>
        <div style="background:rgba(0,0,0,0.2);border-radius:8px;padding:12px 16px;display:flex;align-items:center;justify-content:space-between;flex-wrap:wrap;gap:8px;">
          <div style="display:flex;align-items:center;gap:8px;">
            <span style="font-size:1.1rem;">${statusIcon}</span>
            <span style="font-size:0.82rem;font-weight:600;color:${barColor};">${statusText}</span>
          </div>
          <div style="font-family:'JetBrains Mono',monospace;font-size:0.78rem;color:var(--text-secondary);">
            Ceiling: $${ceiling.toFixed(4)} &nbsp;|&nbsp; Gap: <span style="color:${gap >= 0 ? '#10b981' : '#ef4444'};">${gap >= 0 ? '+' : ''}$${gap.toFixed(4)}</span>
            &nbsp;|&nbsp; Profit/share: <span style="color:${1.0 - bidCombined > 0 ? '#10b981' : '#ef4444'};">$${(1.0 - bidCombined).toFixed(4)}</span>
            &nbsp;|&nbsp; Min shares: ${s.liveEffectiveMinShares}
          </div>
        </div>`;
                })()
              : `
        <div style="text-align:center;padding:16px;color:var(--text-muted);font-size:0.85rem;">
          Waiting for orderbook data...
        </div>
      `
      }
    </div>

    <!-- BTC window market status (5m / 15m from config) -->
    <div class="section-title">Bitcoin ${windowLenMin}-Minute Market</div>
    <div class="scan-panel">
      <div class="scan-summary">
        <span class="scan-stat">Last check: <strong>${s.scanTimestamp ? new Date(s.scanTimestamp).toLocaleTimeString() : '—'}</strong></span>
        <span class="scan-stat">Windows checked: <strong>${s.scanSlugsChecked.length}</strong></span>
        <span class="scan-stat">Exist on API: <strong>${s.scanTotalApiFetched}</strong></span>
        <span class="scan-stat">Tradeable: <strong style="color:${s.scanMarketsReturned > 0 ? '#10b981' : '#f59e0b'}">${s.scanMarketsReturned}</strong></span>
        ${s.scanError ? '<span class="scan-stat" style="color:#ef4444">Error: <strong>' + s.scanError + '</strong></span>' : ''}
      </div>

      ${
          s.scanActiveMarket
              ? `
      <div style="background:rgba(16,185,129,0.08);border:1px solid rgba(16,185,129,0.25);border-radius:10px;padding:16px 20px;margin-top:12px;">
        <div style="display:flex;align-items:center;gap:10px;margin-bottom:10px;">
          <span style="width:10px;height:10px;border-radius:50%;background:#10b981;display:inline-block;animation:pulse-dot 2s ease-in-out infinite;"></span>
          <span style="font-size:0.85rem;font-weight:600;color:#10b981;">ACTIVE MARKET FOUND</span>
        </div>
        <div style="display:grid;grid-template-columns:1fr 1fr;gap:12px;">
          <div>
            <div style="font-size:0.68rem;color:var(--text-muted);text-transform:uppercase;letter-spacing:0.06em;margin-bottom:4px;">Market</div>
            <div style="font-family:'JetBrains Mono',monospace;font-size:0.82rem;color:var(--text-primary);">${s.scanActiveMarket.question.slice(0, 60)}</div>
          </div>
          <div>
            <div style="font-size:0.68rem;color:var(--text-muted);text-transform:uppercase;letter-spacing:0.06em;margin-bottom:4px;">Slug</div>
            <div style="font-family:'JetBrains Mono',monospace;font-size:0.82rem;color:var(--text-secondary);">${s.scanActiveMarket.slug}</div>
          </div>
          <div>
            <div style="font-size:0.68rem;color:var(--text-muted);text-transform:uppercase;letter-spacing:0.06em;margin-bottom:4px;">Window Ends</div>
            <div style="font-family:'JetBrains Mono',monospace;font-size:0.82rem;color:var(--text-primary);">${new Date(s.scanActiveMarket.endTime).toLocaleTimeString()}</div>
          </div>
          <div>
            <div style="font-size:0.68rem;color:var(--text-muted);text-transform:uppercase;letter-spacing:0.06em;margin-bottom:4px;">Time Remaining</div>
            <div style="font-family:'JetBrains Mono',monospace;font-size:0.82rem;color:#f59e0b;font-weight:700;">${s.scanActiveMarket.secondsLeft}s</div>
          </div>
        </div>
      </div>
      `
              : `
      <div style="background:rgba(245,158,11,0.08);border:1px solid rgba(245,158,11,0.25);border-radius:10px;padding:20px;margin-top:12px;text-align:center;">
        <div style="font-size:1.2rem;margin-bottom:8px;">&#9202;</div>
        <div style="font-size:0.88rem;font-weight:600;color:#f59e0b;margin-bottom:6px;">No Active BTC ${windowLenMin}m Market</div>
        <div style="font-size:0.78rem;color:var(--text-muted);line-height:1.6;">
          Polling every 5s. Checked slugs:<br>
          ${
              s.scanSlugsChecked.length > 0
                  ? s.scanSlugsChecked
                        .map(
                            (sl) =>
                                '<code style="font-size:0.72rem;background:rgba(255,255,255,0.05);padding:2px 6px;border-radius:4px;">' +
                                sl +
                                '</code>'
                        )
                        .join(' ')
                  : '<em>waiting for first scan...</em>'
          }
          <br><br>
          <a href="https://polymarket.com/crypto/${windowLenMin}M" target="_blank" style="color:var(--accent);">polymarket.com/crypto/${windowLenMin}M</a>
        </div>
      </div>
      `
      }

      ${
          s.scanRejected.length > 0
              ? `
      <div style="margin-top:14px;">
        <div style="font-size:0.7rem;color:var(--text-muted);font-weight:600;text-transform:uppercase;letter-spacing:0.06em;margin-bottom:8px;">BTC ${windowLenMin}m Markets Found But Rejected</div>
        <table class="scan-table">
          <tr><th>Slug</th><th>Reason</th></tr>
          ${s.scanRejected
              .map(
                  (r) => `<tr>
            <td>${r.slug}</td>
            <td><span class="tag-reject">${r.reason}</span></td>
          </tr>`
              )
              .join('')}
        </table>
      </div>
      `
              : ''
      }
    </div>

    <!-- Footer -->
    <div class="footer">
      <span>Last tick: ${s.lastTick ? new Date(s.lastTick).toLocaleTimeString() : '—'}</span>
      <span>Mandatory signal · BTC momentum: ~1.5s (live) · Dashboard body: ~2s (no full reload)</span>
      <a href="/status">JSON API</a>
    </div>
    `;
}

function serveHtml(): string {
    flushOrderHistoryToDisk();
    const s = getDashboardState();
    const liveInner = buildDashboardLiveInnerHtml(s);
    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Polymarket Hedge Bot</title>
  <style>
    @import url('https://fonts.googleapis.com/css2?family=Inter:wght@300;400;500;600;700&family=JetBrains+Mono:wght@400;500;600;700&display=swap');

    :root {
      --bg-primary: #0a0e1a;
      --bg-secondary: #111827;
      --bg-card: #1a1f35;
      --bg-card-hover: #1f2642;
      --border: #2a3050;
      --border-light: #354070;
      --text-primary: #f1f5f9;
      --text-secondary: #94a3b8;
      --text-muted: #64748b;
      --accent: #3b82f6;
      --accent-glow: rgba(59,130,246,0.15);
      --green: #10b981;
      --green-glow: rgba(16,185,129,0.15);
      --red: #ef4444;
      --yellow: #f59e0b;
      --purple: #8b5cf6;
    }

    * { box-sizing: border-box; margin: 0; padding: 0; }

    body {
      font-family: 'Inter', -apple-system, BlinkMacSystemFont, sans-serif;
      background: var(--bg-primary);
      color: var(--text-primary);
      min-height: 100vh;
      overflow-x: hidden;
    }

    /* Subtle animated gradient background */
    body::before {
      content: '';
      position: fixed;
      top: 0; left: 0; right: 0; bottom: 0;
      background: radial-gradient(ellipse at 20% 0%, rgba(59,130,246,0.08) 0%, transparent 50%),
                  radial-gradient(ellipse at 80% 100%, rgba(139,92,246,0.06) 0%, transparent 50%);
      pointer-events: none;
      z-index: 0;
    }

    .app { position: relative; z-index: 1; max-width: 1100px; margin: 0 auto; padding: 24px 20px; }

    /* ─── Header ─── */
    .header { display: flex; align-items: center; justify-content: space-between; margin-bottom: 28px; flex-wrap: wrap; gap: 12px; }
    .header-left { display: flex; align-items: center; gap: 14px; }
    .logo { width: 40px; height: 40px; border-radius: 10px; background: linear-gradient(135deg, #3b82f6, #8b5cf6); display: flex; align-items: center; justify-content: center; font-size: 20px; font-weight: 700; color: white; flex-shrink: 0; }
    .header h1 { font-size: 1.35rem; font-weight: 700; color: var(--text-primary); letter-spacing: -0.02em; }
    .header .tagline { font-size: 0.78rem; color: var(--text-muted); margin-top: 2px; }
    .header-badges { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; }

    /* ─── Badges ─── */
    .badge {
      display: inline-flex; align-items: center; gap: 6px;
      padding: 5px 12px; border-radius: 20px;
      font-size: 0.72rem; font-weight: 600; text-transform: uppercase; letter-spacing: 0.05em;
      border: 1px solid transparent;
    }
    .badge-dot { width: 7px; height: 7px; border-radius: 50%; flex-shrink: 0; }
    .badge-running { background: rgba(16,185,129,0.12); color: #10b981; border-color: rgba(16,185,129,0.25); }
    .badge-stopped { background: rgba(239,68,68,0.12); color: #ef4444; border-color: rgba(239,68,68,0.25); }
    .badge-live { background: rgba(245,158,11,0.12); color: #f59e0b; border-color: rgba(245,158,11,0.25); }
    .badge-paper { background: rgba(99,102,241,0.12); color: #6366f1; border-color: rgba(99,102,241,0.25); }
    .badge-kill-off { background: rgba(16,185,129,0.12); color: #10b981; border-color: rgba(16,185,129,0.25); }
    .badge-kill-on { background: rgba(239,68,68,0.12); color: #ef4444; border-color: rgba(239,68,68,0.25); }

    @keyframes pulse-dot { 0%, 100% { opacity: 1; } 50% { opacity: 0.3; } }
    .badge-dot.animate { animation: pulse-dot 2s ease-in-out infinite; }

    /* ─── Wallet Banner ─── */
    .wallet-banner {
      background: linear-gradient(135deg, rgba(59,130,246,0.08), rgba(139,92,246,0.08));
      border: 1px solid var(--border);
      border-radius: 14px;
      padding: 20px 24px;
      margin-bottom: 20px;
      display: flex;
      align-items: center;
      justify-content: space-between;
      flex-wrap: wrap;
      gap: 16px;
    }
    .wallet-info { display: flex; flex-direction: column; gap: 4px; }
    .wallet-label { font-size: 0.7rem; color: var(--text-muted); text-transform: uppercase; letter-spacing: 0.08em; font-weight: 500; }
    .wallet-addr { font-family: 'JetBrains Mono', monospace; font-size: 0.82rem; color: var(--text-secondary); }
    .wallet-balance {
      text-align: right;
    }
    .wallet-balance .amount {
      font-family: 'JetBrains Mono', monospace;
      font-size: 2rem;
      font-weight: 700;
      color: var(--text-primary);
      line-height: 1.1;
    }
    .wallet-balance .currency { font-size: 0.85rem; color: var(--text-muted); font-weight: 500; margin-top: 2px; }

    /* ─── Section titles ─── */
    .section-title {
      font-size: 0.72rem; font-weight: 600; text-transform: uppercase; letter-spacing: 0.1em;
      color: var(--text-muted); margin-bottom: 12px; padding-left: 2px;
    }

    /* ─── Card grid ─── */
    .grid { display: grid; gap: 12px; margin-bottom: 24px; }
    .grid-4 { grid-template-columns: repeat(4, 1fr); }
    .grid-3 { grid-template-columns: repeat(3, 1fr); }

    @media (max-width: 768px) {
      .grid-4 { grid-template-columns: repeat(2, 1fr); }
      .grid-3 { grid-template-columns: repeat(2, 1fr); }
    }

    .card {
      background: var(--bg-card);
      border: 1px solid var(--border);
      border-radius: 12px;
      padding: 16px 18px;
      transition: background 0.2s, border-color 0.2s;
    }
    .card:hover { background: var(--bg-card-hover); border-color: var(--border-light); }
    .card .label {
      font-size: 0.68rem; font-weight: 500; text-transform: uppercase; letter-spacing: 0.06em;
      color: var(--text-muted); margin-bottom: 8px;
    }
    .card .value {
      font-family: 'JetBrains Mono', monospace;
      font-size: 1.35rem; font-weight: 700; color: var(--text-primary);
    }
    .card .sub {
      font-size: 0.72rem; color: var(--text-muted); margin-top: 4px;
      font-family: 'JetBrains Mono', monospace;
    }

    /* Highlight card */
    .card-accent {
      border-color: rgba(59,130,246,0.3);
      background: linear-gradient(135deg, rgba(59,130,246,0.06), var(--bg-card));
    }

    /* ─── Window progress bar ─── */
    .progress-bar-container {
      background: var(--bg-card);
      border: 1px solid var(--border);
      border-radius: 12px;
      padding: 14px 18px;
      margin-bottom: 24px;
    }
    .progress-header { display: flex; justify-content: space-between; align-items: center; margin-bottom: 8px; }
    .progress-header .label { font-size: 0.72rem; color: var(--text-muted); font-weight: 500; }
    .progress-header .time { font-family: 'JetBrains Mono', monospace; font-size: 0.82rem; color: var(--text-secondary); font-weight: 600; }
    .progress-track { height: 6px; background: var(--border); border-radius: 3px; overflow: hidden; }
    .progress-fill { height: 100%; border-radius: 3px; background: linear-gradient(90deg, #3b82f6, #8b5cf6); transition: width 1s linear; }

    /* ─── Status message ─── */
    .status-msg {
      background: var(--bg-card);
      border: 1px solid var(--border);
      border-left: 3px solid var(--accent);
      border-radius: 0 10px 10px 0;
      padding: 14px 18px;
      margin-bottom: 24px;
      font-family: 'JetBrains Mono', monospace;
      font-size: 0.8rem;
      color: var(--text-secondary);
      line-height: 1.5;
    }

    /* Floating mandatory entry signal (does not consume layout space) */
    .floating-entry-signal {
      position: fixed;
      top: 50%;
      left: 14px;
      transform: translateY(-50%);
      z-index: 30;
      width: min(420px, calc(100vw - 24px));
      max-height: min(92vh, 900px);
      overflow-y: auto;
      background: rgba(12, 18, 34, 0.95);
      border: 1px solid var(--border);
      border-radius: 14px;
      box-shadow: 0 10px 30px rgba(0, 0, 0, 0.35);
      backdrop-filter: blur(3px);
      padding: 14px 16px;
    }
    .floating-entry-signal .title {
      font-size: 0.78rem;
      color: var(--text-muted);
      text-transform: uppercase;
      letter-spacing: 0.08em;
      margin-bottom: 6px;
    }
    .floating-entry-signal .market-line {
      font-size: 0.8rem;
      color: var(--text-secondary);
      line-height: 1.4;
      margin-bottom: 8px;
      padding: 7px 9px;
      border-radius: 8px;
      background: rgba(15, 23, 42, 0.45);
      border: 1px solid rgba(148, 163, 184, 0.2);
    }
    .floating-entry-signal .next {
      font-size: 1.05rem;
      font-weight: 800;
      margin-bottom: 6px;
    }
    .floating-entry-signal .mini {
      font-size: 0.82rem;
      color: var(--text-secondary);
      line-height: 1.45;
    }
    /* BTC momentum (live inside mandatory signal; meter animates via JS) */
    .mom-momentum-block {
      margin: 10px 0 12px;
      padding: 12px 11px 12px;
      border-radius: 11px;
      background: rgba(15, 23, 42, 0.55);
      border: 1px solid rgba(148, 163, 184, 0.22);
    }
    .mom-momentum-block .mom-label {
      font-size: 0.74rem;
      color: var(--text-muted);
      text-transform: uppercase;
      letter-spacing: 0.07em;
      margin-bottom: 8px;
    }
    .momentum-meter-track {
      position: relative;
      height: 13px;
      border-radius: 6px;
      background: rgba(30, 41, 59, 0.9);
      overflow: hidden;
      margin-bottom: 10px;
    }
    .momentum-meter-mid {
      position: absolute;
      left: 50%;
      top: 0;
      bottom: 0;
      width: 2px;
      margin-left: -1px;
      background: rgba(148, 163, 184, 0.5);
      z-index: 2;
      pointer-events: none;
    }
    .momentum-meter-fill {
      position: absolute;
      top: 0;
      bottom: 0;
      height: 100%;
      border-radius: 4px;
      transition: left 0.45s ease-out, width 0.45s ease-out, background 0.35s ease;
      z-index: 1;
    }
    .mom-stat-grid {
      display: grid;
      grid-template-columns: 1fr 1fr;
      gap: 8px 12px;
      font-size: 0.84rem;
      font-family: 'JetBrains Mono', monospace;
      color: var(--text-secondary);
    }
    .mom-stat-grid .k { color: var(--text-muted); font-size: 0.74rem; font-family: inherit; }
    .mom-gap-hero {
      font-family: 'JetBrains Mono', monospace;
      font-size: 1.45rem;
      font-weight: 800;
      line-height: 1.2;
      margin-bottom: 8px;
      transition: color 0.3s ease;
    }
    .floating-entry-controls {
      margin: 6px 0 7px;
      display: flex;
      align-items: center;
      gap: 6px;
    }
    .floating-entry-controls label {
      font-size: 0.74rem;
      color: var(--text-muted);
      text-transform: uppercase;
      letter-spacing: 0.07em;
      white-space: nowrap;
    }
    .floating-entry-controls select {
      width: 100%;
      background: rgba(15, 23, 42, 0.85);
      border: 1px solid var(--border);
      border-radius: 8px;
      color: var(--text-primary);
      font-size: 0.82rem;
      padding: 6px 10px;
    }
    .floating-entry-signal.pos-left-center { left: 14px; top: 50%; bottom: auto; transform: translateY(-50%); }
    .floating-entry-signal.pos-right-center { right: 14px; left: auto; top: 50%; bottom: auto; transform: translateY(-50%); }
    .floating-entry-signal.pos-top-left { left: 14px; top: 14px; bottom: auto; transform: none; }
    .floating-entry-signal.pos-top-right { right: 14px; left: auto; top: 14px; bottom: auto; transform: none; }
    .floating-entry-signal.pos-bottom-left { left: 14px; top: auto; bottom: 14px; transform: none; }
    .floating-entry-signal.pos-bottom-right { right: 14px; left: auto; top: auto; bottom: 14px; transform: none; }
    @media (max-width: 768px) {
      .floating-entry-signal {
        top: auto;
        bottom: 10px;
        left: 50%;
        transform: translateX(-50%);
      }
    }

    /* ─── Scan table ─── */
    .scan-panel {
      background: var(--bg-card);
      border: 1px solid var(--border);
      border-radius: 12px;
      padding: 18px;
      margin-bottom: 24px;
    }
    .scan-summary { display: flex; gap: 20px; flex-wrap: wrap; margin-bottom: 14px; }
    .scan-stat { font-size: 0.78rem; color: var(--text-secondary); }
    .scan-stat strong { color: var(--text-primary); font-family: 'JetBrains Mono', monospace; }
    .scan-table { width: 100%; border-collapse: collapse; font-size: 0.78rem; }
    .scan-table th {
      text-align: left; padding: 8px 10px;
      font-size: 0.68rem; font-weight: 600; text-transform: uppercase; letter-spacing: 0.06em;
      color: var(--text-muted); border-bottom: 1px solid var(--border);
    }
    .scan-table td {
      padding: 7px 10px; border-bottom: 1px solid rgba(42,48,80,0.5);
      color: var(--text-secondary); font-family: 'JetBrains Mono', monospace; font-size: 0.75rem;
      max-width: 300px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
    }
    .scan-table tr:last-child td { border-bottom: none; }
    .tag-15m { background: rgba(16,185,129,0.15); color: #10b981; padding: 2px 8px; border-radius: 10px; font-size: 0.68rem; font-weight: 600; }
    .tag-crypto { background: rgba(99,102,241,0.15); color: #818cf8; padding: 2px 8px; border-radius: 10px; font-size: 0.68rem; font-weight: 600; }
    .tag-reject { background: rgba(239,68,68,0.15); color: #f87171; padding: 2px 8px; border-radius: 10px; font-size: 0.68rem; font-weight: 600; }
    .scan-empty { text-align: center; padding: 20px; color: var(--text-muted); font-size: 0.82rem; }

    /* ─── Top strip (emergency stop + market title) ─── */
    .top-strip {
      display: flex;
      flex-direction: column;
      gap: 14px;
      margin-bottom: 22px;
    }
    .top-market-title {
      font-size: 1.06rem;
      font-weight: 600;
      color: var(--text-primary);
      line-height: 1.5;
      text-align: center;
      padding: 16px 20px;
      background: var(--bg-card);
      border: 1px solid var(--border);
      border-radius: 12px;
    }

    /* ─── Controls ─── */
    .controls {
      display: flex; align-items: center; gap: 12px;
      margin-bottom: 24px; flex-wrap: wrap;
    }
    .controls.controls-at-top {
      justify-content: center;
      margin-bottom: 0;
    }
    .btn {
      display: inline-flex; align-items: center; gap: 8px;
      padding: 10px 22px; border: none; border-radius: 10px;
      font-size: 0.82rem; font-weight: 600; cursor: pointer;
      color: white; transition: all 0.2s; font-family: 'Inter', sans-serif;
    }
    .btn-danger { background: linear-gradient(135deg, #dc2626, #b91c1c); }
    .btn-danger:hover { background: linear-gradient(135deg, #ef4444, #dc2626); box-shadow: 0 4px 15px rgba(220,38,38,0.3); }
    .btn-success { background: linear-gradient(135deg, #059669, #047857); }
    .btn-success:hover { background: linear-gradient(135deg, #10b981, #059669); box-shadow: 0 4px 15px rgba(5,150,105,0.3); }
    .btn-hint { font-size: 0.72rem; color: var(--text-muted); }

    /* ─── Footer ─── */
    .footer {
      text-align: center; font-size: 0.72rem; color: var(--text-muted);
      padding-top: 20px; border-top: 1px solid var(--border);
      display: flex; justify-content: center; gap: 16px; flex-wrap: wrap;
    }
    .footer a { color: var(--accent); text-decoration: none; }
    .footer a:hover { text-decoration: underline; }
  </style>
</head>
<body>
  <div class="app">
    <div id="dashboardLiveRoot">
` +
        liveInner +
        `
    </div>
  </div>
  <script>
  (function () {
    var POS_KEY = 'floatingEntrySignalPos';
    var POS_LIST = ['left-center', 'right-center', 'top-left', 'top-right', 'bottom-left', 'bottom-right'];
    function applySignalPos(pos) {
      var panel = document.getElementById('floatingEntrySignal');
      if (!panel) return;
      POS_LIST.forEach(function (p) { panel.classList.remove('pos-' + p); });
      var safe = POS_LIST.indexOf(pos) >= 0 ? pos : 'left-center';
      panel.classList.add('pos-' + safe);
      var sel = document.getElementById('fixedSignalPos');
      if (sel) sel.value = safe;
    }
    var savedPos = 'left-center';
    try {
      var v = localStorage.getItem(POS_KEY);
      if (v && POS_LIST.indexOf(v) >= 0) savedPos = v;
    } catch (_) {}
    applySignalPos(savedPos);
    document.addEventListener('change', function (e) {
      var t = e.target;
      if (!t || t.id !== 'fixedSignalPos') return;
      var next = t.value || 'left-center';
      applySignalPos(next);
      try { localStorage.setItem(POS_KEY, next); } catch (_) {}
    });
    function dashboardLiveUrl() {
      try {
        return new URL('api/dashboard-live', window.location.href).toString();
      } catch (_) {
        return '/api/dashboard-live';
      }
    }
    function isManualDockActive() {
      var dock = document.getElementById('manualBuyDock');
      if (!dock) return false;
      var ae = document.activeElement;
      if (!ae || ae === document.body) return false;
      if (ae.id === 'manualShares' || ae.id === 'manualBuyBtn' || ae.id === 'manualAutoBuyBtn' || ae.id === 'manualResult')
        return true;
      if (ae.name === 'manualSide') return true;
      if (dock.contains(ae)) return true;
      return false;
    }
    function refreshDashboardLive() {
      var root = document.getElementById('dashboardLiveRoot');
      if (!root) return;
      if (isManualDockActive()) return;
      fetch(dashboardLiveUrl())
        .then(function (r) {
          if (!r.ok) throw new Error('dashboard-live ' + r.status);
          return r.text();
        })
        .then(function (html) {
          root.innerHTML = html;
          applySignalPos(savedPos);
          fetch('/status')
            .then(function (r) { return r.json(); })
            .then(updateMomentumFromStatus)
            .catch(function () {});
        })
        .catch(function (e) {
          if (typeof console !== 'undefined' && console.warn) console.warn('[dashboard] live refresh failed', e);
        });
    }
    setInterval(refreshDashboardLive, 2000);
    setTimeout(refreshDashboardLive, 300);

    function updateMomentumFromStatus(st) {
      var gap = st.btcGapUsd;
      var maxGapUsd = 150;
      var gapHero = document.getElementById('momGapHero');
      var meter = document.getElementById('momMeterFill');
      var spotOpen = document.getElementById('momSpotOpen');
      var velEl = document.getElementById('momVel');
      var predEl = document.getElementById('momPred');
      var hedgeEl = document.getElementById('momHedgeOn');
      var flipEl = document.getElementById('momFlipLine');
      if (!gapHero || !meter) return;
      if (gap == null || !isFinite(gap)) {
        gapHero.textContent = '—';
        gapHero.style.color = 'var(--text-muted)';
        meter.style.left = '50%';
        meter.style.width = '0%';
        meter.style.background = 'linear-gradient(90deg,#334155,#475569)';
      } else {
        gapHero.textContent = (gap >= 0 ? '+' : '') + gap.toFixed(1) + ' USD';
        gapHero.style.color = gap >= 0 ? '#10b981' : '#ef4444';
        var mw = Math.min(50, (Math.abs(gap) / maxGapUsd) * 50);
        var ml = gap >= 0 ? 50 : (50 - mw);
        meter.style.left = ml + '%';
        meter.style.width = mw + '%';
        meter.style.background = gap >= 0 ? 'linear-gradient(90deg,#10b981,#059669)' : 'linear-gradient(90deg,#ef4444,#b91c1c)';
      }
      if (spotOpen) {
        var spot = st.btcUsdSpot, op = st.btcUsdWindowOpen;
        var sa = (spot != null && isFinite(spot)) ? ('$' + Math.round(spot).toLocaleString('en-US')) : '—';
        var oa = (op != null && isFinite(op)) ? ('$' + Math.round(op).toLocaleString('en-US')) : '—';
        spotOpen.textContent = sa + ' / ' + oa;
      }
      if (velEl) {
        var v = st.btcGapVelocityUsdPerSec;
        velEl.textContent = (v == null || !isFinite(v)) ? '—' : ((v >= 0 ? '+' : '') + v.toFixed(2) + ' $/s');
      }
      if (predEl) {
        var pr = st.btcGapPredicted60sUsd;
        predEl.textContent = (pr == null || !isFinite(pr)) ? '—' : ((pr >= 0 ? '+' : '') + pr.toFixed(1) + ' USD');
      }
      if (hedgeEl) {
        var on = st.momentumInversionHedgeEnabled !== false;
        hedgeEl.textContent = on ? 'ON' : 'OFF';
        hedgeEl.style.color = on ? '#10b981' : '#94a3b8';
      }
      if (flipEl) {
        flipEl.innerHTML = st.btcGapFlipDetectedThisTick
          ? '<span style="color:#fca5a5;font-weight:700;">Sign flip → momentum hedge eligible</span>'
          : '<span style="color:var(--text-muted);">No sign flip this tick</span>';
      }
      var momDownVel = document.getElementById('momDownVel');
      var momDownPred = document.getElementById('momDownPred');
      var momDownEarly = document.getElementById('momDownEarly');
      if (momDownVel) {
        var dvx = st.downAskMomentumUsdPerSec;
        momDownVel.textContent = (dvx == null || !isFinite(dvx))
          ? '—'
          : ((dvx >= 0 ? '+' : '') + dvx.toFixed(4) + ' $/s');
      }
      if (momDownPred) {
        var dpx = st.downAskPredictedAtWindowEndUsd;
        momDownPred.textContent = (dpx == null || !isFinite(dpx)) ? '—' : ('$' + dpx.toFixed(3));
      }
      if (momDownEarly) {
        momDownEarly.textContent = 'Early Down hedge (config): ' + (st.earlyDownMomentumHedgeEnabled ? 'ON' : 'OFF');
      }
    }
    fetch('/status').then(function (r) { return r.json(); }).then(updateMomentumFromStatus).catch(function () {});
    setInterval(function () {
      fetch('/status').then(function (r) { return r.json(); }).then(updateMomentumFromStatus).catch(function () {});
    }, 1500);

    function sideVal() {
      var el = document.querySelector('input[name="manualSide"]:checked');
      return el ? el.value : 'YES';
    }
    function runOrderHistoryDownload(btn, url, filename) {
      var orig = btn.textContent;
      btn.disabled = true;
      btn.textContent = 'Downloading…';
      fetch(url)
        .then(function (r) {
          if (!r.ok) throw new Error(r.status + ' ' + r.statusText);
          return r.blob();
        })
        .then(function (blob) {
          var a = document.createElement('a');
          a.href = URL.createObjectURL(blob);
          a.download = filename;
          document.body.appendChild(a);
          a.click();
          document.body.removeChild(a);
          URL.revokeObjectURL(a.href);
        })
        .catch(function (e) {
          alert('Download failed: ' + (e && e.message ? e.message : String(e)));
        })
        .finally(function () {
          btn.disabled = false;
          btn.textContent = orig;
        });
    }
    document.addEventListener('click', function (e) {
      var t = e.target;
      if (!t || !t.id) return;
      if (t.id === 'manualBuyBtn') {
        var sh = Math.floor(parseFloat(document.getElementById('manualShares').value) || 0);
        var out = document.getElementById('manualResult');
        if (sh <= 0) { if (out) out.textContent = 'Invalid shares (enter a positive whole number).'; return; }
        t.disabled = true;
        fetch('/api/manual-buy', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ side: sideVal(), shares: sh })
        }).then(function (r) { return r.json(); }).then(function (j) {
          if (out) out.textContent = JSON.stringify(j, null, 2);
        }).catch(function (err) {
          if (out) out.textContent = String(err);
        }).finally(function () { t.disabled = false; });
        return;
      }
      if (t.id === 'manualAutoBuyBtn') {
        var outA = document.getElementById('manualResult');
        t.disabled = true;
        fetch('/api/manual-auto-buy', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })
          .then(function (r) { return r.json(); })
          .then(function (j) { if (outA) outA.textContent = JSON.stringify(j, null, 2); })
          .catch(function (err) { if (outA) outA.textContent = String(err); })
          .finally(function () { t.disabled = false; });
        return;
      }
      if (t.id === 'downloadOrderHistoryXlsx') {
        runOrderHistoryDownload(t, '/api/order-history.xlsx', 'order-history.xlsx');
        return;
      }
      if (t.id === 'downloadOrderHistoryJson') {
        runOrderHistoryDownload(t, '/api/order-history.json', 'order-history.json');
      }
    });
  })();
  </script>
</body>
</html>`;
}

export function startDashboard(port?: number): http.Server {
    const p = port ?? (parseInt(process.env.DASHBOARD_PORT || '', 10) || DEFAULT_PORT);
    const server = http.createServer((req, res) => {
        const reqUrl = req.url || '/';
        const host = req.headers.host || `localhost:${p}`;
        const parsed = new URL(reqUrl, `http://${host}`);
        const pathname = parsed.pathname || '/';
        const method = req.method || 'GET';

        if (pathname === '/' && method === 'GET') {
            res.writeHead(200, { 'Content-Type': 'text/html' });
            res.end(serveHtml());
            return;
        }
        if (pathname === '/status' && method === 'GET') {
            res.writeHead(200, {
                'Content-Type': 'application/json',
                'Access-Control-Allow-Origin': '*',
            });
            res.end(JSON.stringify(getDashboardState(), null, 2));
            return;
        }
        if (
            (pathname === '/api/dashboard-live' || pathname === '/api/dashboard-live/') &&
            method === 'GET'
        ) {
            flushOrderHistoryToDisk();
            const st = getDashboardState();
            res.writeHead(200, {
                'Content-Type': 'text/html; charset=utf-8',
                'Cache-Control': 'no-store',
                'Access-Control-Allow-Origin': '*',
            });
            res.end(buildDashboardLiveInnerHtml(st));
            return;
        }
        if (pathname === '/killSwitch' && method === 'POST') {
            const body: string[] = [];
            req.on('data', (ch) => body.push(ch.toString()));
            req.on('end', () => {
                const form = new URLSearchParams(body.join(''));
                const on = form.get('on') === '1';
                sharedState.killSwitch = on;
                res.writeHead(302, { Location: '/' });
                res.end();
            });
            return;
        }
        if (pathname === '/api/manual-buy' && method === 'POST') {
            const chunks: Buffer[] = [];
            req.on('data', (ch: Buffer) => chunks.push(ch));
            req.on('end', async () => {
                res.setHeader('Content-Type', 'application/json');
                res.setHeader('Access-Control-Allow-Origin', '*');
                try {
                    const raw = Buffer.concat(chunks).toString('utf8');
                    const j = JSON.parse(raw || '{}') as { side?: string; shares?: unknown };
                    const side = j.side === 'NO' ? 'NO' : j.side === 'YES' ? 'YES' : null;
                    const shares =
                        typeof j.shares === 'number'
                            ? j.shares
                            : parseFloat(String(j.shares ?? ''));
                    if (!side || !Number.isFinite(shares)) {
                        res.writeHead(400);
                        res.end(
                            JSON.stringify({
                                ok: false,
                                error: 'JSON body must include side ("YES"|"NO") and shares (number).',
                            })
                        );
                        return;
                    }
                    if (!manualBuyHandler) {
                        res.writeHead(503);
                        res.end(
                            JSON.stringify({
                                ok: false,
                                error: 'Manual buy not available (bot handler not registered).',
                            })
                        );
                        return;
                    }
                    const result = await manualBuyHandler(side, shares);
                    res.writeHead(200);
                    res.end(JSON.stringify(result));
                } catch (e) {
                    const msg = e instanceof Error ? e.message : String(e);
                    res.writeHead(500);
                    res.end(JSON.stringify({ ok: false, error: msg }));
                }
            });
            return;
        }
        if (pathname === '/api/manual-auto-buy' && method === 'POST') {
            res.setHeader('Content-Type', 'application/json');
            res.setHeader('Access-Control-Allow-Origin', '*');
            void (async () => {
                try {
                    if (!autoOppositeBuyHandler) {
                        res.writeHead(503);
                        res.end(
                            JSON.stringify({
                                ok: false,
                                error: 'Auto buy not available (bot handler not registered).',
                            })
                        );
                        return;
                    }
                    const result = await autoOppositeBuyHandler();
                    res.writeHead(200);
                    res.end(JSON.stringify(result));
                } catch (e) {
                    const msg = e instanceof Error ? e.message : String(e);
                    res.writeHead(500);
                    res.end(JSON.stringify({ ok: false, error: msg }));
                }
            })();
            return;
        }
        if (pathname === '/history' && method === 'GET') {
            flushOrderHistoryToDisk();
            const summary24h = getLast24hSummary();
            const windows = getCompletedWindowsDetail();
            const orderLog = getOrderHistoryEntries();
            const payload = {
                simulatedBalanceUsd: getSimulatedBalance(),
                last24hPaperWindows: summary24h,
                last24hOrderLogAll: getLast24hOrderHistorySummary(false),
                last24hOrderLogLive: getLast24hOrderHistorySummary(true),
                paperCompletedWindows: windows,
                orderHistoryAll: orderLog,
                orderHistoryLiveWindows: listOrderHistoryWindowsDesc(orderLog.filter((e) => e.liveTrading)),
            };
            res.writeHead(200, {
                'Content-Type': 'application/json',
                'Access-Control-Allow-Origin': '*',
            });
            res.end(JSON.stringify(payload, null, 2));
            return;
        }
        if (pathname === '/api/order-history.json' && method === 'GET') {
            flushOrderHistoryToDisk();
            res.writeHead(200, {
                'Content-Type': 'application/json',
                'Access-Control-Allow-Origin': '*',
            });
            res.end(JSON.stringify(getOrderHistoryEntries(), null, 2));
            return;
        }
        if (pathname === '/api/order-history.xlsx' && method === 'GET') {
            void (async () => {
                try {
                    flushOrderHistoryToDisk();
                    const buf = await buildOrderHistoryExcelBuffer();
                    res.writeHead(200, {
                        'Content-Type':
                            'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
                        'Content-Disposition': 'attachment; filename="order-history.xlsx"',
                        'Access-Control-Allow-Origin': '*',
                    });
                    res.end(buf);
                } catch (e) {
                    const msg = e instanceof Error ? e.message : String(e);
                    res.writeHead(500, { 'Content-Type': 'text/plain' });
                    res.end(msg);
                }
            })();
            return;
        }
        res.writeHead(404, { 'Content-Type': 'text/plain' });
        res.end('Not found');
    });
    server.listen(p);
    return server;
}
