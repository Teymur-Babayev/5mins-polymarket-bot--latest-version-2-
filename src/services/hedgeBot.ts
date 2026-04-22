/**
 * Polymarket BTC Up/Down bot — single strategy (reference-wallet logic).
 * - 5m or 15m via strategy.config.json → btcMarketWindowMinutes
 * - Maker bids; tilt + share-parity side pick;
 * - Forced leg switch every N orders; optional `windowEntryWarmupSeconds` then mid-window-heavy clips (duration-scaled)
 * - Ladder: **Stock A** when Up/Down quantities are **equal** (or both zero at initiation): optional entry-rise
 *   composite (`entryRiseSignalEnabled`), else `predictWinnerForPairLadderStockA` (BTC gap, velocity, tie-break),
 *   and a **momentum/BTC-gap** clip (`evaluateLikelyRisingSideSignal`: strong → `pairStockARandomSharesMax`,
 *   weak → `pairStockARandomSharesMin`, both tightened by `maxClipShares` / `maxSingleOrderUsd`) — no After-PnL slack floor.
 *   **Stock B** when |Up−Down|>0: opposite / lighter leg with minDualAfterPnlUsd simulation and slack caps.
 *   Pair-ladder mode: every leg (A and B) is at least `pairStockARandomSharesMin` (after CLOB/order mins), not the raw imbalance.
 *   Paper maker: no sub-minimum incremental fills — when the book would fill, the full resting size fills at once so clip ≥ floor.
 * - In the last finalOneSidedHedgeSeconds on 5m markets only: optional separate path — BTC gap picks the
 *   predicted winner to add to the *missing* leg when that leg is under the After PnL floor. If the gap favors
 *   the leg you already hold one-sided, this path defers to the legacy opposite-leg FOK hedge so the book is not
 *   stuck “waiting”. Implied pair (held avg + opposite ask) ≤ ~0.98 also triggers an immediate FOK hedge after books.
 * - Otherwise in that window: FOK buy opposite at ask with pair-cost / dual After PnL sizing (buildFinalOneSidedHedgeDecision).
 * - Optional `entryRiseSignalEnabled`: after reference side pick, blend BTC gap + YES/NO ask velocity + spread
 *   tilt toward the leg whose ask is more likely to keep rising (does not override parity/inventory rebalance).
 */

import type { ClobClient } from '@polymarket/clob-client';
import type {
    StrategyConfig,
    ActiveMarket,
    WindowState,
    OrderBookSnapshot,
    StrategyDecision,
} from '../interfaces/strategyInterfaces';
import {
    getActiveBtcUpDownMarket,
    secondsUntilWindowEnd,
    getLastScanReport,
    btcWindowDurationSec,
    btcUpDownWindowElapsedAndRemaining,
} from './marketDiscovery';
import {
    effectiveWarmupSeconds,
    buildSizeLadderFromConfig,
    explainReferenceBuySide,
    referencePickClipSize,
    capClipForSettlementQtyParity,
} from './referencePairStrategy';
import {
    createEmptyWindowState,
    updateWindowStateFromFill,
    clampBuySizeForSimulatedGates,
    capClipByAfterPnlSlack,
    buildFinalOneSidedHedgeDecision,
    syncWindowStateWithChain,
    type ChainSyncPriceHints,
    buildDirectionalSkewInventoryDecision,
    recomputeWindowDerivedFields,
    isDualOutcomeProfitableFill,
    afterPnlsFromState,
    projectedAfterPnlsAfterBuy,
    minDualAfterPnlUsd,
    effectiveMinDualForSlackUsd,
    minDualAfterPnlStrictAbove,
    dualAfterPnlMeetsMin,
    requiresMinDualAfterPnlForSimulatedBuy,
    pairCostCeiling,
    oppositeAskAllInForSide,
    momentumGapPreferredOutcomeSide,
    predictWinnerForPairLadderStockA,
    sharesToReachOutcomeAfterPnlTarget,
    predictLikelyRisingSide,
    evaluateLikelyRisingSideSignal,
    type EntryRiseSignalInput,
} from './hedgeStrategy';
import {
    getBothOrderBooks,
    placeLimitBuyOrder,
    buyInstant,
    reconcilePendingOrders,
    createPendingOrder,
    type PendingOrder,
    type FillUpdate,
    type OrderResult,
} from './orderManager';
import {
    createInitialRiskState,
    canPlaceOrder,
    recordOrderSuccess,
    recordOrderFailure,
    resetCircuitBreaker,
    setKillSwitch,
    type RiskState,
} from './riskManager';
import { logWindowState, logEntry } from './strategyLogger';
import { updateDashboardState, getDashboardState } from './dashboard';
import {
    getAllBalances,
    getMarketPositionShares,
    redeemPositions,
    type WalletBalances,
} from '../utils/getMyBalance';
import { ENV } from '../config/env';
import {
    estimateTakerFeesFromLegVwapUsd,
    sumPaperRecordedTakerFeesUsd,
    polymarketBinaryTakerFeeUsd,
    binaryOutcomeBuyAllInPerShare,
    buyBinaryOutcomeLegUsd,
    takerCommissionUsdForBinaryBuy,
    type OrderLiquidityRole,
    binaryOutcomeTakerFeePerShareUsd,
    pairOpposingLegMaxBidAfterFirst,
} from '../utils/polymarketFees';
import { inStopTradingSecondsBeforeEndWindow } from '../config/strategyConfig';
import {
    resetPaperSession,
    getSimulatedBalance,
    recordOrder as recordPaperOrder,
    recordWindowEnd as recordPaperWindowEnd,
    getOrdersForWindow,
    getCompletedWindowsDetail,
    correctLastUnknownWindowSettlement,
} from './tradeHistory';
import {
    fetchGammaBtcUpDownWindowDetails,
    type GammaBtcUpDownWindowDetails,
} from './marketResolution';
import { resolveBtcUpDownWindowWinner, type SettlementWinnerSource } from './btcUpDownSettlement';
import type { EntryDecisionSnapshot, ExecutedEntrySnapshot } from './dashboard';
import type { EntryDirectionDecision } from './referencePairStrategy';
import { fetchBtcUsdPrice } from '../utils/btcSpotPrice';
import { ClobOrderbookWs } from './clobOrderbookWs';
import {
    pushOrderHistoryEntry,
    markWindowOrderHistorySettlement,
    flushOrderHistoryToDisk,
    getOrderHistoryEntries,
} from './orderHistoryLog';
import { fetchClobBuyTradesForMarket, type LiveVerifiedBuyTrade } from './clobTradeHistory';
import {
    pruneNoAskSamples,
    downAskVelocityUsdPerSec,
    extrapolateDownAskToWindowEnd,
    DEFAULT_NO_ASK_SAMPLE_MAX_AGE_MS,
} from '../utils/orderbookMomentum';

export interface HedgeBotOptions {
    config: StrategyConfig;
    clobClient: ClobClient;
    onStateChange?: (windowState: WindowState, riskState: RiskState) => void;
}

/** Dashboard manual FOK buy — orderbook snapshot + before/after settlement PnL (gross, same as /status). */
export interface ManualBuySnapshot {
    side: 'YES' | 'NO';
    sharesRequested: number;
    bestAskYes: number;
    bestAskNo: number;
    bestBidYes: number;
    bestBidNo: number;
    askUsed: number;
    estCostUsd: number;
    qtyYesBefore: number;
    qtyNoBefore: number;
    totalSpentUsdBefore: number;
    afterPnlIfUpBefore: number;
    afterPnlIfDownBefore: number;
    afterPnlIfUpProjected: number;
    afterPnlIfDownProjected: number;
    timestampIso: string;
    liveTrading: boolean;
    /** After successful fill + sync (live) or simulated fill (paper). */
    qtyYesAfter?: number;
    qtyNoAfter?: number;
    totalSpentUsdAfter?: number;
    afterPnlIfUpAfter?: number;
    afterPnlIfDownAfter?: number;
}

export interface ManualBuyResult {
    ok: boolean;
    error?: string;
    snapshot?: ManualBuySnapshot;
    orderId?: string;
}

/** P/L context for dashboard auto-opposite buy (before placing the hedge order). */
export interface AutoOppositeAnalysis {
    qtyYes: number;
    qtyNo: number;
    avgYes: number;
    avgNo: number;
    pairCost: number;
    totalSpentUsd: number;
    afterPnlIfUp: number;
    afterPnlIfDown: number;
    lockedProfit: number;
    plannedSide: 'YES' | 'NO';
    plannedShares: number;
    reason: string;
}

export interface ManualAutoOppositeResult extends ManualBuyResult {
    analysis?: AutoOppositeAnalysis;
}

const MARKET_CACHE_TTL_MS = 30_000;
const REDEEM_SWEEP_INTERVAL_MS = 15 * 60 * 1000;
/** No normal trading in the last N seconds (balanced windows wait for resolution). */
const HARD_CUTOFF_SECONDS = 15;
const MAX_PENDING_ORDER_AGE_MS = 12_000;
const FIRST_ENTRY_EXPENSIVE_SIDE_PRICE = 0.8;
const FIRST_ENTRY_EXPENSIVE_SIDE_MIN_TOP_BID_SIZE = 200;
const FIRST_ENTRY_PAPER_SPEND_FRACTION = 0.05; // 1/100 of paperStartingBalanceUsd

function qlog(quiet: boolean, ...args: unknown[]): void {
    if (!quiet) console.log(...args);
}

export class HedgeBot {
    private config: StrategyConfig;
    private client: ClobClient;
    private intervalId: ReturnType<typeof setInterval> | null = null;
    private windowState: WindowState | null = null;
    private riskState: RiskState;
    private lastMarketSlug: string | null = null;
    private lastWindowEnd: string | null = null;
    private tickRunning = false;
    /** Skip automatic tick while a dashboard manual buy runs (avoids overlapping orders). */
    /** True while any manual buy body runs (blocks executeTick). */
    private manualBuyInProgress = false;
    /** Serializes manual / auto-opposite buys so repeated clicks queue instead of failing. */
    private manualBuyQueue: Promise<unknown> = Promise.resolve();

    private cachedMarket: ActiveMarket | null = null;
    private cachedMarketTs = 0;

    // ─── Strategy execution state ────────────────────────────────────────
    private lastBuyPrice = 0;
    private activePendingOrder: PendingOrder | null = null;
    private roundsThisWindow = 0;
    private holdsThisWindow = 0;
    private lastExecutedSide: 'YES' | 'NO' | null = null;

    // ─── Balance & position tracking ─────────────────────────────────────
    private lastBalanceFetchTs = 0;
    private cachedBalances: WalletBalances = {
        publicWalletUsdc: 0,
        polymarketUsdc: 0,
        totalUsdc: 0,
    };
    private balanceLastCheckedIso = '';
    private startedAt = Date.now();
    /**
     * First process tick only: if the current window is already past halfway when the bot starts,
     * automatic trading is skipped until the next window (entries, hedges, momentum paths).
     */
    private startupLateJoinEvaluated = false;
    private startupSkipTradingWindowEndIso: string | null = null;
    private static readonly BALANCE_CACHE_TTL_MS = 10_000;

    private lastPositionFetchTs = 0;
    private lastPositionKey = '';
    private cachedActualPosition = { qtyYes: 0, qtyNo: 0 };
    /** Non-live / throttled reads; live ticks use force=true every poll. */
    private static readonly POSITION_CACHE_TTL_MS = 10_000;

    // ─── Live orderbook prices ───────────────────────────────────────────
    private liveBestAskYes = 0;
    private liveBestAskNo = 0;
    private liveCombinedAsk = 0;
    /** Binance BTC/USD at first successful tick of the current window (skew vs spot −$30 / +$30). */
    private btcUsdAtWindowOpen: number | null = null;
    /** Last BTC/USD spot used for order-history rows (updated each tick when fetched). */
    private lastBtcUsdSpot: number | null = null;
    /** Last non-neutral sign of BTC gap vs window open (+1 / -1 / 0) for momentum flip detection. */
    private btcGapLastNonZeroSign: -1 | 0 | 1 = 0;
    /** Recent (gap, time) samples for velocity / ~60s extrapolation (pruned each tick). */
    private btcGapSamples: Array<{ t: number; gap: number }> = [];
    /** Latest momentum snapshot (flip edge + simple velocity model). */
    private btcMomentumSnapshot = {
        flipDetected: false,
        velocityUsdPerSec: null as number | null,
        predictedGap60sUsd: null as number | null,
    };

    /** Rolling Down (NO) best ask samples — orderbook momentum (distinct from BTC gap momentum). */
    private noAskMomentumSamples: Array<{ t: number; ask: number }> = [];
    /** Rolling Up (YES) best ask samples — paired with NO for entry rise velocity. */
    private yesAskMomentumSamples: Array<{ t: number; ask: number }> = [];
    private lastEarlyDownMomentumHedgeAt = 0;
    /** Dashboard: last computed Down ask $/s and extrapolation to window end. */
    private downAskMomentumUsdPerSecDisplay: number | null = null;
    private downAskPredictedAtWindowEndUsdDisplay: number | null = null;

    private liveBestBidYes = 0;
    private liveBestBidNo = 0;
    private liveCombinedBid = 0;
    private entryDecisionHistory: EntryDecisionSnapshot[] = [];
    private lastExecutedEntry: ExecutedEntrySnapshot | null = null;
    private activePendingOrderReasonCode: string | null = null;

    /**
     * Paper mode: simulated resting GTC at best bid with partial fills + maker→taker hybrid,
     * mirroring live tick cadence so sizing/PnL gates match live (live was gated on `liveTrading` for taker hedges
     * and paper used instant full fills every poll).
     */
    private paperSimulatedMakerOrder: PendingOrder | null = null;
    private paperSimulatedMakerReasonCode: string | null = null;

    private sessionStartPortfolioUsd: number | null = null;

    /** CLOB getTrades BUY rows keyed by condition id (authoritative fills for live dashboard). */
    private sessionClobTradesByCondition = new Map<string, LiveVerifiedBuyTrade[]>();
    private lastClobTradesFetchTs = 0;
    private lastClobTradesFetchedAtIso: string | null = null;
    private lastClobTradesError: string | null = null;
    private static readonly CLOB_TRADES_REFRESH_MS = 2500;

    /** Net P/L of the last completed window (paper realized or live estimate); drives next window’s first-order recovery sizing. */
    private lastCompletedWindowNetProfitUsd: number | null = null;

    // ─── Completed windows ───────────────────────────────────────────────
    private completedWindows: Array<{
        slug: string;
        windowEnd: string;
        pairCost: number;
        qtyYes: number;
        qtyNo: number;
        costYes: number;
        costNo: number;
        lockedProfit: number;
        totalSpent: number;
        feeEstimate: number;
        netProfit: number;
        winnerSide: 'YES' | 'NO' | 'UNKNOWN';
        rounds: number;
        btcUsdWindowOpen: number | null;
        btcUsdWindowEnd: number | null;
        settlementWinnerSource: SettlementWinnerSource;
    }> = [];

    // ─── Redemption ──────────────────────────────────────────────────────
    private redeemQueue = new Set<string>();
    private redeemSweepRunning = false;
    private redeemIntervalId: ReturnType<typeof setInterval> | null = null;
    private lastRedeemSweepIso: string | null = null;
    private lastRedeemSweepResult = 'Not run yet';

    /** Throttle re-fetches when last window was settled as UNKNOWN (paper or live). */
    private lastUnknownWindowReconcileMs = 0;

    /** Optional CLOB market-channel WS for live orderbooks (REST fallback when stale/unavailable). */
    private readonly orderbookWs: ClobOrderbookWs | null;

    /** When set, {@link getMarket} returns this market and startup/warmup gates are bypassed for replay. */
    private backtraceReplayMode = false;
    private backtracePinnedMarket: ActiveMarket | null = null;
    /** BTC/USD anchor at window open (from snapshot-ticks meta openPrice). */
    private backtraceWindowOpenAnchorUsd: number | null = null;

    constructor(private options: HedgeBotOptions) {
        this.config = options.config;
        this.client = options.clobClient;
        this.orderbookWs =
            this.config.useClobOrderbookWebSocket === true
                ? new ClobOrderbookWs(ENV.CLOB_WS_URL)
                : null;
        this.riskState = createInitialRiskState(options.config);
        updateDashboardState({
            running: false,
            killSwitch: this.config.killSwitch,
            message: 'Bot created; call start() to run',
            walletAddress: ENV.PUBLIC_ADDRESS,
            proxyWalletAddress: ENV.PROXY_WALLET,
            liveTrading: this.config.liveTrading,
            feeBipsAssumption: this.config.feeBips,
        });
    }

    /**
     * Pin Gamma market + window-open BTC for historical tick replay (paper only). Call before runSingleTick loop.
     */
    public configureBacktraceReplay(market: ActiveMarket, windowOpenBtcUsd: number): void {
        this.backtraceReplayMode = true;
        this.backtracePinnedMarket = market;
        this.backtraceWindowOpenAnchorUsd = windowOpenBtcUsd;
        this.cachedMarket = market;
        this.cachedMarketTs = Date.now();
        this.startupLateJoinEvaluated = true;
        this.startupSkipTradingWindowEndIso = null;
    }

    public clearBacktraceReplay(): void {
        this.backtraceReplayMode = false;
        this.backtracePinnedMarket = null;
        this.backtraceWindowOpenAnchorUsd = null;
    }

    /** Run one strategy tick (used by backtrace CLI; normal mode uses start() interval). */
    public async runSingleTick(): Promise<void> {
        await this.tick();
    }

    // ─── Balance ─────────────────────────────────────────────────────────

    private async fetchBalance(): Promise<void> {
        const now = Date.now();
        if (now - this.lastBalanceFetchTs < HedgeBot.BALANCE_CACHE_TTL_MS) return;
        const MAX_RETRIES = 2;
        for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
            try {
                this.cachedBalances = await getAllBalances();
                this.lastBalanceFetchTs = Date.now();
                this.balanceLastCheckedIso = new Date().toISOString();
                return;
            } catch (err) {
                const msg = err instanceof Error ? err.message : String(err);
                if (attempt < MAX_RETRIES) {
                    console.warn(
                        `[Bot] Balance fetch attempt ${attempt} failed (retrying): ${msg}`
                    );
                    await new Promise((r) => setTimeout(r, 1000));
                } else {
                    console.error(
                        `[Bot] Balance fetch failed after ${MAX_RETRIES} attempts: ${msg}`
                    );
                }
            }
        }
    }

    /**
     * Read YES/NO share balances from chain. Use `force` in live mode every tick so strategy state
     * matches the proxy wallet (source of truth), not only CLOB fill reconciliation.
     */
    /** Pull authenticated BUY trade history from CLOB for the active market (dashboard + cross-check). */
    private async refreshClobTradesForLiveDashboard(market: ActiveMarket): Promise<void> {
        if (!this.config.liveTrading) return;
        const now = Date.now();
        if (now - this.lastClobTradesFetchTs < HedgeBot.CLOB_TRADES_REFRESH_MS) return;
        this.lastClobTradesFetchTs = now;
        try {
            const trades = await fetchClobBuyTradesForMarket(this.client, market);
            this.sessionClobTradesByCondition.set(market.conditionId, trades);
            this.lastClobTradesFetchedAtIso = new Date().toISOString();
            this.lastClobTradesError = null;
        } catch (e) {
            const msg = e instanceof Error ? e.message : String(e);
            this.lastClobTradesError = msg;
            console.warn('[Bot] CLOB trades fetch failed:', msg);
        }
    }

    private async fetchActualPositionTokens(
        yesTokenId: string,
        noTokenId: string,
        force = false
    ): Promise<void> {
        const now = Date.now();
        const positionKey = `${yesTokenId}:${noTokenId}:${ENV.PROXY_WALLET}`;
        if (
            !force &&
            this.lastPositionKey === positionKey &&
            now - this.lastPositionFetchTs < HedgeBot.POSITION_CACHE_TTL_MS
        ) {
            return;
        }
        const MAX_RETRIES = 2;
        for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
            try {
                const pos = await getMarketPositionShares(yesTokenId, noTokenId, ENV.PROXY_WALLET);
                this.cachedActualPosition = { qtyYes: pos.yesShares, qtyNo: pos.noShares };
                this.lastPositionFetchTs = Date.now();
                this.lastPositionKey = positionKey;
                return;
            } catch (err) {
                const msg = err instanceof Error ? err.message : String(err);
                if (attempt < MAX_RETRIES) {
                    console.warn(
                        `[Bot] Position fetch attempt ${attempt} failed (retrying): ${msg}`
                    );
                    await new Promise((r) => setTimeout(r, 1000));
                } else {
                    console.error(
                        `[Bot] Position fetch failed after ${MAX_RETRIES} attempts: ${msg}`
                    );
                }
            }
        }
    }

    private async fetchActualPosition(market: ActiveMarket, force = false): Promise<void> {
        return this.fetchActualPositionTokens(market.yesTokenId, market.noTokenId, force);
    }

    /**
     * Align `windowState` quantities (and costs) with on-chain balances. Uses last-tick orderbook
     * bids as price hints when imputing cost for chain-only share increases.
     */
    private applyLiveInventorySync(
        market: ActiveMarket,
        q: boolean,
        hintsOverride?: ChainSyncPriceHints
    ): void {
        if (!this.config.liveTrading || !this.windowState) return;
        const hints = hintsOverride ?? {
            bestBidYes: this.liveBestBidYes,
            bestBidNo: this.liveBestBidNo,
        };
        const { state: synced, adjusted } = syncWindowStateWithChain(
            this.windowState,
            this.cachedActualPosition.qtyYes,
            this.cachedActualPosition.qtyNo,
            hints
        );
        this.windowState = synced;
        const slug = this.windowState.marketSlug || market.slug;
        if (adjusted && !q) {
            console.warn(
                `[Bot] Inventory aligned to chain: Up=${synced.qtyYes.toFixed(2)} Down=${synced.qtyNo.toFixed(2)} ` +
                    `(on-chain ${this.cachedActualPosition.qtyYes.toFixed(2)} / ${this.cachedActualPosition.qtyNo.toFixed(2)}) ` +
                    `| ${slug}`
            );
        }
    }

    /** Max |qty| drift between fill log aggregate and synced state to treat log as authoritative for display. */
    private static readonly DASHBOARD_FILL_MATCH_EPS = 0.06;

    /**
     * Sum per-fill rows from the order-history log for the active window (same source as export).
     */
    private buildWindowStateFromOrderHistory(): WindowState | null {
        if (!this.windowState) return null;
        const wEnd = this.windowState.windowEndIso;
        const fills = getOrderHistoryEntries().filter(
            (e) => e.windowEndIso === wEnd && e.liveTrading === this.config.liveTrading
        );
        if (fills.length === 0) return null;
        let qtyYes = 0,
            qtyNo = 0,
            costYes = 0,
            costNo = 0;
        for (const f of fills) {
            if (f.side === 'YES') {
                qtyYes += f.orderSizeShares;
                costYes += f.costUsd;
            } else {
                qtyNo += f.orderSizeShares;
                costNo += f.costUsd;
            }
        }
        return recomputeWindowDerivedFields({
            ...this.windowState,
            qtyYes,
            qtyNo,
            costYes,
            costNo,
        });
    }

    /**
     * Dashboard / MTM: prefer exact fill-aggregated costs when quantities match synced state
     * (chain sync + reconciliation); otherwise use synced state (e.g. chain-imputed inventory).
     */
    private getDashboardDisplayWindowState(): WindowState | null {
        if (!this.windowState) return null;
        const ws = this.windowState;
        const hist = this.buildWindowStateFromOrderHistory();
        if (!hist) return ws;
        const eps = HedgeBot.DASHBOARD_FILL_MATCH_EPS;
        const match =
            Math.abs(hist.qtyYes - ws.qtyYes) < eps && Math.abs(hist.qtyNo - ws.qtyNo) < eps;
        return match ? hist : ws;
    }

    private async refreshLiveInventoryFromChain(market: ActiveMarket, q: boolean): Promise<void> {
        if (!this.config.liveTrading || !this.windowState) return;
        if (this.lastBalanceFetchTs === 0) await this.fetchBalance();
        await this.fetchActualPosition(market, true);
        this.applyLiveInventorySync(market, q);
    }

    /** Same as dashboard CLOB refresh but ignores throttle (use after fills / window end). */
    private async refreshClobTradesForLiveDashboardForced(market: ActiveMarket): Promise<void> {
        if (!this.config.liveTrading) return;
        this.lastClobTradesFetchTs = Date.now();
        try {
            const trades = await fetchClobBuyTradesForMarket(this.client, market);
            this.sessionClobTradesByCondition.set(market.conditionId, trades);
            this.lastClobTradesFetchedAtIso = new Date().toISOString();
            this.lastClobTradesError = null;
        } catch (e) {
            const msg = e instanceof Error ? e.message : String(e);
            this.lastClobTradesError = msg;
            console.warn('[Bot] CLOB trades fetch (forced) failed:', msg);
        }
    }

    private syncWindowTokenIdsFromActiveMarket(market: ActiveMarket): void {
        if (!this.windowState) return;
        if (this.windowState.conditionId !== market.conditionId) return;
        if (
            this.windowState.yesTokenId === market.yesTokenId &&
            this.windowState.noTokenId === market.noTokenId
        ) {
            return;
        }
        this.windowState = {
            ...this.windowState,
            yesTokenId: market.yesTokenId,
            noTokenId: market.noTokenId,
        };
    }

    /** Minimal `ActiveMarket` for REST orderbook + CLOB when the rolling slug no longer matches this window. */
    private resolveMarketSnapshotForWindowState(ws: WindowState): ActiveMarket | null {
        const btcMin = this.config.btcMarketWindowMinutes ?? 15;
        if (ws.yesTokenId && ws.noTokenId) {
            return {
                conditionId: ws.conditionId,
                question: ws.marketSlug,
                slug: ws.marketSlug,
                yesTokenId: ws.yesTokenId,
                noTokenId: ws.noTokenId,
                endDateIso: ws.windowEndIso,
                acceptingOrders: false,
                closed: true,
                windowDurationSec: btcWindowDurationSec(this.config),
                btcMarketWindowMinutes: btcMin,
            };
        }
        if (this.cachedMarket?.conditionId === ws.conditionId) {
            return this.cachedMarket;
        }
        return null;
    }

    /**
     * LIVE: last sync from chain + REST books + CLOB before `logWindowEndSummary` (window slug may
     * already point at the next market, so token ids on `windowState` matter).
     */
    private async finalizeLiveWindowInventoryForClosedWindow(q: boolean): Promise<void> {
        if (!this.config.liveTrading || !this.windowState) return;
        const ws = this.windowState;
        const m = this.resolveMarketSnapshotForWindowState(ws);
        if (!m) {
            if (!q && (ws.qtyYes > 0 || ws.qtyNo > 0)) {
                console.warn(
                    '[Bot] End-of-window chain sync skipped: missing YES/NO token ids on window state.'
                );
            }
            return;
        }

        if (this.lastBalanceFetchTs === 0) await this.fetchBalance();

        let hints: ChainSyncPriceHints | undefined;
        try {
            const books = await getBothOrderBooks(this.client, m, null);
            hints = {
                bestBidYes: books.bookYes.bestBid ?? 0,
                bestBidNo: books.bookNo.bestBid ?? 0,
            };
            this.liveBestBidYes = hints.bestBidYes;
            this.liveBestBidNo = hints.bestBidNo;
            this.liveBestAskYes = books.bookYes.bestAsk ?? 0;
            this.liveBestAskNo = books.bookNo.bestAsk ?? 0;
            this.liveCombinedBid = this.liveBestBidYes + this.liveBestBidNo;
            this.liveCombinedAsk = this.liveBestAskYes + this.liveBestAskNo;
        } catch {
            /* keep existing bid hints for cost imputation */
        }

        await this.fetchActualPositionTokens(m.yesTokenId, m.noTokenId, true);
        this.applyLiveInventorySync(m, q, hints);
        await this.refreshClobTradesForLiveDashboardForced(m);
    }

    private async reconcileLiveStateAfterExchangeTouch(market: ActiveMarket, q: boolean): Promise<void> {
        if (!this.config.liveTrading) return;
        this.syncWindowTokenIdsFromActiveMarket(market);
        await this.refreshLiveInventoryFromChain(market, q);
        await this.refreshClobTradesForLiveDashboardForced(market);
    }

    private static readonly BTC_GAP_SAMPLE_MAX_AGE_MS = 120_000;

    /** Fetch BTC spot, update gap samples, velocity estimate, and BTC gap sign-flip edge for momentum hedge. */
    private async refreshBtcGapAndMomentum(): Promise<void> {
        const cur = await fetchBtcUsdPrice();
        if (cur !== null) this.lastBtcUsdSpot = cur;
        const gap =
            this.lastBtcUsdSpot != null && this.btcUsdAtWindowOpen != null
                ? this.lastBtcUsdSpot - this.btcUsdAtWindowOpen
                : null;
        this.btcMomentumSnapshot = this.updateBtcGapMomentumFromGap(gap);
    }

    /**
     * Detect crossing from positive to negative gap (or reverse) outside the dead zone — triggers momentum FOK hedge when one-sided.
     * Velocity uses oldest sample in the rolling window vs now (simple trend; extrapolated +60s for display).
     */
    private updateBtcGapMomentumFromGap(gapUsd: number | null): {
        flipDetected: boolean;
        velocityUsdPerSec: number | null;
        predictedGap60sUsd: number | null;
    } {
        const dead = this.config.btcGapSignDeadZoneUsd ?? 5;
        if (gapUsd == null || !Number.isFinite(gapUsd)) {
            return { flipDetected: false, velocityUsdPerSec: null, predictedGap60sUsd: null };
        }
        const now = Date.now();
        this.btcGapSamples.push({ t: now, gap: gapUsd });
        const pruneBefore = now - HedgeBot.BTC_GAP_SAMPLE_MAX_AGE_MS;
        this.btcGapSamples = this.btcGapSamples
            .filter((s) => s.t >= pruneBefore)
            .sort((a, b) => a.t - b.t);

        let currSign: -1 | 0 | 1 = 0;
        if (gapUsd > dead) currSign = 1;
        else if (gapUsd < -dead) currSign = -1;

        let flipDetected = false;
        if (
            currSign !== 0 &&
            this.btcGapLastNonZeroSign !== 0 &&
            currSign !== this.btcGapLastNonZeroSign
        ) {
            flipDetected = true;
        }
        if (currSign !== 0) {
            this.btcGapLastNonZeroSign = currSign;
        }

        let velocityUsdPerSec: number | null = null;
        let predictedGap60sUsd: number | null = null;
        const oldest = this.btcGapSamples[0];
        if (oldest && now - oldest.t >= 3_000) {
            const dtSec = (now - oldest.t) / 1000;
            velocityUsdPerSec = (gapUsd - oldest.gap) / dtSec;
            predictedGap60sUsd = gapUsd + velocityUsdPerSec * 60;
        }

        return { flipDetected, velocityUsdPerSec, predictedGap60sUsd };
    }

    // ─── Market cache ────────────────────────────────────────────────────

    private async getMarket(): Promise<ActiveMarket | null> {
        if (this.backtracePinnedMarket) {
            return this.backtracePinnedMarket;
        }
        const now = Date.now();
        const secsLeft = this.cachedMarket
            ? secondsUntilWindowEnd(this.cachedMarket.endDateIso)
            : 0;
        const nearEnd = secsLeft > 0 && secsLeft < 90;
        const cacheValid =
            this.cachedMarket &&
            now - this.cachedMarketTs < MARKET_CACHE_TTL_MS &&
            !this.cachedMarket.closed &&
            this.cachedMarket.acceptingOrders &&
            secsLeft > 0;
        if (cacheValid && !nearEnd) {
            return this.cachedMarket;
        }
        let market = await getActiveBtcUpDownMarket(this.config);
        if (!market) {
            await new Promise((r) => setTimeout(r, 1500));
            market = await getActiveBtcUpDownMarket(this.config);
        }
        this.cachedMarket = market;
        this.cachedMarketTs = now;
        return market;
    }

    // ─── Fill processing ─────────────────────────────────────────────────

    private async applyFills(fills: FillUpdate[]): Promise<void> {
        if (!this.windowState || !this.cachedMarket) return;
        const q = !!this.config.quietConsole;
        const market = this.cachedMarket;
        let touched = false;
        for (const fill of fills) {
            if (fill.newFillQty <= 0) continue;
            if (this.config.pairLadderMatchEnabled === true) {
                const { lo: plLiveFillLo } = this.pairStockARandomClipBounds(
                    market,
                    this.liveBestBidYes,
                    this.liveBestBidNo
                );
                if (fill.newFillQty < plLiveFillLo) {
                    qlog(
                        q,
                        `[WARN] Live maker/partial fill +${fill.newFillQty} sh < pair-ladder floor ${plLiveFillLo} (exchange fill)`
                    );
                }
            }
            touched = true;
            this.windowState = updateWindowStateFromFill(
                this.windowState,
                fill.side,
                fill.newFillQty,
                fill.newFillCost
            );
            this.riskState = recordOrderSuccess(this.riskState, fill.newFillCost);
            const rawPx =
                fill.unitPriceRaw ??
                (fill.newFillQty > 1e-9 ? fill.newFillCost / fill.newFillQty : 0);
            const sideLabel = fill.side === 'YES' ? 'Up' : 'Down';
            qlog(
                q,
                `[FILL] ${sideLabel} +${fill.newFillQty.toFixed(0)}sh raw~$${rawPx.toFixed(4)} all-in~$${(fill.newFillCost / Math.max(fill.newFillQty, 1e-9)).toFixed(4)} (${fill.orderId.slice(0, 12)}...)`
            );
            logWindowState(
                this.windowState,
                'order_filled',
                `FILL ${sideLabel} +${fill.newFillQty.toFixed(0)} @ raw $${rawPx.toFixed(4)} (all-in $${(fill.newFillCost / Math.max(fill.newFillQty, 1e-9)).toFixed(4)}) | pairCost=${this.windowState.pairCost.toFixed(4)}`,
                {
                    feeBipsAssumption: this.config.feeBips,
                    quietConsole: q,
                    ...this.getAccountingSnapshot(this.windowState),
                }
            );
            const bookSnap = {
                bestBidYes: this.liveBestBidYes,
                bestBidNo: this.liveBestBidNo,
                bestAskYes: this.liveBestAskYes,
                bestAskNo: this.liveBestAskNo,
            };
            this.recordOrderHistorySnapshot(
                market,
                this.windowState,
                fill.side,
                fill.newFillQty,
                rawPx,
                fill.newFillCost,
                bookSnap,
                this.activePendingOrderReasonCode ?? 'LIVE_FILL'
            );
        }
        if (touched && this.config.liveTrading) {
            await this.reconcileLiveStateAfterExchangeTouch(market, q);
        }
    }

    private pendingOrderCount(): number {
        if (this.config.liveTrading && this.activePendingOrder) return 1;
        if (!this.config.liveTrading && this.paperSimulatedMakerOrder) return 1;
        return 0;
    }

    /**
     * Heuristic maker-fill increment so paper does not jump to full size in one poll (live uses CLOB partials).
     * Returns **whole shares only** — fractional increments (e.g. 7.13) are invalid for Polymarket and broke
     * parity with `orderMinSize` / pair-ladder clip expectations in paper mode.
     */
    private estimatePaperMakerIncrementalShares(
        book: OrderBookSnapshot,
        limitPx: number,
        remaining: number
    ): number {
        const rem = Math.floor(Math.max(0, remaining) + 1e-9);
        if (rem <= 0) return 0;
        const tick = this.config.tickSize || 0.01;
        const best = book.bids[0];
        if (!best || best.price < limitPx - tick * 0.25) return 0;
        const poll = Math.max(1000, this.config.pollIntervalMs || 5000);
        let depth = 0;
        for (const l of book.bids) {
            if (l.price >= limitPx - tick * 0.25) depth += l.size;
        }
        const spread =
            book.bestAsk != null && book.bestAsk > 0 && best.price > 0
                ? Math.max(0, book.bestAsk - best.price)
                : 0.05;
        const spreadTightness = Math.max(0.12, Math.min(1.4, 0.035 / Math.max(spread, 0.008)));
        const raw = depth * spreadTightness * 0.025 * (poll / 5000);
        const maxInc = Math.min(rem, Math.max(0, raw));
        let inc = Math.floor(maxInc + 1e-9);
        if (maxInc > 1e-6 && inc < 1) inc = 1;
        return Math.min(rem, inc);
    }

    /**
     * Reconcile simulated paper maker order (partial fills, hybrid taker, stale cancel).
     * @returns true to skip the rest of this tick (resting maker with no opposite hedge needed, hybrid handled),
     *   or false when the main tick must continue — e.g. pair-ladder hedge on the **lighter** leg while a maker
     *   still rests on the heavy leg (`paperMakerShouldYieldTickForOppositePairHedge`).
     */
    private async tickPaperSimulatedMaker(market: ActiveMarket, q: boolean): Promise<boolean> {
        const pending = this.paperSimulatedMakerOrder;
        if (!pending || !this.windowState) return false;

        let books: { bookYes: OrderBookSnapshot; bookNo: OrderBookSnapshot };
        try {
            books = await getBothOrderBooks(this.client, market, this.orderbookWs);
            this.liveBestBidYes = books.bookYes.bestBid ?? 0;
            this.liveBestBidNo = books.bookNo.bestBid ?? 0;
            this.liveBestAskYes = books.bookYes.bestAsk ?? 0;
            this.liveBestAskNo = books.bookNo.bestAsk ?? 0;
            this.liveCombinedBid = this.liveBestBidYes + this.liveBestBidNo;
            this.liveCombinedAsk = this.liveBestAskYes + this.liveBestAskNo;
        } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            updateDashboardState({
                ...this.getDashboardExtras(),
                marketSlug: market.slug,
                windowEndIso: market.endDateIso,
                consecutiveFailures: this.riskState.consecutiveOrderFailures,
                pendingOrders: 1,
                message: `PAPER sim orderbook error: ${msg}`,
                lastTick: new Date().toISOString(),
            });
            return true;
        }

        const placedMs = Date.parse(pending.placedAt);
        const ageMs = Number.isFinite(placedMs) ? Date.now() - placedMs : MAX_PENDING_ORDER_AGE_MS + 1;
        const minSz = Math.max(1, Math.floor(this.config.orderMinSize || 1));
        const fallbackMs = this.config.liveMakerFallbackToTakerMs ?? 2500;
        const canHybridFallback =
            this.config.livePreferTakerAllEntries !== true && fallbackMs > 0;

        pending.sizeFilled = Math.floor(Math.max(0, pending.sizeFilled) + 1e-9);
        pending.costFilled = Math.round(pending.costFilled * 1e6) / 1e6;

        const bookSide = pending.side === 'YES' ? books.bookYes : books.bookNo;
        const tsPh = this.config.tickSize || 0.01;

        if (ageMs > MAX_PENDING_ORDER_AGE_MS) {
            if (pending.sizeFilled > 1e-6) {
                this.onPaperSimulatedMakerCompleted(pending, this.paperSimulatedMakerReasonCode);
            }
            this.paperSimulatedMakerOrder = null;
            this.paperSimulatedMakerReasonCode = null;
            updateDashboardState({
                ...this.getDashboardExtras(),
                marketSlug: market.slug,
                windowEndIso: market.endDateIso,
                consecutiveFailures: this.riskState.consecutiveOrderFailures,
                pendingOrders: 0,
                lastTick: new Date().toISOString(),
                message: 'PAPER: simulated maker order expired (partial fills kept)',
            });
            return false;
        }

        let remaining = Math.max(0, pending.sizeRequested - pending.sizeFilled);
        remaining = Math.floor(remaining + 1e-9);
        let inc = Math.floor(
            Math.max(0, this.estimatePaperMakerIncrementalShares(bookSide, pending.price, remaining)) + 1e-9
        );
        // Pair ladder: never simulate tiny partial maker fills (e.g. 1–3 sh) — apply the full resting size
        // in one step when the book would fill anything, so every paper fill matches pairStockARandomSharesMin+.
        if (this.config.pairLadderMatchEnabled === true && inc > 0) {
            inc = remaining;
        }
        if (inc > 1e-9 && this.windowState) {
            const kPaper = this.config.binaryOutcomeTakerFeeScalar ?? 0;
            const liqPaper: OrderLiquidityRole = kPaper > 0 ? 'TAKER' : 'MAKER';
            const fillCost = buyBinaryOutcomeLegUsd(
                inc,
                pending.price,
                liqPaper,
                this.config.feeBips ?? 0,
                kPaper
            );
            const takerCommPaper = takerCommissionUsdForBinaryBuy(
                inc,
                pending.price,
                liqPaper,
                this.config.feeBips ?? 0,
                kPaper
            );
            this.windowState = updateWindowStateFromFill(
                this.windowState,
                pending.side,
                inc,
                fillCost,
                { takerCommissionUsd: takerCommPaper }
            );
            this.riskState = recordOrderSuccess(this.riskState, fillCost);
            pending.sizeFilled += inc;
            pending.costFilled += fillCost;
            pending.status = pending.sizeFilled + 1e-9 >= pending.sizeRequested ? 'filled' : 'partial';
            const fillPriceRaw = pending.price;
            qlog(
                q,
                `[PAPER FILL] ${pending.side === 'YES' ? 'Up' : 'Down'} +${inc.toFixed(4)}sh raw $${fillPriceRaw.toFixed(4)} all-in $${(fillCost / inc).toFixed(4)}`
            );
            logWindowState(
                this.windowState,
                'order_filled',
                `PAPER FILL ${pending.side === 'YES' ? 'Up' : 'Down'} +${inc.toFixed(4)} @ raw $${fillPriceRaw.toFixed(4)} all-in $${(fillCost / inc).toFixed(4)} | pairCost=${this.windowState.pairCost.toFixed(4)}`,
                {
                    feeBipsAssumption: this.config.feeBips,
                    quietConsole: q,
                    ...this.getAccountingSnapshot(this.windowState),
                }
            );
            const bookSnap = {
                bestBidYes: this.liveBestBidYes,
                bestBidNo: this.liveBestBidNo,
                bestAskYes: this.liveBestAskYes,
                bestAskNo: this.liveBestAskNo,
            };
            this.recordOrderHistorySnapshot(
                market,
                this.windowState,
                pending.side,
                inc,
                fillPriceRaw,
                fillCost,
                bookSnap,
                this.paperSimulatedMakerReasonCode ?? 'PAPER_SIM_FILL'
            );
            recordPaperOrder({
                windowSlug: market.slug,
                windowEndIso: this.windowState.windowEndIso,
                side: pending.side,
                price: fillCost / inc,
                size: inc,
                costUsd: fillCost,
                roundInWindow: this.roundsThisWindow + 1,
                liquidity: liqPaper,
            });
            this.cachedBalances.polymarketUsdc = getSimulatedBalance();
            this.cachedBalances.totalUsdc = getSimulatedBalance();
            this.lastBalanceFetchTs = 0;
        }

        remaining = Math.max(0, pending.sizeRequested - pending.sizeFilled);
        if (remaining <= 1e-6) {
            this.onPaperSimulatedMakerCompleted(pending, this.paperSimulatedMakerReasonCode);
            this.paperSimulatedMakerOrder = null;
            this.paperSimulatedMakerReasonCode = null;
            this.lastBalanceFetchTs = 0;
            return false;
        }

        if (
            canHybridFallback &&
            ageMs > fallbackMs &&
            ageMs <= MAX_PENDING_ORDER_AGE_MS &&
            remaining + 1e-9 >= minSz
        ) {
            const askNow = pending.side === 'YES' ? books.bookYes.bestAsk ?? 0 : books.bookNo.bestAsk ?? 0;
            let hybridTakerOk = false;
            if (askNow > 0 && askNow < 1 && this.windowState) {
                const limitPx = Math.min(0.99, Math.round((askNow + tsPh) * 100) / 100);
                const takerCost = buyBinaryOutcomeLegUsd(
                    remaining,
                    limitPx,
                    'TAKER',
                    this.config.feeBips ?? 0,
                    this.config.binaryOutcomeTakerFeeScalar ?? 0
                );
                if (takerCost >= 1 && this.cachedBalances.polymarketUsdc >= takerCost + 0.25) {
                    const stateNow = this.windowState;
                    const sideLabel = pending.side === 'YES' ? 'Up' : 'Down';
                    const reason = `${this.paperSimulatedMakerReasonCode ?? 'PAPER_MAKER'}|MAKER_TIMEOUT_TAKER`;
                    await this.applyBuyFillAccountingUnified(
                        market,
                        stateNow,
                        pending.side,
                        remaining,
                        limitPx,
                        takerCost,
                        {
                            bestBidYes: books.bookYes.bestBid ?? 0,
                            bestBidNo: books.bookNo.bestBid ?? 0,
                            bestAskYes: books.bookYes.bestAsk ?? 0,
                            bestAskNo: books.bookNo.bestAsk ?? 0,
                        },
                        reason,
                        'tick',
                        (ws) =>
                            `PAPER hybrid: ${sideLabel} ${remaining}@$${limitPx.toFixed(4)} | pairCost=$${ws.pairCost.toFixed(4)} | Up=${ws.qtyYes} Down=${ws.qtyNo}`,
                        q,
                        { liquidity: 'TAKER' }
                    );
                    hybridTakerOk = true;
                }
            }
            this.paperSimulatedMakerOrder = null;
            const savedReason = this.paperSimulatedMakerReasonCode;
            this.paperSimulatedMakerReasonCode = null;
            if (!hybridTakerOk && pending.sizeFilled > 1e-6) {
                this.onPaperSimulatedMakerCompleted(pending, savedReason);
            }
            updateDashboardState({
                ...this.getDashboardExtras(),
                marketSlug: market.slug,
                windowEndIso: market.endDateIso,
                consecutiveFailures: this.riskState.consecutiveOrderFailures,
                pendingOrders: 0,
                lastTick: new Date().toISOString(),
                message: hybridTakerOk
                    ? `PAPER: hybrid maker→taker (${Math.floor(ageMs / 1000)}s)`
                    : `PAPER: hybrid window ended — maker partial kept, taker skipped (${Math.floor(ageMs / 1000)}s)`,
            });
            return true;
        }

        if (this.paperMakerShouldYieldTickForOppositePairHedge()) {
            updateDashboardState({
                ...this.getDashboardExtras(),
                marketSlug: market.slug,
                windowEndIso: market.endDateIso,
                consecutiveFailures: this.riskState.consecutiveOrderFailures,
                pendingOrders: 1,
                lastTick: new Date().toISOString(),
                message:
                    `PAPER: maker resting on heavy leg — same tick continues for pair hedge ` +
                    `(imb=${this.pairQtyImbalanceShares(this.windowState)} | Up bid $${this.liveBestBidYes.toFixed(2)} · Down $${this.liveBestBidNo.toFixed(2)})`,
            });
            return false;
        }

        updateDashboardState({
            ...this.getDashboardExtras(),
            marketSlug: market.slug,
            windowEndIso: market.endDateIso,
            consecutiveFailures: this.riskState.consecutiveOrderFailures,
            pendingOrders: 1,
            lastTick: new Date().toISOString(),
            message: `PAPER: simulated maker resting (${Math.floor(ageMs / 1000)}s)`,
        });
        return true;
    }

    private onPaperSimulatedMakerCompleted(order: PendingOrder, reasonCode?: string | null): void {
        const totalFilled = order.sizeFilled;
        const rc = reasonCode ?? this.paperSimulatedMakerReasonCode ?? 'PAPER_MAKER_DONE';
        if (totalFilled > 0) {
            this.lastBuyPrice = order.price;
            this.lastExecutedSide = order.side;
            this.roundsThisWindow++;
            this.lastBalanceFetchTs = 0;
            this.lastPositionFetchTs = 0;
            this.lastExecutedEntry = {
                timestampIso: new Date().toISOString(),
                side: order.side,
                shares: totalFilled,
                price: order.price,
                reasonCode: rc,
            };
        }
        this.paperSimulatedMakerReasonCode = null;
    }

    /** Drop resting paper maker sim without completing a round (partial fills already in `windowState`). */
    private abandonPaperSimulatedMaker(): void {
        this.paperSimulatedMakerOrder = null;
        this.paperSimulatedMakerReasonCode = null;
    }

    /**
     * While a paper maker order rests on the **heavy** leg, we still must evaluate the pair-ladder **hedge**
     * on the lighter leg (live does not block the whole tick on partials the same way). Yield so `executeTick`
     * can run Phase 5+ and place Stock B.
     */
    private paperMakerShouldYieldTickForOppositePairHedge(): boolean {
        if (this.config.pairLadderMatchEnabled !== true) return false;
        const pending = this.paperSimulatedMakerOrder;
        const ws = this.windowState;
        if (!pending || !ws) return false;
        const imb = this.pairQtyImbalanceShares(ws);
        if (imb <= 0) return false;
        const light = this.pairLighterHedgeSide(ws);
        if (!light) return false;
        return pending.side !== light;
    }

    /**
     * Same accounting path for paper and live after a buy that should hit `windowState` immediately
     * (paper simulation or live FOK / verified instant fill). Live limit (GTC) orders still use pending + applyFills.
     */
    private async applyBuyFillAccountingUnified(
        market: ActiveMarket,
        state: WindowState,
        side: 'YES' | 'NO',
        shares: number,
        fillPrice: number,
        orderCostUsd: number,
        bookSnap: {
            bestBidYes: number;
            bestBidNo: number;
            bestAskYes: number;
            bestAskNo: number;
        },
        reasonCode: string,
        logEvent: 'tick' | 'order_placed',
        buildLog: (ws: WindowState) => string,
        q: boolean,
        opts?: { phase8EntryReasonCode?: string; liquidity?: 'MAKER' | 'TAKER' }
    ): Promise<void> {
        const kFee = this.config.binaryOutcomeTakerFeeScalar ?? 0;
        /** Live: respect venue liquidity. Paper: model taker fee (C×k×p×(1−p)) on every fill when k>0 so dashboard fee / P/L match market-style purchases. */
        const liq: OrderLiquidityRole =
            (!this.config.liveTrading && kFee > 0) || opts?.liquidity === 'TAKER' ? 'TAKER' : 'MAKER';
        const totalCostUsd = buyBinaryOutcomeLegUsd(
            shares,
            fillPrice,
            liq,
            this.config.feeBips ?? 0,
            kFee
        );
        const takerComm = takerCommissionUsdForBinaryBuy(
            shares,
            fillPrice,
            liq,
            this.config.feeBips ?? 0,
            kFee
        );
        this.windowState = updateWindowStateFromFill(state, side, shares, totalCostUsd, {
            takerCommissionUsd: takerComm,
        });
        this.riskState = recordOrderSuccess(this.riskState, totalCostUsd);
        this.riskState = resetCircuitBreaker(this.riskState);
        this.lastBuyPrice = shares > 0 ? totalCostUsd / shares : fillPrice;
        this.lastExecutedSide = side;
        this.roundsThisWindow++;
        if (!this.config.liveTrading) {
            recordPaperOrder({
                windowSlug: market.slug,
                windowEndIso: market.endDateIso,
                side,
                price: this.lastBuyPrice,
                size: shares,
                costUsd: totalCostUsd,
                roundInWindow: this.roundsThisWindow,
                liquidity: liq,
            });
        }
        if (opts?.phase8EntryReasonCode !== undefined) {
            this.lastExecutedEntry = {
                timestampIso: new Date().toISOString(),
                side,
                shares,
                price: this.lastBuyPrice,
                reasonCode: opts.phase8EntryReasonCode,
            };
        }
        this.recordOrderHistorySnapshot(
            market,
            this.windowState,
            side,
            shares,
            fillPrice,
            totalCostUsd,
            bookSnap,
            reasonCode
        );
        logWindowState(this.windowState, logEvent, buildLog(this.windowState), {
            feeBipsAssumption: this.config.feeBips,
            quietConsole: q,
            ...this.getAccountingSnapshot(this.windowState),
        });
        this.lastBalanceFetchTs = 0;
        this.lastPositionFetchTs = 0;
        await this.reconcileLiveStateAfterExchangeTouch(market, q);
    }

    private resolveLiveFokAccounting(
        live: boolean,
        result: OrderResult | undefined | null,
        planned: { shares: number; price: number; costUsd: number }
    ): { shares: number; price: number; costUsd: number } {
        if (live && result?.success && result.fokFill) {
            return {
                shares: result.fokFill.shares,
                price: result.fokFill.avgPriceUsd,
                costUsd: result.fokFill.costUsd,
            };
        }
        return planned;
    }

    /**
     * Stock B live taker: reconcile internal `windowState` vs persisted order log and CLOB BUY totals
     * for both outcome tokens before risking a new taker clip.
     */
    private async verifyStockBTakerLedgerVsVenue(
        market: ActiveMarket,
        q: boolean
    ): Promise<{ ok: true } | { ok: false; reason: string }> {
        if (!this.config.liveTrading) return { ok: true };
        const st = this.windowState;
        if (!st) return { ok: false, reason: 'no window state' };

        await this.refreshClobTradesForLiveDashboardForced(market);
        const trades = this.sessionClobTradesByCondition.get(market.conditionId) ?? [];
        let clobYes = 0;
        let clobNo = 0;
        for (const t of trades) {
            if (t.side === 'YES') clobYes += t.size;
            else clobNo += t.size;
        }

        const hist = getOrderHistoryEntries().filter(
            (e) =>
                e.liveTrading &&
                e.windowEndIso === st.windowEndIso &&
                (e.conditionId == null || e.conditionId === market.conditionId)
        );
        if (hist.length === 0) {
            return { ok: true };
        }

        let histYes = 0;
        let histNo = 0;
        for (const e of hist) {
            if (e.side === 'YES') histYes += e.orderSizeShares;
            else histNo += e.orderSizeShares;
        }

        const eps = HedgeBot.DASHBOARD_FILL_MATCH_EPS;
        const qtyMatchHist =
            Math.abs(st.qtyYes - histYes) < eps && Math.abs(st.qtyNo - histNo) < eps;
        if (!qtyMatchHist) {
            await this.refreshLiveInventoryFromChain(market, q);
            const st2 = this.windowState;
            if (!st2) return { ok: false, reason: 'no window state after resync' };
            const ok2 =
                Math.abs(st2.qtyYes - histYes) < eps && Math.abs(st2.qtyNo - histNo) < eps;
            if (!ok2) {
                if (!q) {
                    console.warn(
                        `[Bot] Stock B taker preflight: internal Up=${st2.qtyYes.toFixed(3)} Down=${st2.qtyNo.toFixed(3)} ` +
                            `vs order-log Up=${histYes.toFixed(3)} Down=${histNo.toFixed(3)} | ${market.slug}`
                    );
                }
                return {
                    ok: false,
                    reason: `ledger vs order-log (Up ${st2.qtyYes.toFixed(2)} vs ${histYes.toFixed(2)}, Down ${st2.qtyNo.toFixed(2)} vs ${histNo.toFixed(2)})`,
                };
            }
        }

        if (trades.length > 0) {
            const clobDrift = Math.max(eps * 2, 0.25);
            if (Math.abs(clobYes - histYes) > clobDrift || Math.abs(clobNo - histNo) > clobDrift) {
                if (!q) {
                    console.warn(
                        `[Bot] Stock B taker preflight: CLOB buy totals Up=${clobYes.toFixed(3)} Down=${clobNo.toFixed(3)} ` +
                            `vs order-log Up=${histYes.toFixed(3)} Down=${histNo.toFixed(3)} | ${market.slug}`
                    );
                }
                return {
                    ok: false,
                    reason: `CLOB vs order-log (CLOB Up=${clobYes.toFixed(2)} Down=${clobNo.toFixed(2)}, log Up=${histYes.toFixed(2)} Down=${histNo.toFixed(2)})`,
                };
            }
        }

        return { ok: true };
    }

    /**
     * Live FOK: sync chain inventory and re-apply pair-cost / parity gates at the current ask
     * before submitting (avoids Stock B sized off stale fills or a moved book).
     */
    private async preflightLiveTakerClip(
        market: ActiveMarket,
        q: boolean,
        side: 'YES' | 'NO',
        sharesPlanned: number,
        alternateHedgeActive: boolean
    ): Promise<
        | {
              ok: true;
              shares: number;
              takerLimitPx: number;
              ask: number;
              stateBefore: WindowState;
          }
        | { ok: false; reason: string }
    > {
        await this.refreshLiveInventoryFromChain(market, q);
        let st = this.windowState;
        if (!st) return { ok: false, reason: 'no window state' };

        const isStockB = requiresMinDualAfterPnlForSimulatedBuy(st, side);
        if (isStockB) {
            const led = await this.verifyStockBTakerLedgerVsVenue(market, q);
            if (!led.ok) return led;
            st = this.windowState!;
        }

        let books: { bookYes: OrderBookSnapshot; bookNo: OrderBookSnapshot };
        try {
            books = await getBothOrderBooks(this.client, market, this.orderbookWs);
        } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            return { ok: false, reason: msg };
        }
        const ask = side === 'YES' ? books.bookYes.bestAsk ?? 0 : books.bookNo.bestAsk ?? 0;
        if (!(ask > 0)) return { ok: false, reason: 'no ask' };
        const ts = this.config.tickSize || 0.01;
        const takerLimitPx = Math.min(0.99, Math.round((ask + ts) * 100) / 100);
        this.liveBestBidYes = books.bookYes.bestBid ?? 0;
        this.liveBestBidNo = books.bookNo.bestBid ?? 0;
        this.liveBestAskYes = books.bookYes.bestAsk ?? 0;
        this.liveBestAskNo = books.bookNo.bestAsk ?? 0;
        this.liveCombinedBid = this.liveBestBidYes + this.liveBestBidNo;
        this.liveCombinedAsk = this.liveBestAskYes + this.liveBestAskNo;

        st = this.windowState!;
        const cfg = alternateHedgeActive ? this.configForAlternatePairClamp() : this.config;
        const kPf = this.config.binaryOutcomeTakerFeeScalar ?? 0.072;
        const takerAllInUnit =
            kPf > 0 && takerLimitPx > 0 && takerLimitPx < 1
                ? binaryOutcomeBuyAllInPerShare(takerLimitPx, kPf)
                : takerLimitPx;
        const bypassGates =
            this.config.unrestrictedPredictionBuys === true &&
            !requiresMinDualAfterPnlForSimulatedBuy(st, side);
        const oppPf = this.oppositeAskAllInFirstLegGate(st, side, books, cfg);
        const preflightClampOpts: {
            bypassPairCostAndSettlement?: boolean;
            oppositeAskAllInForFirstLegGate?: number;
            simulatedFillLiquidity?: OrderLiquidityRole;
        } = { oppositeAskAllInForFirstLegGate: oppPf, simulatedFillLiquidity: 'TAKER' };
        if (bypassGates) preflightClampOpts.bypassPairCostAndSettlement = true;
        let shares = clampBuySizeForSimulatedGates(
            st,
            side,
            takerLimitPx,
            sharesPlanned,
            cfg,
            preflightClampOpts
        );
        const minSz = Math.max(market.orderMinSize || 0, this.config.orderMinSize || 1);
        if (shares > 0) {
            shares = capClipForSettlementQtyParity(st, side, shares, minSz);
        }
        if (shares <= 0) {
            return { ok: false, reason: 'pair or parity gates at current ask' };
        }
        if (shares * takerAllInUnit < 1.0) {
            return { ok: false, reason: 'below CLOB $1 after preflight' };
        }

        if (isStockB && shares >= minSz) {
            const minD = minDualAfterPnlUsd(this.config);
            const strictAbove = minDualAfterPnlStrictAbove(this.config);
            const pairCeilPf = pairCostCeiling(cfg);
            const stRef = this.windowState!;
            let sh = shares;
            while (sh >= minSz) {
                const legCostUsd = buyBinaryOutcomeLegUsd(
                    sh,
                    takerLimitPx,
                    'TAKER',
                    cfg.feeBips ?? 0,
                    cfg.binaryOutcomeTakerFeeScalar ?? 0
                );
                const legComm = takerCommissionUsdForBinaryBuy(
                    sh,
                    takerLimitPx,
                    'TAKER',
                    cfg.feeBips ?? 0,
                    cfg.binaryOutcomeTakerFeeScalar ?? 0
                );
                const newSt = updateWindowStateFromFill(stRef, side, sh, legCostUsd, {
                    takerCommissionUsd: legComm,
                });
                const ap = afterPnlsFromState(newSt);
                const dualOk = dualAfterPnlMeetsMin(
                    ap.afterPnlIfUp,
                    ap.afterPnlIfDown,
                    minD,
                    strictAbove
                );
                const withinPairCeiling = newSt.pairCost <= pairCeilPf + 1e-9;
                const pairOk = withinPairCeiling && newSt.pairCost < 1.0 - 1e-9;
                if (dualOk && pairOk) {
                    shares = sh;
                    break;
                }
                sh--;
            }
            if (shares < minSz) {
                return {
                    ok: false,
                    reason: `Stock B taker: no size ≥${minSz} meets net After PnL ≥ $${minD.toFixed(2)} after modeled fees at ask`,
                };
            }
        }

        const capPre = this.capSingleLegSharesByMaxUsdAndMaxClip(shares, takerLimitPx, market);
        if (capPre !== shares) {
            shares = capPre;
            if (shares < minSz || shares * takerAllInUnit < 1.0) {
                return {
                    ok: false,
                    reason: 'maxSingleOrderUsd/maxClipShares cap after preflight leaves size below CLOB $1 or order minimum',
                };
            }
        }

        if (this.config.pairLadderMatchEnabled === true && shares > 0) {
            const { lo: plPf } = this.pairStockARandomClipBounds(
                market,
                this.liveBestBidYes,
                this.liveBestBidNo
            );
            if (shares < plPf) {
                return {
                    ok: false,
                    reason: `pair-ladder min clip ${plPf} not met after live taker preflight (${shares} sh)`,
                };
            }
        }

        return { ok: true, shares, takerLimitPx, ask, stateBefore: st };
    }

    /**
     * Called when a pending order completes (fully filled or cancelled).
     */
    private onOrderCompleted(order: PendingOrder, totalFilledShares: number): void {
        if (totalFilledShares > 0) {
            this.lastBuyPrice = order.price;
            this.lastExecutedSide = order.side;
            this.roundsThisWindow++;
            this.lastBalanceFetchTs = 0;
            this.lastPositionFetchTs = 0;
            this.lastExecutedEntry = {
                timestampIso: new Date().toISOString(),
                side: order.side,
                shares: totalFilledShares,
                price: order.price,
                reasonCode: this.activePendingOrderReasonCode ?? 'UNKNOWN',
            };
        }
        this.activePendingOrderReasonCode = null;
    }

    private getSizeLadder(): number[] {
        return buildSizeLadderFromConfig(this.config);
    }

    private chooseSide(bestBidYes: number, bestBidNo: number): 'YES' | 'NO' {
        return this.chooseSideDecision(bestBidYes, bestBidNo).side;
    }

    private chooseSideDecision(
        bestBidYes: number,
        bestBidNo: number
    ): ReturnType<typeof explainReferenceBuySide> {
        const wm = this.cachedMarket;
        const ws = this.windowState!;
        const windowSec = wm?.windowDurationSec ?? btcWindowDurationSec(this.config);
        const secondsLeft = wm
            ? btcUpDownWindowElapsedAndRemaining({
                  slug: wm.slug,
                  endDateIso: wm.endDateIso,
                  windowDurationSec: windowSec,
                  gameStartTime: wm.gameStartTime,
              }).secondsLeft
            : secondsUntilWindowEnd(ws.windowEndIso);
        return explainReferenceBuySide(ws, bestBidYes, bestBidNo, this.roundsThisWindow, this.lastExecutedSide, this.config, {
            secondsLeft,
            windowSec,
        });
    }

    /** Append YES/NO best asks for rolling velocity (same window as early Down momentum). */
    private recordBestAskSamplesForMomentum(bookYes: OrderBookSnapshot, bookNo: OrderBookSnapshot): void {
        const nowMs = Date.now();
        const maxAge = DEFAULT_NO_ASK_SAMPLE_MAX_AGE_MS;
        const ya = bookYes.bestAsk ?? 0;
        const na = bookNo.bestAsk ?? 0;
        if (ya > 0) {
            this.yesAskMomentumSamples.push({ t: nowMs, ask: ya });
            this.yesAskMomentumSamples = pruneNoAskSamples(this.yesAskMomentumSamples, maxAge, nowMs);
        }
        if (na > 0) {
            this.noAskMomentumSamples.push({ t: nowMs, ask: na });
            this.noAskMomentumSamples = pruneNoAskSamples(this.noAskMomentumSamples, maxAge, nowMs);
        }
    }

    /**
     * After reference side pick: optional BTC gap + dual ask velocity + spread tilt (see predictLikelyRisingSide).
     * Does not override parity / inventory rebalance reasons.
     */
    private applyEntryRiseSignal(
        base: EntryDirectionDecision,
        bestBidYes: number,
        bestBidNo: number,
        bookYes: OrderBookSnapshot,
        bookNo: OrderBookSnapshot,
        btcDelta: number | null
    ): { decision: EntryDirectionDecision; riseTag: string | null } {
        if (this.config.entryRiseSignalEnabled !== true) {
            return { decision: base, riseTag: null };
        }
        if (base.reason === 'PARITY_REBALANCE' || base.reason === 'INVENTORY_IMBALANCE') {
            return { decision: base, riseTag: null };
        }
        const minSpan = this.config.entryRiseAskVelMinSpanSec ?? 2;
        const vy = downAskVelocityUsdPerSec(this.yesAskMomentumSamples, minSpan);
        const vn = downAskVelocityUsdPerSec(this.noAskMomentumSamples, minSpan);
        const yesAsk = bookYes.bestAsk ?? 0;
        const noAsk = bookNo.bestAsk ?? 0;
        const spreadYes = yesAsk > 0 && bestBidYes > 0 ? yesAsk - bestBidYes : 0;
        const spreadNo = noAsk > 0 && bestBidNo > 0 ? noAsk - bestBidNo : 0;
        const pred = predictLikelyRisingSide(this.config, {
            btcUsdDeltaFromWindowOpen: btcDelta,
            yesAsk,
            noAsk,
            yesAskVelocityUsdPerSec: vy,
            noAskVelocityUsdPerSec: vn,
            spreadYes,
            spreadNo,
        });
        if (pred.side === null || pred.side === base.side) {
            return { decision: base, riseTag: null };
        }
        return {
            decision: { ...base, side: pred.side },
            riseTag: `RISE_OVERRIDE|${pred.detail}|was=${base.side}`,
        };
    }

    private chooseClipSize(currentBid: number, secondsLeft: number, windowSec: number): number {
        const bal = this.config.liveTrading
            ? this.cachedBalances.polymarketUsdc
            : getSimulatedBalance();
        return referencePickClipSize(
            this.windowState!,
            currentBid,
            secondsLeft,
            windowSec,
            this.config,
            this.getSizeLadder(),
            { availableBalanceUsd: bal }
        );
    }

    /** Alternate-hedge clip: [min,max] from config, anchored on initialEntryShares (same spirit as first order). */
    private pickAlternateHedgeClipShares(market: ActiveMarket): number {
        const lo = this.config.alternateHedgeClipMinShares ?? 10;
        const hi = this.config.alternateHedgeClipMaxShares ?? 30;
        const init = Math.floor(this.config.initialEntryShares ?? 20);
        const sh = Math.min(hi, Math.max(lo, init));
        const om = market.orderMinSize || 0;
        const cm = Math.floor(this.config.orderMinSize || 1);
        return Math.max(sh, Math.max(om, cm));
    }

    /** Tighter pair-cost ceiling for alternate hedge sequence (default 0.99), never above strict fee-inclusive cap. */
    private configForAlternatePairClamp(): StrategyConfig {
        const cap = this.config.alternatePairCostMax ?? 0.99;
        const strict = this.config.strictMaxPairCostInclusive ?? 0.98;
        const eff = Math.min(cap, strict, this.config.targetPairCostMax, this.config.safetyMargin);
        return {
            ...this.config,
            targetPairCostMax: eff,
            safetyMargin: eff,
        };
    }

    /** Extra shares on first opposite leg (one-sided → both legs); 0/0 config = strict share match to A. */
    private pickFirstOppositeLegExtraShares(): number {
        const cfg = this.config;
        if (cfg.momentumImbalanceStrategyEnabled === false) return 0;
        const lo = Math.max(0, Math.floor(cfg.oppositeLegFirstHedgeExtraSharesMin ?? 2));
        const hi = Math.max(lo, Math.floor(cfg.oppositeLegFirstHedgeExtraSharesMax ?? 3));
        const span = hi - lo + 1;
        return lo + Math.floor(Math.abs(Date.now() / 1000) % span);
    }

    private isFirstOppositeLeg(state: WindowState, side: 'YES' | 'NO'): boolean {
        const z = 1e-8;
        return (
            (state.qtyYes > z && state.qtyNo <= z && side === 'NO') ||
            (state.qtyNo > z && state.qtyYes <= z && side === 'YES')
        );
    }

    /** Integer share gap |Up − Down| (pair ladder hedge size). */
    private pairQtyImbalanceShares(ws: WindowState): number {
        return Math.max(0, Math.floor(Math.abs(ws.qtyYes - ws.qtyNo) + 1e-9));
    }

    /** Lighter leg when imbalanced; null when balanced. */
    private pairLighterHedgeSide(ws: WindowState): 'YES' | 'NO' | null {
        const z = 1e-8;
        const d = ws.qtyYes - ws.qtyNo;
        if (Math.abs(d) <= z) return null;
        return d < 0 ? 'YES' : 'NO';
    }

    /**
     * Inclusive [lo, hi] for pair-ladder Stock A clips: config band lifted to CLOB/order mins,
     * then tightened by `maxClipShares` and `maxSingleOrderUsd` (using the larger of the two bids
     * as a conservative USD bound so Stock B can mirror the same size under the same caps).
     */
    private pairStockARandomClipBounds(
        market: ActiveMarket,
        bidYesHint?: number,
        bidNoHint?: number
    ): { lo: number; hi: number } {
        const orderMin = Math.max(market.orderMinSize || 0, this.config.orderMinSize || 1);
        let lo = Math.max(orderMin, Math.floor(this.config.pairStockARandomSharesMin ?? 25));
        let hi = Math.max(lo, Math.floor(this.config.pairStockARandomSharesMax ?? 75));

        const maxClip = Math.max(1, Math.floor(this.config.maxClipShares ?? 1_000_000));
        hi = Math.min(hi, maxClip);

        const maxOrd = this.config.maxSingleOrderUsd;
        const by = bidYesHint != null && Number.isFinite(bidYesHint) && bidYesHint > 0 ? bidYesHint : 0;
        const bn = bidNoHint != null && Number.isFinite(bidNoHint) && bidNoHint > 0 ? bidNoHint : 0;
        const refBid = Math.max(by, bn, 1e-6);
        if (maxOrd != null && maxOrd > 0 && refBid > 0) {
            hi = Math.min(hi, Math.floor(maxOrd / refBid + 1e-9));
        }
        hi = Math.max(lo, hi);
        return { lo, hi };
    }

    /** When inventory is empty, opposite leg ask (all-in) for first-leg pair-cost gate in `clampBuySizeForSimulatedGates`. */
    private oppositeAskAllInFirstLegGate(
        state: WindowState,
        side: 'YES' | 'NO',
        books: { bookYes: OrderBookSnapshot; bookNo: OrderBookSnapshot } | null,
        cfg: StrategyConfig
    ): number | undefined {
        const z = 1e-8;
        if (!books || state.qtyYes > z || state.qtyNo > z) return undefined;
        return oppositeAskAllInForSide(side, books.bookYes, books.bookNo, cfg);
    }

    /** Empty book: opposite outcome best bid (raw) — paired with maker first leg for implied pair-cost gate. */
    private oppositeBidFirstLegGate(
        state: WindowState,
        side: 'YES' | 'NO',
        books: { bookYes: OrderBookSnapshot; bookNo: OrderBookSnapshot } | null
    ): number | undefined {
        const z = 1e-8;
        if (!books || state.qtyYes > z || state.qtyNo > z) return undefined;
        const raw = side === 'YES' ? books.bookNo.bestBid : books.bookYes.bestBid;
        if (raw === undefined || !(raw > 0) || !(raw < 1)) return undefined;
        return raw;
    }

    /**
     * Stock A = any ladder buy that is not the dual-after-PnL hedge leg (see `requiresMinDualAfterPnlForSimulatedBuy`).
     * Pair-ladder Stock A clips must come from `[pairStockARandomSharesMin, pairStockARandomSharesMax]`, not the global size ladder.
     */
    private isPairLadderStockALeg(state: WindowState, side: 'YES' | 'NO'): boolean {
        if (this.config.pairLadderMatchEnabled !== true) return false;
        return !requiresMinDualAfterPnlForSimulatedBuy(state, side);
    }

    /** Enforce per-order Stock A size within `pairStockARandomSharesMin` … `Max` (after floor + USD/clip caps). */
    private clampPairLadderStockAClip(
        market: ActiveMarket,
        shares: number,
        bestBidYes?: number,
        bestBidNo?: number
    ): number {
        const { lo, hi } = this.pairStockARandomClipBounds(market, bestBidYes, bestBidNo);
        const s = Math.floor(shares);
        if (!Number.isFinite(s)) return lo;
        return Math.min(hi, Math.max(lo, s));
    }

    /** Per submitted leg: shares ≤ `maxClipShares` and all-in cost ≤ `maxSingleOrderUsd` when fee scalar is on. */
    private capSingleLegSharesByMaxUsdAndMaxClip(
        shares: number,
        fillPricePerShare: number,
        market: ActiveMarket
    ): number {
        const k = this.config.binaryOutcomeTakerFeeScalar ?? 0.072;
        const p =
            k > 0 && fillPricePerShare > 0 && fillPricePerShare < 1
                ? binaryOutcomeBuyAllInPerShare(fillPricePerShare, k)
                : fillPricePerShare;
        let s = Math.floor(shares);
        if (!Number.isFinite(s) || s <= 0) return 0;
        const maxClip = Math.max(1, Math.floor(this.config.maxClipShares ?? 1_000_000));
        s = Math.min(s, maxClip);
        const maxOrd = this.config.maxSingleOrderUsd ?? Number.POSITIVE_INFINITY;
        if (p > 0 && Number.isFinite(maxOrd) && maxOrd > 0 && maxOrd < Number.POSITIVE_INFINITY) {
            s = Math.min(s, Math.floor(maxOrd / p + 1e-9));
        }
        return Math.max(0, s);
    }

    private buildEntryRiseSignalInputForStockA(
        btcDelta: number | null,
        bookYes: OrderBookSnapshot,
        bookNo: OrderBookSnapshot,
        bestBidYes: number,
        bestBidNo: number
    ): EntryRiseSignalInput {
        const minSpan = this.config.entryRiseAskVelMinSpanSec ?? 2;
        const vy = downAskVelocityUsdPerSec(this.yesAskMomentumSamples, minSpan);
        const vn = downAskVelocityUsdPerSec(this.noAskMomentumSamples, minSpan);
        const yesAsk = bookYes.bestAsk ?? 0;
        const noAsk = bookNo.bestAsk ?? 0;
        const spreadYes = yesAsk > 0 && bestBidYes > 0 ? yesAsk - bestBidYes : 0;
        const spreadNo = noAsk > 0 && bestBidNo > 0 ? noAsk - bestBidNo : 0;
        return {
            btcUsdDeltaFromWindowOpen: btcDelta,
            yesAsk,
            noAsk,
            yesAskVelocityUsdPerSec: vy,
            noAskVelocityUsdPerSec: vn,
            spreadYes,
            spreadNo,
        };
    }

    /**
     * Pair-ladder Stock A clip: **high** momentum/BTC composite → `pairStockARandomSharesMax` (within caps);
     * **low** (inconclusive tilt) → `pairStockARandomSharesMin`. Uses the same composite as entry-rise
     * (`evaluateLikelyRisingSideSignal`) regardless of `entryRiseSignalEnabled`.
     */
    private pickPairStockASharesForMomentum(
        market: ActiveMarket,
        riseInput: EntryRiseSignalInput | null,
        bestBidYes: number,
        bestBidNo: number
    ): number {
        const { lo, hi } = this.pairStockARandomClipBounds(market, bestBidYes, bestBidNo);
        if (!riseInput) return lo;
        const ev = evaluateLikelyRisingSideSignal(this.config, riseInput);
        const sep = Math.max(1e-6, this.config.entryRiseMinScoreSeparation ?? 0.25);
        const strong = ev.side !== null && Math.abs(ev.tilt) >= sep;
        return strong ? hi : lo;
    }

    /**
     * Strong Up gap + already more Up than Down: pause only **additional Up** on **Stock B** (hedge) path.
     * Stock A (momentum continuation / new ladder leg) is never paused here so the bot keeps scaling the
     * favored side per BTC gap. Strong Down gap (≤ allowDown): never pause Down.
     * Near expiry (secondsLeft ≤ momentumPauseMinSecondsLeft): no pause.
     */
    private shouldMomentumPauseTrading(
        btcGapUsd: number | null,
        state: WindowState,
        secondsLeft: number,
        side: 'YES' | 'NO'
    ): boolean {
        const cfg = this.config;
        if (cfg.unrestrictedPredictionBuys === true) return false;
        if (cfg.momentumImbalanceStrategyEnabled === false) return false;
        if (!requiresMinDualAfterPnlForSimulatedBuy(state, side)) return false;
        if (cfg.momentumPauseWhenUpFavoredEnabled === false) return false;
        if (btcGapUsd == null || !Number.isFinite(btcGapUsd)) return false;
        const pauseGap = cfg.momentumBiasGapUsd ?? 35;
        const allowDown = cfg.momentumAllowDownGapUsd ?? -35;
        const minSec = cfg.momentumPauseMinSecondsLeft ?? 0;
        if (secondsLeft <= minSec) return false;
        if (btcGapUsd <= allowDown && side === 'NO') return false;
        if (btcGapUsd >= pauseGap && state.qtyYes > state.qtyNo + 1e-6 && side === 'YES') {
            return true;
        }
        return false;
    }

    /**
     * Pair ladder matched book: halt new scaling when open mark (best bids) sits in the configured band
     * around `maxPositionPerWindowUsd − pairStockARandomSharesMax`.
     */
    private isBalancedOpenPositionValueInStopBand(
        state: WindowState,
        bookYes: OrderBookSnapshot,
        bookNo: OrderBookSnapshot
    ): boolean {
        const cfg = this.config;
        if (cfg.balancedOpenPositionValueStopEnabled === false) return false;
        if (cfg.pairLadderMatchEnabled !== true) return false;

        const maxPos = cfg.maxPositionPerWindowUsd ?? 0;
        if (!Number.isFinite(maxPos) || maxPos <= 0) return false;

        const qtyEps = 1e-8;
        const y = state.qtyYes;
        const n = state.qtyNo;
        if (y <= qtyEps || n <= qtyEps) return false;
        if (Math.abs(y - n) > qtyEps) return false;

        const by = bookYes.bestBid ?? 0;
        const bn = bookNo.bestBid ?? 0;
        if (!(by > 0 && bn > 0)) return false;

        const openVal = y * by + n * bn;
        const stockAMax = Number(cfg.pairStockARandomSharesMax ?? 0);
        if (!Number.isFinite(stockAMax)) return false;

        const band = cfg.balancedOpenPositionValueStopBandUsd ?? 20;
        if (!Number.isFinite(band) || band < 0) return false;

        const center = maxPos - stockAMax;
        return openVal >= center - band && openVal <= center + band;
    }

    // ─── Window summary ──────────────────────────────────────────────────

    private async logWindowEndSummary(state: WindowState): Promise<void> {
        const ordersInWindow = getOrdersForWindow(state.windowEndIso);
        const feeEstimate = !this.config.liveTrading
            ? sumPaperRecordedTakerFeesUsd(ordersInWindow, this.config.feeBips)
            : estimateTakerFeesFromLegVwapUsd(
                  state.qtyYes,
                  state.avgYes,
                  state.qtyNo,
                  state.avgNo,
                  this.config.feeBips
              );
        const estNetProfit = state.lockedProfit - feeEstimate;
        let paperRealizedNet: number | null = null;

        const slug = state.marketSlug;
        const trySettlementDetails = async (): Promise<GammaBtcUpDownWindowDetails> => {
            const empty: GammaBtcUpDownWindowDetails = {
                winner: null,
                priceToBeat: null,
                finalPrice: null,
            };
            for (let i = 0; i < 20; i++) {
                try {
                    const d = await fetchGammaBtcUpDownWindowDetails(slug);
                    if (d.winner != null || (d.priceToBeat != null && d.finalPrice != null)) {
                        return d;
                    }
                } catch {
                    /* retry */
                }
                const ms = i < 3 ? (i + 1) * 500 : 2000;
                await new Promise((r) => setTimeout(r, ms));
            }
            try {
                return await fetchGammaBtcUpDownWindowDetails(slug);
            } catch {
                return empty;
            }
        };
        const gammaDetails = await trySettlementDetails();
        const gammaWinner = gammaDetails.winner ?? undefined;
        const binanceEnd = await fetchBtcUsdPrice({ forceRefresh: true });
        const btcOpenSnap = gammaDetails.priceToBeat ?? this.btcUsdAtWindowOpen;
        const btcEndSnap = gammaDetails.finalPrice ?? binanceEnd;
        const { winner: settledWinner, source: settlementSource } = resolveBtcUpDownWindowWinner({
            slug,
            oraclePriceToBeat: gammaDetails.priceToBeat,
            oracleFinalPrice: gammaDetails.finalPrice,
            btcUsdOpen: this.btcUsdAtWindowOpen,
            btcUsdEnd: binanceEnd,
            gammaWinner: gammaWinner ?? null,
        });
        const winnerForPaper: 'YES' | 'NO' | undefined =
            settledWinner === 'UNKNOWN' ? undefined : settledWinner;
        const winnerLabel: 'YES' | 'NO' | 'UNKNOWN' = settledWinner;

        const btcMin = this.cachedMarket?.btcMarketWindowMinutes ?? this.config.btcMarketWindowMinutes;

        if (!this.config.liveTrading) {
            recordPaperWindowEnd({
                windowSlug: state.marketSlug,
                windowEndIso: state.windowEndIso,
                btcMarketWindowMinutes: btcMin,
                ordersInWindow,
                totalSpentUsd: state.totalSpentUsd,
                costYes: state.costYes,
                costNo: state.costNo,
                qtyYes: state.qtyYes,
                qtyNo: state.qtyNo,
                pairCost: state.pairCost,
                lockedProfit: state.lockedProfit,
                feeEstimate,
                winnerSide: winnerForPaper,
                btcUsdWindowOpen: btcOpenSnap,
                btcUsdWindowEnd: btcEndSnap,
                settlementWinnerSource: settlementSource,
            });

            const last = getCompletedWindowsDetail().slice(-1)[0];
            if (last && last.windowEndIso === state.windowEndIso) {
                paperRealizedNet = last.netProfit;
            }
        }

        const liveRealizedFromWinner =
            settledWinner === 'YES' || settledWinner === 'NO'
                ? (settledWinner === 'YES' ? state.qtyYes : state.qtyNo) -
                  state.totalSpentUsd -
                  feeEstimate
                : null;

        const netProfitForHistory = this.config.liveTrading
            ? (liveRealizedFromWinner ?? estNetProfit)
            : (paperRealizedNet ?? estNetProfit);

        this.completedWindows.push({
            slug: state.marketSlug,
            windowEnd: state.windowEndIso,
            pairCost: state.pairCost,
            qtyYes: state.qtyYes,
            qtyNo: state.qtyNo,
            costYes: state.costYes,
            costNo: state.costNo,
            lockedProfit: state.lockedProfit,
            totalSpent: state.totalSpentUsd,
            feeEstimate,
            netProfit: netProfitForHistory,
            winnerSide: winnerLabel,
            rounds: this.roundsThisWindow,
            btcUsdWindowOpen: btcOpenSnap,
            btcUsdWindowEnd: btcEndSnap,
            settlementWinnerSource: settlementSource,
        });
        markWindowOrderHistorySettlement(state.windowEndIso, netProfitForHistory, winnerLabel, {
            btcUsdWindowOpen: btcOpenSnap,
            btcUsdWindowEnd: btcEndSnap,
            settlementWinnerSource: settlementSource,
        });
        flushOrderHistoryToDisk();
        this.lastCompletedWindowNetProfitUsd = netProfitForHistory;
        const accounting = this.getAccountingSnapshot(state);
        logWindowState(
            state,
            'window_end',
            `Window ended | pairCost=${state.pairCost.toFixed(4)} | locked=$${state.lockedProfit.toFixed(2)} | ` +
                `fees~$${feeEstimate.toFixed(2)} | netP/L~$${estNetProfit.toFixed(2)} | rounds=${this.roundsThisWindow} | ` +
                `YES=${state.qtyYes} NO=${state.qtyNo}`,
            {
                feeBipsAssumption: this.config.feeBips,
                quietConsole: !!this.config.quietConsole,
                ...accounting,
            }
        );

        const q = !!this.config.quietConsole;
        const totalPL = this.completedWindows.reduce((s, w) => s + w.netProfit, 0);
        qlog(q, `\n===== WINDOW COMPLETE: ${state.marketSlug} =====`);
        qlog(q, `  Rounds:         ${this.roundsThisWindow}`);
        qlog(q, `  Pair cost:      ${state.pairCost.toFixed(4)}`);
        qlog(q, `  Qty YES/NO:     ${state.qtyYes} / ${state.qtyNo}`);
        qlog(q, `  Cost YES/NO:    $${state.costYes.toFixed(2)} / $${state.costNo.toFixed(2)}`);
        qlog(q, `  Total spent:    $${state.totalSpentUsd.toFixed(2)}`);
        qlog(q, `  Locked profit:  $${state.lockedProfit.toFixed(2)}`);
        qlog(q, `  Est. fees:      $${feeEstimate.toFixed(2)} (${this.config.feeBips} bips)`);
        qlog(q, `  Net P/L (est):  $${estNetProfit.toFixed(2)}`);
        qlog(q, `  Settled winner: ${winnerLabel} (${settlementSource})`);
        qlog(
            q,
            `  BTC open/end:   ${btcOpenSnap != null ? btcOpenSnap.toFixed(2) : 'n/a'} → ` +
                `${btcEndSnap != null ? btcEndSnap.toFixed(2) : 'n/a'}`
        );
        qlog(q, `  Windows done:   ${this.completedWindows.length}`);
        qlog(q, `  Cumulative P/L: $${totalPL.toFixed(2)}`);
        qlog(q, `==========================================\n`);

        if (this.config.liveTrading && state.conditionId && (state.qtyYes > 0 || state.qtyNo > 0)) {
            this.redeemQueue.add(state.conditionId);
            redeemPositions(state.conditionId)
                .then((res) => {
                    if (res.success) this.redeemQueue.delete(state.conditionId);
                })
                .catch(() => {});
        }
    }

    // ─── Redemption sweep ────────────────────────────────────────────────

    private async runRedeemSweep(): Promise<void> {
        if (this.redeemSweepRunning || this.redeemQueue.size === 0) return;
        this.redeemSweepRunning = true;
        let redeemed = 0,
            failed = 0;
        try {
            for (const conditionId of Array.from(this.redeemQueue)) {
                const res = await redeemPositions(conditionId);
                if (res.success) {
                    this.redeemQueue.delete(conditionId);
                    redeemed++;
                } else {
                    failed++;
                }
            }
        } catch {
            failed++;
        } finally {
            this.lastRedeemSweepIso = new Date().toISOString();
            this.lastRedeemSweepResult = `redeemed=${redeemed}, failed=${failed}, remaining=${this.redeemQueue.size}`;
            this.redeemSweepRunning = false;
        }
    }

    /**
     * If the last closed window was UNKNOWN, retry Gamma + BTC spot settlement (paper adjusts balance;
     * live updates completedWindows + order history only).
     */
    private async maybeReconcileUnknownWindowSettlement(): Promise<void> {
        if (!this.config.liveTrading) {
            const last = getCompletedWindowsDetail().slice(-1)[0];
            if (!last || last.winnerSide !== 'UNKNOWN') return;
            const now = Date.now();
            if (now - this.lastUnknownWindowReconcileMs < 4000) return;
            this.lastUnknownWindowReconcileMs = now;
            try {
                const details = await fetchGammaBtcUpDownWindowDetails(last.windowSlug);
                const btcEnd = await fetchBtcUsdPrice({ forceRefresh: true });
                const { winner, source } = resolveBtcUpDownWindowWinner({
                    slug: last.windowSlug,
                    oraclePriceToBeat: details.priceToBeat,
                    oracleFinalPrice: details.finalPrice,
                    btcUsdOpen: last.btcUsdWindowOpen ?? null,
                    btcUsdEnd: btcEnd,
                    gammaWinner: details.winner ?? null,
                });
                if (winner === 'UNKNOWN') return;
                const endSnap = details.finalPrice ?? btcEnd;
                const openSnap = details.priceToBeat ?? last.btcUsdWindowOpen ?? null;
                if (
                    !correctLastUnknownWindowSettlement(winner, {
                        btcUsdWindowOpen: openSnap,
                        btcUsdWindowEnd: endSnap,
                        settlementWinnerSource: source,
                    })
                ) {
                    return;
                }
                const fixed = getCompletedWindowsDetail().slice(-1)[0];
                const idx = this.completedWindows.findIndex((x) => x.windowEnd === fixed.windowEndIso);
                if (idx >= 0) {
                    this.completedWindows[idx].netProfit = fixed.netProfit;
                    this.completedWindows[idx].winnerSide = fixed.winnerSide;
                    this.completedWindows[idx].btcUsdWindowOpen =
                        fixed.btcUsdWindowOpen ?? this.completedWindows[idx].btcUsdWindowOpen;
                    this.completedWindows[idx].btcUsdWindowEnd =
                        fixed.btcUsdWindowEnd ?? this.completedWindows[idx].btcUsdWindowEnd;
                    this.completedWindows[idx].settlementWinnerSource =
                        fixed.settlementWinnerSource ?? this.completedWindows[idx].settlementWinnerSource;
                }
                markWindowOrderHistorySettlement(fixed.windowEndIso, fixed.netProfit, fixed.winnerSide, {
                    btcUsdWindowOpen: fixed.btcUsdWindowOpen,
                    btcUsdWindowEnd: fixed.btcUsdWindowEnd,
                    settlementWinnerSource: fixed.settlementWinnerSource,
                });
                flushOrderHistoryToDisk();
                this.lastCompletedWindowNetProfitUsd = fixed.netProfit;
            } catch {
                /* ignore */
            }
            return;
        }

        const lastLive = this.completedWindows[this.completedWindows.length - 1];
        if (!lastLive || lastLive.winnerSide !== 'UNKNOWN') return;
        const nowLive = Date.now();
        if (nowLive - this.lastUnknownWindowReconcileMs < 4000) return;
        this.lastUnknownWindowReconcileMs = nowLive;
        try {
            const details = await fetchGammaBtcUpDownWindowDetails(lastLive.slug);
            const btcEnd = await fetchBtcUsdPrice({ forceRefresh: true });
            const { winner, source } = resolveBtcUpDownWindowWinner({
                slug: lastLive.slug,
                oraclePriceToBeat: details.priceToBeat,
                oracleFinalPrice: details.finalPrice,
                btcUsdOpen: lastLive.btcUsdWindowOpen,
                btcUsdEnd: btcEnd,
                gammaWinner: details.winner ?? null,
            });
            if (winner === 'UNKNOWN') return;
            const idx = this.completedWindows.length - 1;
            const netProfit =
                (winner === 'YES' ? lastLive.qtyYes : lastLive.qtyNo) -
                lastLive.totalSpent -
                lastLive.feeEstimate;
            const openSnap = details.priceToBeat ?? lastLive.btcUsdWindowOpen;
            const endSnap = details.finalPrice ?? btcEnd;
            this.completedWindows[idx] = {
                ...lastLive,
                winnerSide: winner,
                netProfit,
                btcUsdWindowOpen: openSnap,
                btcUsdWindowEnd: endSnap,
                settlementWinnerSource: source,
            };
            markWindowOrderHistorySettlement(lastLive.windowEnd, netProfit, winner, {
                btcUsdWindowOpen: openSnap,
                btcUsdWindowEnd: endSnap,
                settlementWinnerSource: source,
            });
            flushOrderHistoryToDisk();
            this.lastCompletedWindowNetProfitUsd = netProfit;
        } catch {
            /* ignore */
        }
    }

    // ─── Dashboard helpers ───────────────────────────────────────────────

    private getDashboardExtras(): Partial<import('./dashboard').DashboardState> {
        const totalPL = this.completedWindows.reduce((s, w) => s + w.netProfit, 0);
        const lastHistPaper = getCompletedWindowsDetail().slice(-1)[0];
        const lastLive = this.completedWindows.length > 0 ? this.completedWindows[this.completedWindows.length - 1] : null;
        const display = this.getDashboardDisplayWindowState();
        const accounting = this.getAccountingSnapshot(display ?? this.windowState ?? undefined);
        const scan = getLastScanReport();
        const balanceUsdc = this.config.liveTrading
            ? this.cachedBalances.polymarketUsdc
            : getSimulatedBalance();
        const totalBalanceUsdc = this.config.liveTrading
            ? this.cachedBalances.totalUsdc
            : getSimulatedBalance();
        const titleQ = (this.cachedMarket?.question || scan?.activeMarket?.question || '').trim();
        const nowDecision = this.pickDecisionAtOffset(0);
        const decision30s = this.pickDecisionAtOffset(30_000);
        const decision60s = this.pickDecisionAtOffset(60_000);
        return {
            walletBalanceUsdc: this.config.liveTrading ? this.cachedBalances.publicWalletUsdc : 0,
            polymarketBalanceUsdc: balanceUsdc,
            totalBalanceUsdc,
            walletAddress: ENV.PUBLIC_ADDRESS,
            proxyWalletAddress: ENV.PROXY_WALLET,
            liveTrading: this.config.liveTrading,
            activeMarketTitle: titleQ || null,
            tradingWindowMinutes: this.config.btcMarketWindowMinutes,
            completedWindows: this.completedWindows.length,
            cumulativeProfitUsd: totalPL,
            lastClosedWindowNetUsd: this.config.liveTrading
                ? (lastLive?.netProfit ?? null)
                : (lastHistPaper?.netProfit ?? null),
            lastClosedWindowWinner: this.config.liveTrading
                ? (lastLive?.winnerSide ?? null)
                : (lastHistPaper?.winnerSide ?? null),
            uptimeSeconds: Math.floor((Date.now() - this.startedAt) / 1000),
            maxPositionPerWindowUsd: this.config.maxPositionPerWindowUsd,
            scanSlugsChecked: scan?.slugsChecked ?? [],
            scanMarketsReturned: scan?.marketsReturned ?? 0,
            scanTotalApiFetched: scan?.totalApiFetched ?? 0,
            scanActiveMarket: scan?.activeMarket ?? null,
            scanRejected: scan?.rejected ?? [],
            scanError: scan?.error ?? null,
            scanTimestamp: scan?.timestamp ?? null,
            liveBestAskYes: this.liveBestAskYes,
            liveBestAskNo: this.liveBestAskNo,
            liveCombinedAsk: this.liveCombinedAsk,
            liveBestBidYes: this.liveBestBidYes,
            liveBestBidNo: this.liveBestBidNo,
            liveCombinedBid: this.liveCombinedBid,
            livePairCostCeiling: this.config.targetPairCostMax,
            liveEffectiveMinShares: this.config.orderSizeShares,
            entryOrderYes:
                this.activePendingOrder?.side === 'YES'
                    ? {
                          price: this.activePendingOrder.price,
                          size: this.activePendingOrder.sizeRequested,
                          placedAt: this.activePendingOrder.placedAt,
                      }
                    : null,
            entryOrderNo:
                this.activePendingOrder?.side === 'NO'
                    ? {
                          price: this.activePendingOrder.price,
                          size: this.activePendingOrder.sizeRequested,
                          placedAt: this.activePendingOrder.placedAt,
                      }
                    : null,
            pairCost: display?.pairCost ?? 0,
            qtyYes: display?.qtyYes ?? 0,
            qtyNo: display?.qtyNo ?? 0,
            lockedProfit: display?.lockedProfit ?? 0,
            totalSpentUsd: display?.totalSpentUsd ?? 0,
            takerCommissionPaidUsd: display?.takerCommissionPaidUsd ?? 0,
            binaryOutcomeTakerFeeScalar: this.config.binaryOutcomeTakerFeeScalar ?? 0.072,
            costYes: display?.costYes ?? 0,
            costNo: display?.costNo ?? 0,
            avgYes: display?.avgYes ?? 0,
            avgNo: display?.avgNo ?? 0,
            balanceLastCheckedIso: this.balanceLastCheckedIso,
            redeemQueueSize: this.redeemQueue.size,
            lastRedeemSweepIso: this.lastRedeemSweepIso,
            lastRedeemSweepResult: this.lastRedeemSweepResult,
            feeBipsAssumption: this.config.feeBips,
            positionValueUsd: accounting.positionValueUsd,
            positionCostUsd: accounting.positionCostUsd,
            unrealizedPnlUsd: accounting.unrealizedPnlUsd,
            portfolioValueUsd: accounting.portfolioValueUsd,
            sessionPnlUsd: accounting.sessionPnlUsd,
            sessionStartPortfolioUsd: accounting.sessionStartPortfolioUsd,
            trackedQtyYes: this.windowState?.qtyYes ?? 0,
            trackedQtyNo: this.windowState?.qtyNo ?? 0,
            actualQtyYes: this.cachedActualPosition.qtyYes,
            actualQtyNo: this.cachedActualPosition.qtyNo,
            entryDecisionNow: nowDecision,
            entryDecision30sAgo: decision30s,
            entryDecision60sAgo: decision60s,
            lastExecutedEntry: this.lastExecutedEntry,
            marketTiltEpsilon: this.config.marketTiltEpsilon ?? 0.02,
            pairTiltImbalanceShares: this.config.pairTiltImbalanceShares ?? 10,
            forcedSwitchEveryNOrders: this.config.forcedSwitchEveryNOrders ?? 4,
            btcUsdWindowOpen: this.btcUsdAtWindowOpen,
            btcUsdSpot: this.lastBtcUsdSpot,
            btcGapUsd:
                this.lastBtcUsdSpot != null && this.btcUsdAtWindowOpen != null
                    ? this.lastBtcUsdSpot - this.btcUsdAtWindowOpen
                    : null,
            btcGapVelocityUsdPerSec: this.btcMomentumSnapshot.velocityUsdPerSec,
            btcGapPredicted60sUsd: this.btcMomentumSnapshot.predictedGap60sUsd,
            btcGapFlipDetectedThisTick: this.btcMomentumSnapshot.flipDetected,
            btcGapSignDeadZoneUsd: this.config.btcGapSignDeadZoneUsd ?? 5,
            momentumInversionHedgeEnabled: this.config.momentumInversionHedgeEnabled !== false,
            downAskMomentumUsdPerSec: this.downAskMomentumUsdPerSecDisplay,
            downAskPredictedAtWindowEndUsd: this.downAskPredictedAtWindowEndUsdDisplay,
            earlyDownMomentumHedgeEnabled: this.config.earlyDownMomentumHedgeEnabled === true,
            liveClobVerifiedTrades: this.cachedMarket
                ? (this.sessionClobTradesByCondition.get(this.cachedMarket.conditionId) ?? [])
                : [],
            sessionClobTradesByCondition: Object.fromEntries(this.sessionClobTradesByCondition),
            liveClobTradesFetchedAtIso: this.lastClobTradesFetchedAtIso,
            liveClobTradesError: this.lastClobTradesError,
            activeConditionId: this.cachedMarket?.conditionId ?? null,
        };
    }

    private recordEntryDecisionSnapshot(
        bestBidYes: number,
        bestBidNo: number,
        secondsLeft: number,
        windowSec: number
    ): void {
        if (!this.windowState) return;
        const decision = explainReferenceBuySide(
            this.windowState,
            bestBidYes,
            bestBidNo,
            this.roundsThisWindow,
            this.lastExecutedSide,
            this.config,
            { secondsLeft, windowSec }
        );
        const snap: EntryDecisionSnapshot = {
            timestampIso: new Date().toISOString(),
            suggestedSide: decision.side,
            reasonCode: decision.reason,
            bestBidYes,
            bestBidNo,
            imbalanceShares: decision.imbalanceShares,
            marketTilt: decision.marketTilt,
            secondsLeft,
            roundInWindow: this.roundsThisWindow + 1,
        };
        this.entryDecisionHistory.push(snap);
        const cutoff = Date.now() - 5 * 60 * 1000;
        this.entryDecisionHistory = this.entryDecisionHistory.filter(
            (x) => new Date(x.timestampIso).getTime() >= cutoff
        );
    }

    private pickDecisionAtOffset(offsetMs: number): EntryDecisionSnapshot | null {
        if (this.entryDecisionHistory.length === 0) return null;
        const targetTs = Date.now() - offsetMs;
        let best: EntryDecisionSnapshot | null = null;
        let bestDelta = Number.POSITIVE_INFINITY;
        for (const snap of this.entryDecisionHistory) {
            const ts = new Date(snap.timestampIso).getTime();
            if (!Number.isFinite(ts)) continue;
            const delta = Math.abs(ts - targetTs);
            if (delta < bestDelta) {
                best = snap;
                bestDelta = delta;
            }
        }
        return best;
    }

    private getAccountingSnapshot(state?: WindowState): {
        positionValueUsd: number;
        positionCostUsd: number;
        unrealizedPnlUsd: number;
        portfolioValueUsd: number;
        sessionPnlUsd: number;
        sessionStartPortfolioUsd: number;
    } {
        const qtyYes = state?.qtyYes ?? 0;
        const qtyNo = state?.qtyNo ?? 0;
        const positionCostUsd = (state?.costYes ?? 0) + (state?.costNo ?? 0);
        const positionValueUsd = qtyYes * this.liveBestBidYes + qtyNo * this.liveBestBidNo;
        const unrealizedPnlUsd = positionValueUsd - positionCostUsd;
        const cashUsdc = this.config.liveTrading
            ? this.cachedBalances.totalUsdc
            : getSimulatedBalance();
        const portfolioValueUsd = cashUsdc + positionValueUsd;
        if (this.sessionStartPortfolioUsd === null && portfolioValueUsd > 0) {
            this.sessionStartPortfolioUsd = portfolioValueUsd;
        }
        const baseline = this.sessionStartPortfolioUsd ?? portfolioValueUsd;
        return {
            positionValueUsd,
            positionCostUsd,
            unrealizedPnlUsd,
            portfolioValueUsd,
            sessionPnlUsd: portfolioValueUsd - baseline,
            sessionStartPortfolioUsd: baseline,
        };
    }

    /** Snapshot row for downloadable order history (Excel / JSON). */
    private recordOrderHistorySnapshot(
        market: ActiveMarket,
        stateAfter: WindowState,
        side: 'YES' | 'NO',
        shares: number,
        fillPriceRawUsd: number,
        costUsdIncludingFee: number,
        books: {
            bestBidYes: number;
            bestBidNo: number;
            bestAskYes: number;
            bestAskNo: number;
        } | null,
        reasonCode?: string
    ): void {
        const sh = Math.floor(Math.max(0, shares) + 1e-9);
        const k = this.config.binaryOutcomeTakerFeeScalar ?? 0.072;
        const margin = this.config.pairSecondLegMargin ?? 0.02;
        const allInPerShare =
            sh > 0 && costUsdIncludingFee > 0 ? costUsdIncludingFee / sh : fillPriceRawUsd;
        const feeModelUsdOnFill =
            k > 0 && sh > 0 && fillPriceRawUsd > 0 && fillPriceRawUsd < 1
                ? sh * binaryOutcomeTakerFeePerShareUsd(fillPriceRawUsd, k)
                : Math.max(0, costUsdIncludingFee - sh * fillPriceRawUsd);
        const pairSecondLegTargetBidUsd =
            k > 0 && allInPerShare > 0 && allInPerShare < 1
                ? pairOpposingLegMaxBidAfterFirst(allInPerShare, margin)
                : undefined;
        const apHist = afterPnlsFromState(stateAfter);
        pushOrderHistoryEntry({
            timestampIso: new Date().toISOString(),
            windowSlug: market.slug,
            windowEndIso: market.endDateIso,
            conditionId: market.conditionId,
            btcMarketWindowMinutes: market.btcMarketWindowMinutes,
            liveTrading: this.config.liveTrading,
            side,
            orderSizeShares: sh,
            fillPriceUsd: allInPerShare,
            fillPriceRawUsd,
            feeModelUsdOnFill,
            pairSecondLegTargetBidUsd,
            costUsd: costUsdIncludingFee,
            btcUsdWindowOpen: this.btcUsdAtWindowOpen,
            btcUsdAtOrder: this.lastBtcUsdSpot,
            upBestBidUsd: books?.bestBidYes ?? this.liveBestBidYes,
            downBestBidUsd: books?.bestBidNo ?? this.liveBestBidNo,
            upBestAskUsd: books?.bestAskYes ?? this.liveBestAskYes,
            downBestAskUsd: books?.bestAskNo ?? this.liveBestAskNo,
            afterPnlIfUpUsd: apHist.afterPnlIfUp,
            afterPnlIfDownUsd: apHist.afterPnlIfDown,
            afterPnlIfUpExcludingCommissionUsd: apHist.afterPnlIfUpExcludingCommission,
            afterPnlIfDownExcludingCommissionUsd: apHist.afterPnlIfDownExcludingCommission,
            reasonCode,
        });
    }

    /**
     * One-sided survival FOK at ask: `final` only in last finalOneSidedHedgeSeconds; `momentum` when BTC gap
     * sign crosses vs window open (one-sided inventory) — reduces blow-ups when the market runs one way.
     */
    private async tryExecuteOneSidedFokHedge(
        market: ActiveMarket,
        state: WindowState,
        secondsLeft: number,
        q: boolean,
        kind: 'final' | 'momentum'
    ): Promise<boolean> {
        const absCut = this.config.absoluteNoOrderSeconds ?? 2;
        const finalSec = this.config.finalOneSidedHedgeSeconds ?? 30;
        const tag = kind === 'momentum' ? 'MOMENTUM' : 'FINAL';

        if (kind === 'final') {
            if (secondsLeft <= absCut || secondsLeft > finalSec) return false;
        } else {
            if (secondsLeft <= absCut) return false;
            if (this.config.momentumInversionHedgeEnabled === false) return false;
            if (!this.btcMomentumSnapshot.flipDetected) return false;
        }

        const z = 1e-8;
        const oneSided =
            (state.qtyYes > z && state.qtyNo <= z) || (state.qtyNo > z && state.qtyYes <= z);
        if (!oneSided) return false;

        let bookYes: OrderBookSnapshot;
        let bookNo: OrderBookSnapshot;
        try {
            const books = await getBothOrderBooks(this.client, market, this.orderbookWs);
            bookYes = books.bookYes;
            bookNo = books.bookNo;
        } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            updateDashboardState({
                ...this.getDashboardExtras(),
                marketSlug: market.slug,
                windowEndIso: market.endDateIso,
                consecutiveFailures: this.riskState.consecutiveOrderFailures,
                pendingOrders: this.activePendingOrder ? 1 : 0,
                lastTick: new Date().toISOString(),
                message: `${tag} HEDGE: orderbook error — ${msg}`,
            });
            return true;
        }

        this.liveBestBidYes = bookYes.bestBid ?? 0;
        this.liveBestBidNo = bookNo.bestBid ?? 0;
        this.liveBestAskYes = bookYes.bestAsk ?? 0;
        this.liveBestAskNo = bookNo.bestAsk ?? 0;
        this.liveCombinedBid = this.liveBestBidYes + this.liveBestBidNo;
        this.liveCombinedAsk = this.liveBestAskYes + this.liveBestAskNo;

        const btcDelta =
            this.lastBtcUsdSpot != null && this.btcUsdAtWindowOpen !== null
                ? this.lastBtcUsdSpot - this.btcUsdAtWindowOpen
                : null;

        const d = buildFinalOneSidedHedgeDecision(
            this.config,
            state,
            bookYes,
            bookNo,
            secondsLeft,
            {
                btcUsdDeltaFromWindowOpen: btcDelta,
                bypassFinalTimeWindow: kind === 'momentum',
            }
        );
        if (d === null) return false;

        if (d.action === 'HOLD') {
            this.holdsThisWindow++;
            updateDashboardState({
                ...this.getDashboardExtras(),
                marketSlug: market.slug,
                windowEndIso: market.endDateIso,
                consecutiveFailures: this.riskState.consecutiveOrderFailures,
                pendingOrders: 0,
                lastTick: new Date().toISOString(),
                message: `${tag} HEDGE: ${d.reason}`,
            });
            return true;
        }

        const side = d.action === 'BUY_YES' ? ('YES' as const) : ('NO' as const);
        const sideLabel = side === 'YES' ? 'Up' : 'Down';
        const ts = this.config.tickSize || 0.01;
        const limitPx = Math.min(0.99, Math.round((d.price + ts) * 100) / 100);
        const orderCost = limitPx * d.size;
        const reasonCode = kind === 'momentum' ? 'MOMENTUM_FLIP_HEDGE' : 'FINAL_ONE_SIDED_HEDGE';

        const roundNum = this.roundsThisWindow + 1;
        const tokenId = side === 'YES' ? market.yesTokenId : market.noTokenId;
        qlog(
            q,
            `[${tag} hedge #${roundNum}] ${sideLabel} ${d.size}sh @ ask ~$${d.price.toFixed(2)} ($${orderCost.toFixed(2)}) | ${secondsLeft}s left`
        );

        const bookSnap = {
            bestBidYes: bookYes.bestBid ?? 0,
            bestBidNo: bookNo.bestBid ?? 0,
            bestAskYes: bookYes.bestAsk ?? 0,
            bestAskNo: bookNo.bestAsk ?? 0,
        };

        let oneSidedInstant: OrderResult | undefined;
        if (this.config.liveTrading) {
            await this.refreshLiveInventoryFromChain(market, q);
            oneSidedInstant = await buyInstant(
                this.client,
                tokenId,
                d.price,
                d.size,
                this.config,
                !!market.negRisk,
                { marketConditionId: market.conditionId }
            );
            if (
                !oneSidedInstant.success ||
                !oneSidedInstant.orderId ||
                oneSidedInstant.orderId === 'unknown'
            ) {
                this.riskState = recordOrderFailure(this.riskState);
                console.error(`[Bot] ${tag} hedge ${sideLabel} failed: ${oneSidedInstant.error}`);
                return false;
            }
        }

        const acct1 = this.resolveLiveFokAccounting(this.config.liveTrading, oneSidedInstant, {
            shares: d.size,
            price: limitPx,
            costUsd: orderCost,
        });
        await this.applyBuyFillAccountingUnified(
            market,
            this.config.liveTrading ? this.windowState! : state,
            side,
            acct1.shares,
            acct1.price,
            acct1.costUsd,
            bookSnap,
            reasonCode,
            'tick',
            (ws) =>
                `${tag} hedge: ${sideLabel} ${acct1.shares}@$${acct1.price.toFixed(4)} | pairCost=$${ws.pairCost.toFixed(4)} | Up=${ws.qtyYes} Down=${ws.qtyNo}`,
            q,
            { liquidity: 'TAKER' }
        );

        const wsOut = this.windowState!;
        const label = kind === 'momentum' ? 'Momentum flip hedge' : 'Final hedge';
        updateDashboardState({
            ...this.getDashboardExtras(),
            marketSlug: market.slug,
            windowEndIso: market.endDateIso,
            consecutiveFailures: this.riskState.consecutiveOrderFailures,
            pendingOrders: this.activePendingOrder ? 1 : 0,
            lastTick: new Date().toISOString(),
            message:
                `${label}: ${sideLabel} ${acct1.shares}@ask ~$${d.price.toFixed(2)} | ` +
                `Up=${wsOut.qtyYes} Down=${wsOut.qtyNo} | ${secondsLeft}s left`,
        });
        this.options.onStateChange?.(wsOut, this.riskState);
        return true;
    }

    /**
     * When both legs are held and both settlement After PnLs exceed the aggressive threshold (default $0.70),
     * FOK-buy the opposing (undersized) leg immediately — same gates as main path (`clampBuySizeForSimulatedGates`).
     * Runs in paper and live identically (instant fill accounting).
     */
    private async tryExecuteAggressiveDualPnlHedge(
        market: ActiveMarket,
        state: WindowState,
        secondsLeft: number,
        books: { bookYes: OrderBookSnapshot; bookNo: OrderBookSnapshot },
        q: boolean
    ): Promise<boolean> {
        const cfg = this.config;
        if (cfg.aggressiveDualPnlHedgeEnabled !== true) return false;

        const minRounds = Math.max(0, Math.floor(cfg.aggressiveDualPnlHedgeMinRoundsInWindow ?? 1));
        if (this.roundsThisWindow < minRounds) return false;

        const thr = cfg.aggressiveDualPnlHedgeMinAfterPnlUsd ?? 0.7;
        const z = 1e-8;
        if (state.qtyYes <= z || state.qtyNo <= z) return false;

        // Pair ladder: matched qty — next trade must be Stock A (maker / pair-cost rules), not this FOK path
        // which forces dual After-PnL enforcement meant for Stock B hedges.
        if (cfg.pairLadderMatchEnabled === true && this.pairQtyImbalanceShares(state) === 0) {
            return false;
        }

        const ap = afterPnlsFromState(state);
        if (
            ap.afterPnlIfUpExcludingCommission <= thr ||
            ap.afterPnlIfDownExcludingCommission <= thr
        )
            return false;

        const askYes = books.bookYes.bestAsk ?? 0;
        const askNo = books.bookNo.bestAsk ?? 0;
        if (askYes <= 0 || askNo <= 0) return false;

        let side: 'YES' | 'NO';
        if (state.qtyYes < state.qtyNo - z) {
            side = 'YES';
        } else if (state.qtyNo < state.qtyYes - z) {
            side = 'NO';
        } else {
            side =
                ap.afterPnlIfUpExcludingCommission <= ap.afterPnlIfDownExcludingCommission
                    ? 'YES'
                    : 'NO';
        }

        const askPx = side === 'YES' ? askYes : askNo;
        const ts = cfg.tickSize || 0.01;
        const tokenId = side === 'YES' ? market.yesTokenId : market.noTokenId;
        const sideLabel = side === 'YES' ? 'Up' : 'Down';

        const maxClip = Math.floor(cfg.maxClipShares ?? 1000);
        const maxSingle = cfg.maxSingleOrderUsd ?? 1000;
        const maxPos = cfg.maxPositionPerWindowUsd ?? 0;
        const headroomUsd = maxPos > 0 ? Math.max(0, maxPos - state.totalSpentUsd) : maxSingle * 10;
        const bal = cfg.liveTrading ? this.cachedBalances.polymarketUsdc : getSimulatedBalance();
        let raw = Math.min(
            maxClip,
            Math.floor(maxSingle / askPx),
            Math.floor(headroomUsd / askPx),
            Math.floor(Math.max(0, bal - 0.25) / askPx)
        );
        const minSz = Math.max(market.orderMinSize || 0, cfg.orderMinSize || 1);
        raw = Math.max(raw, minSz);

        let shares = clampBuySizeForSimulatedGates(state, side, askPx, raw, cfg, {
            forceDualAfterPnlEnforcement: true,
            simulatedFillLiquidity: 'TAKER',
        });
        if (shares <= 0) return false;

        const limitPx = Math.min(0.99, Math.round((askPx + ts) * 100) / 100);
        const orderCost = limitPx * shares;
        if (orderCost < 1.0) return false;

        if (this.cachedBalances.polymarketUsdc < orderCost + 0.25) return false;

        const riskCheck = canPlaceOrder(this.config, this.riskState, state, orderCost);
        if (!riskCheck.allowed) return false;

        const reasonCode = 'AGGRESSIVE_DUAL_PNL_HEDGE';

        qlog(
            q,
            `[Aggressive dual PnL #${this.roundsThisWindow + 1}] ${sideLabel} ${shares}sh @ ask ~$${askPx.toFixed(2)} ($${orderCost.toFixed(2)}) | ` +
                `both After PnL > $${thr.toFixed(2)} | ${secondsLeft}s left`
        );

        const bookSnap = {
            bestBidYes: books.bookYes.bestBid ?? 0,
            bestBidNo: books.bookNo.bestBid ?? 0,
            bestAskYes: askYes,
            bestAskNo: askNo,
        };

        let aggressiveInstant: OrderResult | undefined;
        if (cfg.liveTrading) {
            await this.refreshLiveInventoryFromChain(market, q);
            aggressiveInstant = await buyInstant(
                this.client,
                tokenId,
                askPx,
                shares,
                this.config,
                !!market.negRisk,
                { marketConditionId: market.conditionId }
            );
            if (
                !aggressiveInstant.success ||
                !aggressiveInstant.orderId ||
                aggressiveInstant.orderId === 'unknown'
            ) {
                this.riskState = recordOrderFailure(this.riskState);
                console.error(`[Bot] Aggressive dual PnL hedge failed: ${aggressiveInstant.error}`);
                return false;
            }
        }

        const acctAgg = this.resolveLiveFokAccounting(cfg.liveTrading, aggressiveInstant, {
            shares,
            price: limitPx,
            costUsd: orderCost,
        });
        await this.applyBuyFillAccountingUnified(
            market,
            cfg.liveTrading ? this.windowState! : state,
            side,
            acctAgg.shares,
            acctAgg.price,
            acctAgg.costUsd,
            bookSnap,
            reasonCode,
            'tick',
            (ws) =>
                `Aggressive dual PnL: ${sideLabel} ${acctAgg.shares}sh @ ~$${acctAgg.price.toFixed(4)} | Up=${ws.qtyYes} Down=${ws.qtyNo} pairCost=${ws.pairCost.toFixed(4)}`,
            q,
            { liquidity: 'TAKER' }
        );

        const wsOut = this.windowState!;
        updateDashboardState({
            ...this.getDashboardExtras(),
            marketSlug: market.slug,
            windowEndIso: market.endDateIso,
            consecutiveFailures: this.riskState.consecutiveOrderFailures,
            pendingOrders: this.activePendingOrder ? 1 : 0,
            lastTick: new Date().toISOString(),
            message:
                `AGGRESSIVE HEDGE: both After PnL > $${thr.toFixed(2)} — ${sideLabel} +${acctAgg.shares} @ ~$${askPx.toFixed(2)} | ${secondsLeft}s left`,
        });
        this.options.onStateChange?.(wsOut, this.riskState);
        return true;
    }

    /**
     * 5m only, last `finalOneSidedHedgeSeconds`, one-sided: FOK @ ask on gap-predicted *missing* outcome until that
     * outcome's After PnL reaches `minDualAfterPnlUsd`. If BTC gap favors the leg you already hold, or gap is
     * neutral / missing, returns false so legacy opposite-leg FOK hedges can run the same tick.
     */
    private async tryExecuteFinalOneSidedMomentumTarget(
        market: ActiveMarket,
        state: WindowState,
        secondsLeft: number,
        q: boolean
    ): Promise<boolean> {
        const cfg = this.config;
        if (cfg.finalOneSidedMomentumTargetEnabled === false) return false;
        if (market.btcMarketWindowMinutes !== 5) return false;
        const absCut = cfg.absoluteNoOrderSeconds ?? 2;
        const finalSec = cfg.finalOneSidedHedgeSeconds ?? 30;
        if (secondsLeft <= absCut || secondsLeft > finalSec) return false;

        const z = 1e-8;
        const oneSided =
            (state.qtyYes > z && state.qtyNo <= z) || (state.qtyNo > z && state.qtyYes <= z);
        if (!oneSided) return false;

        let bookYes: OrderBookSnapshot;
        let bookNo: OrderBookSnapshot;
        try {
            const books = await getBothOrderBooks(this.client, market, this.orderbookWs);
            bookYes = books.bookYes;
            bookNo = books.bookNo;
        } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            updateDashboardState({
                ...this.getDashboardExtras(),
                marketSlug: market.slug,
                windowEndIso: market.endDateIso,
                consecutiveFailures: this.riskState.consecutiveOrderFailures,
                pendingOrders: this.activePendingOrder ? 1 : 0,
                lastTick: new Date().toISOString(),
                message: `FINAL30 MOMENTUM: orderbook error — ${msg}`,
            });
            return false;
        }

        this.liveBestBidYes = bookYes.bestBid ?? 0;
        this.liveBestBidNo = bookNo.bestBid ?? 0;
        this.liveBestAskYes = bookYes.bestAsk ?? 0;
        this.liveBestAskNo = bookNo.bestAsk ?? 0;
        this.liveCombinedBid = this.liveBestBidYes + this.liveBestBidNo;
        this.liveCombinedAsk = this.liveBestAskYes + this.liveBestAskNo;

        const btcDelta =
            this.lastBtcUsdSpot != null && this.btcUsdAtWindowOpen !== null
                ? this.lastBtcUsdSpot - this.btcUsdAtWindowOpen
                : null;

        const favorDown = cfg.finalOneSidedMomentumFavorDownGapUsd ?? -15;
        const favorUp = cfg.finalOneSidedMomentumFavorUpGapUsd ?? 15;

        if (btcDelta === null || !Number.isFinite(btcDelta)) {
            return false;
        }

        const preferred = momentumGapPreferredOutcomeSide(state, btcDelta, favorDown, favorUp);
        if (preferred === null) {
            return false;
        }

        const longUpOnly = state.qtyYes > z && state.qtyNo <= z;
        const longDownOnly = state.qtyNo > z && state.qtyYes <= z;
        if ((longUpOnly && preferred === 'YES') || (longDownOnly && preferred === 'NO')) {
            return false;
        }

        const minD = minDualAfterPnlUsd(cfg);
        const strictA = minDualAfterPnlStrictAbove(cfg);
        const ap = afterPnlsFromState(state);
        const favorAfter =
            preferred === 'YES' ? ap.afterPnlIfUp : ap.afterPnlIfDown;
        const eps = 1e-6;
        if (
            cfg.unrestrictedPredictionBuys !== true &&
            (strictA ? favorAfter > minD : favorAfter >= minD - eps)
        ) {
            updateDashboardState({
                ...this.getDashboardExtras(),
                marketSlug: market.slug,
                windowEndIso: market.endDateIso,
                consecutiveFailures: this.riskState.consecutiveOrderFailures,
                pendingOrders: this.activePendingOrder ? 1 : 0,
                lastTick: new Date().toISOString(),
                message:
                    `FINAL30 MOMENTUM: ${preferred === 'YES' ? 'Up' : 'Down'} After PnL $${favorAfter.toFixed(2)} ≥ target — deferring to other paths`,
            });
            return false;
        }

        const dPrice = preferred === 'YES' ? bookYes.bestAsk ?? 0 : bookNo.bestAsk ?? 0;
        if (dPrice <= 0 || dPrice >= 1) {
            updateDashboardState({
                ...this.getDashboardExtras(),
                marketSlug: market.slug,
                windowEndIso: market.endDateIso,
                consecutiveFailures: this.riskState.consecutiveOrderFailures,
                pendingOrders: this.activePendingOrder ? 1 : 0,
                lastTick: new Date().toISOString(),
                message: `FINAL30 MOMENTUM: no ask for ${preferred === 'YES' ? 'Up' : 'Down'} — wait`,
            });
            return false;
        }

        let shares = sharesToReachOutcomeAfterPnlTarget(
            state,
            preferred,
            dPrice,
            minD,
            strictA
        );
        const maxChunk = cfg.finalOneSidedMomentumMaxChunkShares ?? 2000;
        shares = Math.min(shares, maxChunk);
        const ts = cfg.tickSize || 0.01;
        const limitPx = Math.min(0.99, Math.round((dPrice + ts) * 100) / 100);
        const maxOrder = cfg.maxSingleOrderUsd ?? 15;
        const maxByUsd = Math.floor(maxOrder / limitPx);
        if (maxByUsd > 0) shares = Math.min(shares, maxByUsd);
        if (shares <= 0 && cfg.unrestrictedPredictionBuys === true) {
            const minSz = Math.max(1, Math.floor(cfg.orderMinSize || 1));
            const probe = Math.max(minSz, Math.floor(cfg.initialEntryShares ?? minSz));
            shares = Math.min(maxChunk, maxByUsd > 0 ? Math.min(probe, maxByUsd) : probe);
        }
        if (shares <= 0) {
            updateDashboardState({
                ...this.getDashboardExtras(),
                marketSlug: market.slug,
                windowEndIso: market.endDateIso,
                consecutiveFailures: this.riskState.consecutiveOrderFailures,
                pendingOrders: this.activePendingOrder ? 1 : 0,
                lastTick: new Date().toISOString(),
                message: 'FINAL30 MOMENTUM: clip 0 or over cap — wait',
            });
            return false;
        }

        let orderCost = limitPx * shares;
        if (orderCost < 1.0) {
            updateDashboardState({
                ...this.getDashboardExtras(),
                marketSlug: market.slug,
                windowEndIso: market.endDateIso,
                consecutiveFailures: this.riskState.consecutiveOrderFailures,
                pendingOrders: this.activePendingOrder ? 1 : 0,
                lastTick: new Date().toISOString(),
                message: `FINAL30 MOMENTUM: order $${orderCost.toFixed(2)} < $1 CLOB min — wait`,
            });
            return false;
        }

        if (this.cachedBalances.polymarketUsdc < orderCost + 0.25) {
            updateDashboardState({
                ...this.getDashboardExtras(),
                marketSlug: market.slug,
                windowEndIso: market.endDateIso,
                consecutiveFailures: this.riskState.consecutiveOrderFailures,
                pendingOrders: this.activePendingOrder ? 1 : 0,
                lastTick: new Date().toISOString(),
                message: `FINAL30 MOMENTUM: insufficient balance for $${orderCost.toFixed(2)} — wait`,
            });
            return false;
        }

        const riskCheck = canPlaceOrder(cfg, this.riskState, state, orderCost);
        if (!riskCheck.allowed) {
            updateDashboardState({
                ...this.getDashboardExtras(),
                marketSlug: market.slug,
                windowEndIso: market.endDateIso,
                consecutiveFailures: this.riskState.consecutiveOrderFailures,
                pendingOrders: this.activePendingOrder ? 1 : 0,
                lastTick: new Date().toISOString(),
                message: `FINAL30 MOMENTUM: RISK — ${riskCheck.reason}`,
            });
            return false;
        }

        const side = preferred;
        const sideLabel = side === 'YES' ? 'Up' : 'Down';
        const roundNum = this.roundsThisWindow + 1;
        const tokenId = side === 'YES' ? market.yesTokenId : market.noTokenId;
        const reasonCode = `FINAL30_MOMENTUM_GAP|gap=${btcDelta.toFixed(1)}|${side}`;

        qlog(
            q,
            `[FINAL30 momentum #${roundNum}] ${sideLabel} ${shares}sh @ ask ~$${dPrice.toFixed(2)} ($${orderCost.toFixed(2)}) | ${secondsLeft}s left`
        );

        const bookSnap = {
            bestBidYes: bookYes.bestBid ?? 0,
            bestBidNo: bookNo.bestBid ?? 0,
            bestAskYes: bookYes.bestAsk ?? 0,
            bestAskNo: bookNo.bestAsk ?? 0,
        };

        let final30Instant: OrderResult | undefined;
        if (cfg.liveTrading) {
            await this.refreshLiveInventoryFromChain(market, q);
            final30Instant = await buyInstant(
                this.client,
                tokenId,
                dPrice,
                shares,
                cfg,
                !!market.negRisk,
                { marketConditionId: market.conditionId }
            );
            if (
                !final30Instant.success ||
                !final30Instant.orderId ||
                final30Instant.orderId === 'unknown'
            ) {
                this.riskState = recordOrderFailure(this.riskState);
                console.error(`[Bot] FINAL30 momentum ${sideLabel} failed: ${final30Instant.error}`);
                return false;
            }
        }

        const acctF30 = this.resolveLiveFokAccounting(cfg.liveTrading, final30Instant, {
            shares,
            price: limitPx,
            costUsd: orderCost,
        });
        await this.applyBuyFillAccountingUnified(
            market,
            cfg.liveTrading ? this.windowState! : state,
            side,
            acctF30.shares,
            acctF30.price,
            acctF30.costUsd,
            bookSnap,
            reasonCode,
            'tick',
            (ws) =>
                `FINAL30 momentum: ${sideLabel} ${acctF30.shares}@$${acctF30.price.toFixed(4)} | pairCost=$${ws.pairCost.toFixed(4)} | Up=${ws.qtyYes} Down=${ws.qtyNo}`,
            q,
            { liquidity: 'TAKER' }
        );

        const wsOut = this.windowState!;
        updateDashboardState({
            ...this.getDashboardExtras(),
            marketSlug: market.slug,
            windowEndIso: market.endDateIso,
            consecutiveFailures: this.riskState.consecutiveOrderFailures,
            pendingOrders: this.activePendingOrder ? 1 : 0,
            lastTick: new Date().toISOString(),
            message:
                `FINAL30 momentum: ${sideLabel} ${acctF30.shares}@ask ~$${dPrice.toFixed(2)} | ` +
                `Up=${wsOut.qtyYes} Down=${wsOut.qtyNo} | ${secondsLeft}s left`,
        });
        this.options.onStateChange?.(wsOut, this.riskState);
        return true;
    }

    /** Ceiling for implied pair (held avg + opposite ask); null = feature off. */
    private immediateImpliedPairCostCeiling(): number | null {
        const cfg = this.config;
        if (cfg.immediateImpliedPairCostHedgeEnabled === false) return null;
        const m = cfg.immediateOppositePairCostMax;
        if (m != null && m > 0 && m < 1) return m;
        return pairCostCeiling(cfg);
    }

    /**
     * Strictly one-sided: if held-leg average fill + opposite best ask ≤ ceiling (default 0.98),
     * FOK-buy the opposite for the full imbalance so the hedge cannot stall on maker bids or final-window waits.
     */
    private async tryExecuteImmediateImpliedPairCostHedge(
        market: ActiveMarket,
        state: WindowState,
        secondsLeft: number,
        books: { bookYes: OrderBookSnapshot; bookNo: OrderBookSnapshot },
        q: boolean
    ): Promise<boolean> {
        const absCut = this.config.absoluteNoOrderSeconds ?? 2;
        if (secondsLeft <= absCut) return false;
        if (this.activePendingOrder) return false;

        const ceiling = this.immediateImpliedPairCostCeiling();
        if (ceiling == null || ceiling <= 0 || ceiling >= 1) return false;

        const z = 1e-8;
        let hedgeSide: 'YES' | 'NO';
        let heldAvg: number;
        let askPx: number;
        let imbShares: number;

        if (state.qtyYes > z && state.qtyNo <= z) {
            hedgeSide = 'NO';
            heldAvg = state.avgYes;
            askPx = books.bookNo.bestAsk ?? 0;
            imbShares = Math.floor(state.qtyYes);
        } else if (state.qtyNo > z && state.qtyYes <= z) {
            hedgeSide = 'YES';
            heldAvg = state.avgNo;
            askPx = books.bookYes.bestAsk ?? 0;
            imbShares = Math.floor(state.qtyNo);
        } else {
            return false;
        }

        if (imbShares < 1 || askPx <= 0 || !Number.isFinite(heldAvg) || heldAvg <= 0) return false;

        const kImm = this.config.binaryOutcomeTakerFeeScalar ?? 0.072;
        const oppEffPerShare = buyBinaryOutcomeLegUsd(
            1,
            askPx,
            'TAKER',
            this.config.feeBips ?? 0,
            kImm
        );
        const impliedPair = heldAvg + oppEffPerShare;
        if (impliedPair > ceiling + 1e-9) return false;

        const minSz = Math.max(market.orderMinSize || 0, this.config.orderMinSize || 1);
        const byImm = books.bookYes.bestBid ?? 0;
        const bnImm = books.bookNo.bestBid ?? 0;
        const { lo: plImmLo } = this.pairStockARandomClipBounds(market, byImm, bnImm);
        const targetImb =
            this.config.pairLadderMatchEnabled === true ? Math.max(imbShares, plImmLo) : imbShares;
        let shares = clampBuySizeForSimulatedGates(state, hedgeSide, askPx, targetImb, this.config, {
            simulatedFillLiquidity: 'TAKER',
        });
        if (shares < minSz) return false;
        if (shares !== targetImb) return false;

        const ts = this.config.tickSize || 0.01;
        const limitPx = Math.min(0.99, Math.round((askPx + ts) * 100) / 100);
        const orderCost = limitPx * shares;
        if (orderCost < 1.0) return false;

        const maxPos = this.config.maxPositionPerWindowUsd ?? 0;
        if (maxPos > 0 && state.totalSpentUsd + orderCost > maxPos + 1e-6) return false;

        if (this.cachedBalances.polymarketUsdc < orderCost + 0.25) return false;

        const maxOrder = this.config.maxSingleOrderUsd ?? Number.POSITIVE_INFINITY;
        if (Number.isFinite(maxOrder) && maxOrder > 0 && orderCost > maxOrder + 1e-6) return false;

        const riskCheck = canPlaceOrder(this.config, this.riskState, state, orderCost);
        if (!riskCheck.allowed) return false;

        const sideLabel = hedgeSide === 'YES' ? 'Up' : 'Down';
        const tokenId = hedgeSide === 'YES' ? market.yesTokenId : market.noTokenId;
        const reasonCode =
            `IMMEDIATE_IMPLIED_PAIR|ceiling=${ceiling.toFixed(4)}|implied=${impliedPair.toFixed(4)}`;

        const roundNum = this.roundsThisWindow + 1;
        qlog(
            q,
            `[Implied pair hedge #${roundNum}] ${sideLabel} ${shares}sh @ ask ~$${askPx.toFixed(2)} ($${orderCost.toFixed(2)}) | implied pair ${impliedPair.toFixed(4)}`
        );

        const bookSnap = {
            bestBidYes: books.bookYes.bestBid ?? 0,
            bestBidNo: books.bookNo.bestBid ?? 0,
            bestAskYes: books.bookYes.bestAsk ?? 0,
            bestAskNo: books.bookNo.bestAsk ?? 0,
        };

        let impliedInstant: OrderResult | undefined;
        if (this.config.liveTrading) {
            await this.refreshLiveInventoryFromChain(market, q);
            impliedInstant = await buyInstant(
                this.client,
                tokenId,
                askPx,
                shares,
                this.config,
                !!market.negRisk,
                { marketConditionId: market.conditionId }
            );
            if (
                !impliedInstant.success ||
                !impliedInstant.orderId ||
                impliedInstant.orderId === 'unknown'
            ) {
                this.riskState = recordOrderFailure(this.riskState);
                console.error(`[Bot] Implied pair hedge ${sideLabel} failed: ${impliedInstant.error}`);
                return false;
            }
        }

        const acctImpl = this.resolveLiveFokAccounting(this.config.liveTrading, impliedInstant, {
            shares,
            price: limitPx,
            costUsd: orderCost,
        });
        await this.applyBuyFillAccountingUnified(
            market,
            this.config.liveTrading ? this.windowState! : state,
            hedgeSide,
            acctImpl.shares,
            acctImpl.price,
            acctImpl.costUsd,
            bookSnap,
            reasonCode,
            'tick',
            (ws) =>
                `Implied pair hedge: ${sideLabel} ${acctImpl.shares}@$${acctImpl.price.toFixed(4)} | pairCost=${ws.pairCost.toFixed(4)} | Up=${ws.qtyYes} Down=${ws.qtyNo}`,
            q,
            { liquidity: 'TAKER' }
        );

        const wsOut = this.windowState!;
        updateDashboardState({
            ...this.getDashboardExtras(),
            marketSlug: market.slug,
            windowEndIso: market.endDateIso,
            consecutiveFailures: this.riskState.consecutiveOrderFailures,
            pendingOrders: this.activePendingOrder ? 1 : 0,
            lastTick: new Date().toISOString(),
            message:
                `IMPLIED PAIR ≤ $${ceiling.toFixed(2)}: ${sideLabel} +${acctImpl.shares} @ ~$${askPx.toFixed(2)} | ` +
                `Up=${wsOut.qtyYes} Down=${wsOut.qtyNo} | pairCost=${wsOut.pairCost.toFixed(4)}`,
        });
        this.options.onStateChange?.(wsOut, this.riskState);
        return true;
    }

    /**
     * Long Up only: if Down best ask is rising (orderbook momentum) and current or extrapolated Down ask
     * stays above a floor, FOK-buy Down (imbalance + extra) before finalOneSidedHedgeSeconds.
     * Uses Down-ask samples (not BTC gap). Does not modify other strategy paths — runs only when enabled.
     */
    private async tryExecuteEarlyDownAskMomentumHedge(
        market: ActiveMarket,
        state: WindowState,
        secondsLeft: number,
        q: boolean
    ): Promise<boolean> {
        const cfg = this.config;
        if (!cfg.earlyDownMomentumHedgeEnabled) {
            return false;
        }

        const z = 1e-8;
        const longYesOnly = state.qtyYes > z && state.qtyNo <= z;
        if (!longYesOnly) {
            return false;
        }

        const finalSec = cfg.finalOneSidedHedgeSeconds ?? 30;
        const absCut = cfg.absoluteNoOrderSeconds ?? 2;
        if (secondsLeft <= absCut || secondsLeft <= finalSec) {
            return false;
        }

        if (this.activePendingOrder) {
            return false;
        }

        const nowMs = Date.now();
        const cooldown = cfg.earlyDownMomentumCooldownMs ?? 45_000;
        if (nowMs - this.lastEarlyDownMomentumHedgeAt < cooldown) {
            return false;
        }

        let bookYes: OrderBookSnapshot;
        let bookNo: OrderBookSnapshot;
        try {
            const books = await getBothOrderBooks(this.client, market, this.orderbookWs);
            bookYes = books.bookYes;
            bookNo = books.bookNo;
        } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            updateDashboardState({
                ...this.getDashboardExtras(),
                marketSlug: market.slug,
                windowEndIso: market.endDateIso,
                consecutiveFailures: this.riskState.consecutiveOrderFailures,
                pendingOrders: 0,
                lastTick: new Date().toISOString(),
                message: `EARLY DOWN MOMENTUM: orderbook error — ${msg}`,
            });
            return true;
        }

        this.liveBestBidYes = bookYes.bestBid ?? 0;
        this.liveBestBidNo = bookNo.bestBid ?? 0;
        this.liveBestAskYes = bookYes.bestAsk ?? 0;
        this.liveBestAskNo = bookNo.bestAsk ?? 0;
        this.liveCombinedBid = this.liveBestBidYes + this.liveBestBidNo;
        this.liveCombinedAsk = this.liveBestAskYes + this.liveBestAskNo;

        const noAsk = bookNo.bestAsk ?? 0;
        if (noAsk <= 0) {
            this.downAskMomentumUsdPerSecDisplay = null;
            this.downAskPredictedAtWindowEndUsdDisplay = null;
            return false;
        }

        this.noAskMomentumSamples.push({ t: nowMs, ask: noAsk });
        this.noAskMomentumSamples = pruneNoAskSamples(
            this.noAskMomentumSamples,
            DEFAULT_NO_ASK_SAMPLE_MAX_AGE_MS,
            nowMs
        );

        const vel = downAskVelocityUsdPerSec(this.noAskMomentumSamples, 2);
        this.downAskMomentumUsdPerSecDisplay = vel;
        const predEnd = extrapolateDownAskToWindowEnd(noAsk, vel, secondsLeft);
        this.downAskPredictedAtWindowEndUsdDisplay = predEnd;

        if (vel == null || !Number.isFinite(vel)) {
            return false;
        }

        const minVel = cfg.earlyDownMomentumMinRisingVelocity ?? 0;
        if (vel <= minVel) {
            return false;
        }

        const floorPx = cfg.earlyDownMomentumAskFloorUsd ?? 0.43;
        const okFloor =
            noAsk >= floorPx - 1e-6 || (predEnd != null && Number.isFinite(predEnd) && predEnd >= floorPx - 1e-6);
        if (!okFloor) {
            return false;
        }

        const imb = Math.floor(state.qtyYes - state.qtyNo);
        const extra = Math.max(0, Math.floor(cfg.earlyDownMomentumExtraShares ?? 0));
        const minSz = Math.max(market.orderMinSize ?? 0, cfg.orderMinSize ?? 1);
        let shares = Math.max(imb + extra, minSz);

        const maxSingle = cfg.maxSingleOrderUsd ?? 300;
        const maxByUsd = noAsk > 0 ? Math.floor(maxSingle / noAsk) : 0;
        shares = Math.min(shares, maxByUsd);

        const minD = minDualAfterPnlUsd(cfg);
        const strictP = minDualAfterPnlStrictAbove(cfg);
        const pairCeilEarly = pairCostCeiling(cfg);
        while (shares >= minSz) {
            const { newState } = projectedAfterPnlsAfterBuy(state, 'NO', shares, noAsk, cfg, 'TAKER');
            const apEarly = afterPnlsFromState(newState);
            if (
                newState.qtyYes > 0 &&
                newState.qtyNo > 0 &&
                dualAfterPnlMeetsMin(
                    apEarly.afterPnlIfUpExcludingCommission,
                    apEarly.afterPnlIfDownExcludingCommission,
                    minD,
                    strictP
                ) &&
                newState.pairCost <= pairCeilEarly + 1e-9 &&
                newState.pairCost < 1.0 - 1e-9
            ) {
                break;
            }
            shares--;
        }

        if (shares < minSz) {
            return false;
        }

        const ts = cfg.tickSize || 0.01;
        const limitPx = Math.min(0.99, Math.round((noAsk + ts) * 100) / 100);
        const orderCost = limitPx * shares;
        if (orderCost < 1.0) {
            return false;
        }

        if (this.cachedBalances.polymarketUsdc < orderCost + 0.25) {
            return false;
        }

        const riskCheck = canPlaceOrder(this.config, this.riskState, state, orderCost);
        if (!riskCheck.allowed) {
            return false;
        }

        const side = 'NO' as const;
        const sideLabel = 'Down';
        const tokenId = market.noTokenId;
        const reasonCode = `EARLY_DOWN_ASK_MOMENTUM|floor=${floorPx}|v=${vel.toFixed(4)}/s|predEnd=${predEnd != null ? predEnd.toFixed(3) : 'n/a'}`;

        qlog(
            q,
            `[EARLY DOWN momentum #${this.roundsThisWindow + 1}] ${sideLabel} ${shares}sh @ ask ~$${noAsk.toFixed(2)} ($${orderCost.toFixed(2)}) | ` +
                `${secondsLeft}s left (before final ${finalSec}s)`
        );

        const bookSnap = {
            bestBidYes: bookYes.bestBid ?? 0,
            bestBidNo: bookNo.bestBid ?? 0,
            bestAskYes: bookYes.bestAsk ?? 0,
            bestAskNo: bookNo.bestAsk ?? 0,
        };

        let earlyDownInstant: OrderResult | undefined;
        if (this.config.liveTrading) {
            await this.refreshLiveInventoryFromChain(market, q);
            earlyDownInstant = await buyInstant(
                this.client,
                tokenId,
                noAsk,
                shares,
                this.config,
                !!market.negRisk,
                { marketConditionId: market.conditionId }
            );
            if (
                !earlyDownInstant.success ||
                !earlyDownInstant.orderId ||
                earlyDownInstant.orderId === 'unknown'
            ) {
                this.riskState = recordOrderFailure(this.riskState);
                console.error(`[Bot] Early Down momentum hedge failed: ${earlyDownInstant.error}`);
                return false;
            }
        }

        const acctEarly = this.resolveLiveFokAccounting(this.config.liveTrading, earlyDownInstant, {
            shares,
            price: limitPx,
            costUsd: orderCost,
        });
        await this.applyBuyFillAccountingUnified(
            market,
            this.config.liveTrading ? this.windowState! : state,
            side,
            acctEarly.shares,
            acctEarly.price,
            acctEarly.costUsd,
            bookSnap,
            reasonCode,
            'tick',
            (ws) =>
                `EARLY Down momentum: ${acctEarly.shares}@$${acctEarly.price.toFixed(4)} | Up=${ws.qtyYes} Down=${ws.qtyNo}`,
            q,
            { liquidity: 'TAKER' }
        );
        this.lastEarlyDownMomentumHedgeAt = nowMs;

        const wsOut = this.windowState!;
        updateDashboardState({
            ...this.getDashboardExtras(),
            marketSlug: market.slug,
            windowEndIso: market.endDateIso,
            consecutiveFailures: this.riskState.consecutiveOrderFailures,
            pendingOrders: this.activePendingOrder ? 1 : 0,
            lastTick: new Date().toISOString(),
            message:
                `Early Down momentum (ask rising): ${sideLabel} ${shares}@~$${noAsk.toFixed(2)} | ${secondsLeft}s left | ` +
                `v=${vel.toFixed(3)} $/s · floor $${floorPx.toFixed(2)}`,
        });
        this.options.onStateChange?.(wsOut, this.riskState);
        return true;
    }

    // ─── Tick wrapper ────────────────────────────────────────────────────

    private async tick(): Promise<void> {
        if (this.tickRunning) return;
        this.tickRunning = true;
        try {
            await this.executeTick();
        } catch (err) {
            console.error('[Bot] tick error:', err);
        } finally {
            this.tickRunning = false;
        }
    }

    private async executeTick(): Promise<void> {
        const dash = getDashboardState();
        this.riskState = setKillSwitch(this.riskState, dash.killSwitch);
        const q = !!this.config.quietConsole;

        if (this.manualBuyInProgress) return;

        await this.maybeReconcileUnknownWindowSettlement();

        if (this.config.liveTrading) {
            await this.fetchBalance();
        } else {
            this.cachedBalances = {
                publicWalletUsdc: 0,
                polymarketUsdc: getSimulatedBalance(),
                totalUsdc: getSimulatedBalance(),
            };
            this.balanceLastCheckedIso = new Date().toISOString();
        }

        const market = await this.getMarket();
        if (!market) {
            updateDashboardState({
                ...this.getDashboardExtras(),
                marketSlug: null,
                windowEndIso: null,
                pendingOrders: 0,
                message:
                    'No active BTC Up/Down market found (check btcMarketWindowMinutes). Retrying...',
                lastTick: new Date().toISOString(),
            });
            return;
        }

        // ── Detect new window ────────────────────────────────────────────
        const isNewWindow =
            this.lastMarketSlug !== market.slug || this.lastWindowEnd !== market.endDateIso;
        if (isNewWindow) {
            if (this.windowState && this.windowState.totalSpentUsd > 0) {
                if (this.config.liveTrading) {
                    await this.finalizeLiveWindowInventoryForClosedWindow(q);
                }
                await this.logWindowEndSummary(this.windowState);
            } else if (this.windowState) {
                this.lastCompletedWindowNetProfitUsd = 0;
            }
            if (this.config.liveTrading && this.activePendingOrder) {
                try {
                    await this.client.cancelOrder({ orderID: this.activePendingOrder.orderId });
                } catch {}
                this.activePendingOrder = null;
            }
            this.paperSimulatedMakerOrder = null;
            this.paperSimulatedMakerReasonCode = null;
            this.riskState = resetCircuitBreaker(this.riskState);
            this.lastMarketSlug = market.slug;
            this.lastWindowEnd = market.endDateIso;
            this.windowState = createEmptyWindowState(
                market.slug,
                market.conditionId,
                market.endDateIso,
                { yesTokenId: market.yesTokenId, noTokenId: market.noTokenId }
            );
            this.lastBuyPrice = 0;
            this.lastExecutedSide = null;
            this.roundsThisWindow = 0;
            this.holdsThisWindow = 0;
            this.lastBalanceFetchTs = 0;
            this.lastPositionFetchTs = 0;
            this.lastPositionKey = '';
            this.btcUsdAtWindowOpen = null;
            this.lastBtcUsdSpot = null;
            this.btcGapLastNonZeroSign = 0;
            this.btcGapSamples = [];
            this.btcMomentumSnapshot = {
                flipDetected: false,
                velocityUsdPerSec: null,
                predictedGap60sUsd: null,
            };
            this.noAskMomentumSamples = [];
            this.yesAskMomentumSamples = [];
            this.lastEarlyDownMomentumHedgeAt = 0;
            this.downAskMomentumUsdPerSecDisplay = null;
            this.downAskPredictedAtWindowEndUsdDisplay = null;
            qlog(q, `\n>> New window: ${market.question || market.slug}`);
            qlog(
                q,
                `   End: ${market.endDateIso} | YES: ${market.yesTokenId.slice(0, 12)}... | NO: ${market.noTokenId.slice(0, 12)}...`
            );
        }

        if (!this.windowState) {
            this.windowState = createEmptyWindowState(
                market.slug,
                market.conditionId,
                market.endDateIso,
                { yesTokenId: market.yesTokenId, noTokenId: market.noTokenId }
            );
        }
        this.syncWindowTokenIdsFromActiveMarket(market);

        if (this.btcUsdAtWindowOpen === null) {
            if (this.backtraceWindowOpenAnchorUsd != null) {
                this.btcUsdAtWindowOpen = this.backtraceWindowOpenAnchorUsd;
                this.lastBtcUsdSpot = this.backtraceWindowOpenAnchorUsd;
            } else {
                let anchor: number | null = null;
                try {
                    const d = await fetchGammaBtcUpDownWindowDetails(market.slug);
                    if (d.priceToBeat != null && Number.isFinite(d.priceToBeat)) {
                        anchor = d.priceToBeat;
                    }
                } catch {
                    /* fall back to Binance */
                }
                if (anchor == null) {
                    anchor = await fetchBtcUsdPrice();
                }
                if (anchor !== null) {
                    this.btcUsdAtWindowOpen = anchor;
                    this.lastBtcUsdSpot = anchor;
                }
            }
        }

        await this.refreshBtcGapAndMomentum();

        this.orderbookWs?.syncSubscribe(market.yesTokenId, market.noTokenId);

        // ══════════════════════════════════════════════════════════════════
        // ██  PHASE 1: Reconcile fills from previous tick's order         ██
        // ══════════════════════════════════════════════════════════════════
        if (this.config.liveTrading && this.activePendingOrder) {
            try {
                const feeScalarLive = this.config.binaryOutcomeTakerFeeScalar ?? 0.072;
                const { fills, updatedPending } = await reconcilePendingOrders(
                    this.client,
                    [this.activePendingOrder],
                    { feeScalar: feeScalarLive }
                );
                if (fills.length > 0) await this.applyFills(fills);

                if (updatedPending.length > 0) {
                    this.activePendingOrder = updatedPending[0];
                } else {
                    const totalFilled =
                        this.activePendingOrder.sizeFilled +
                        fills.reduce((s, f) => s + f.newFillQty, 0);
                    this.onOrderCompleted(this.activePendingOrder, totalFilled);
                    this.activePendingOrder = null;
                }
            } catch (err) {
                console.error('[Bot] Fill reconciliation error:', err);
            }
        }

        if (!this.config.liveTrading && this.paperSimulatedMakerOrder) {
            const waitPaper = await this.tickPaperSimulatedMaker(market, q);
            if (waitPaper) return;
        }

        // ══════════════════════════════════════════════════════════════════
        // ██  PHASE 2: Cancel unfilled order (fresh eval each tick)       ██
        // ══════════════════════════════════════════════════════════════════
        // IMPORTANT: Do NOT cancel every tick. That behavior prevents fills and
        // leads to one-sided exposure (losses). Keep orders alive briefly and
        // only cancel if stale.
        if (this.config.liveTrading && this.activePendingOrder) {
            const placedMs = Date.parse(this.activePendingOrder.placedAt);
            const ageMs = Number.isFinite(placedMs)
                ? Date.now() - placedMs
                : MAX_PENDING_ORDER_AGE_MS + 1;
            const fallbackMs = this.config.liveMakerFallbackToTakerMs ?? 2500;
            const canHybridFallback =
                this.config.livePreferTakerAllEntries !== true && fallbackMs > 0;
            if (canHybridFallback && ageMs > fallbackMs && ageMs <= MAX_PENDING_ORDER_AGE_MS) {
                const pending = this.activePendingOrder;
                try {
                    await this.client.cancelOrder({ orderID: pending.orderId });
                } catch {
                    // Cancel failures can happen if the order just matched/cancelled server-side.
                }
                try {
                    const feeScalarLive = this.config.binaryOutcomeTakerFeeScalar ?? 0.072;
                    const { fills } = await reconcilePendingOrders(this.client, [pending], {
                        feeScalar: feeScalarLive,
                    });
                    if (fills.length > 0) await this.applyFills(fills);
                    const makerFilled = pending.sizeFilled + fills.reduce((s, f) => s + f.newFillQty, 0);
                    const remaining = Math.max(0, Math.floor(pending.sizeRequested - makerFilled));
                    const minSz = Math.max(1, Math.floor(this.config.orderMinSize || 1));
                    let usedTakerFallback = false;
                    let fallbackNote = '';
                    if (remaining >= minSz && this.windowState) {
                        const booksNow = await getBothOrderBooks(this.client, market, this.orderbookWs);
                        const askNow =
                            pending.side === 'YES'
                                ? booksNow.bookYes.bestAsk ?? 0
                                : booksNow.bookNo.bestAsk ?? 0;
                        if (askNow > 0 && askNow < 1) {
                            this.liveBestBidYes = booksNow.bookYes.bestBid ?? this.liveBestBidYes;
                            this.liveBestBidNo = booksNow.bookNo.bestBid ?? this.liveBestBidNo;
                            this.liveBestAskYes = booksNow.bookYes.bestAsk ?? this.liveBestAskYes;
                            this.liveBestAskNo = booksNow.bookNo.bestAsk ?? this.liveBestAskNo;
                            this.liveCombinedBid = this.liveBestBidYes + this.liveBestBidNo;
                            this.liveCombinedAsk = this.liveBestAskYes + this.liveBestAskNo;

                            const preHybrid = await this.preflightLiveTakerClip(
                                market,
                                q,
                                pending.side,
                                remaining,
                                false
                            );
                            if (!preHybrid.ok) {
                                fallbackNote = ` | taker skipped: ${preHybrid.reason}`;
                            } else {
                                const limitPx = preHybrid.takerLimitPx;
                                const takerCost = limitPx * preHybrid.shares;
                                if (
                                    takerCost >= 1 &&
                                    this.cachedBalances.polymarketUsdc >= takerCost + 0.25
                                ) {
                                    const result = await buyInstant(
                                        this.client,
                                        pending.tokenId,
                                        preHybrid.ask,
                                        preHybrid.shares,
                                        this.config,
                                        !!market.negRisk,
                                        { marketConditionId: market.conditionId }
                                    );
                                    if (result.success && result.orderId && result.orderId !== 'unknown') {
                                        const sideLabel = pending.side === 'YES' ? 'Up' : 'Down';
                                        const acctH = this.resolveLiveFokAccounting(true, result, {
                                            shares: preHybrid.shares,
                                            price: limitPx,
                                            costUsd: takerCost,
                                        });
                                        await this.applyBuyFillAccountingUnified(
                                            market,
                                            preHybrid.stateBefore,
                                            pending.side,
                                            acctH.shares,
                                            acctH.price,
                                            acctH.costUsd,
                                            {
                                                bestBidYes: this.liveBestBidYes,
                                                bestBidNo: this.liveBestBidNo,
                                                bestAskYes: this.liveBestAskYes,
                                                bestAskNo: this.liveBestAskNo,
                                            },
                                            `${this.activePendingOrderReasonCode ?? 'LIVE_MAKER'}|MAKER_TIMEOUT_TAKER`,
                                            'tick',
                                            (ws) =>
                                                `Hybrid fallback: ${sideLabel} ${acctH.shares}@$${acctH.price.toFixed(4)} | pairCost=$${ws.pairCost.toFixed(4)} | Up=${ws.qtyYes} Down=${ws.qtyNo}`,
                                            q,
                                            { liquidity: 'TAKER' }
                                        );
                                        usedTakerFallback = true;
                                        fallbackNote = ` + taker ${sideLabel} ${acctH.shares}@$${limitPx.toFixed(2)}`;
                                } else {
                                    fallbackNote = ` | taker fallback failed: ${result.error ?? 'unknown'}`;
                                }
                            } else if (takerCost < 1) {
                                fallbackNote = ` | fallback skipped: order $${takerCost.toFixed(2)} < $1`;
                            } else {
                                fallbackNote = ' | fallback skipped: insufficient balance';
                            }
                            }
                        } else {
                            fallbackNote = ' | fallback skipped: no valid ask';
                        }
                    }
                    if (!usedTakerFallback && makerFilled > 0) {
                        this.onOrderCompleted(pending, makerFilled);
                    } else if (!usedTakerFallback && makerFilled <= 0) {
                        this.activePendingOrderReasonCode = null;
                    }
                    this.activePendingOrder = null;
                    updateDashboardState({
                        ...this.getDashboardExtras(),
                        marketSlug: market.slug,
                        windowEndIso: market.endDateIso,
                        consecutiveFailures: this.riskState.consecutiveOrderFailures,
                        pendingOrders: 0,
                        lastTick: new Date().toISOString(),
                        message: `HYBRID: maker timeout ${Math.floor(ageMs / 1000)}s — cancelled${fallbackNote}`,
                    });
                    return;
                } catch (err) {
                    console.error('[Bot] Hybrid maker->taker fallback error:', err);
                }
            }
            if (ageMs > MAX_PENDING_ORDER_AGE_MS) {
                const stalePending = this.activePendingOrder;
                if (!stalePending) return;
                try {
                    await this.client.cancelOrder({ orderID: stalePending.orderId });
                    const feeScalarLive = this.config.binaryOutcomeTakerFeeScalar ?? 0.072;
                    const { fills } = await reconcilePendingOrders(this.client, [stalePending], {
                        feeScalar: feeScalarLive,
                    });
                    if (fills.length > 0) await this.applyFills(fills);
                    const totalFilled =
                        stalePending.sizeFilled + fills.reduce((s, f) => s + f.newFillQty, 0);
                    this.onOrderCompleted(stalePending, totalFilled);
                } catch {}
                this.activePendingOrder = null;
            }
        }

        // ══════════════════════════════════════════════════════════════════
        // ██  PHASE 2.5: On-chain inventory (source of truth in live)     ██
        // ══════════════════════════════════════════════════════════════════
        await this.refreshLiveInventoryFromChain(market, q);
        if (this.config.liveTrading) {
            await this.refreshClobTradesForLiveDashboard(market);
        }

        if (this.config.liveTrading && this.activePendingOrder && this.windowState) {
            const ws = this.windowState;
            const qInv = 1e-8;
            if (ws.qtyYes > qInv && ws.qtyNo > qInv) {
                const apCancel = afterPnlsFromState(ws);
                if (apCancel.afterPnlIfUp < 0 || apCancel.afterPnlIfDown < 0) {
                    try {
                        await this.client.cancelOrder({ orderID: this.activePendingOrder.orderId });
                        console.warn(
                            '[Bot] Cancelled resting order: dual-leg After PnL If Up/Down below $0 after inventory update'
                        );
                    } catch {
                        /* ignore */
                    }
                    this.activePendingOrder = null;
                }
            }
        }

        if (this.config.liveTrading && this.activePendingOrder) {
            const placedMs = Date.parse(this.activePendingOrder.placedAt);
            const ageMs = Number.isFinite(placedMs)
                ? Date.now() - placedMs
                : MAX_PENDING_ORDER_AGE_MS + 1;
            if (ageMs <= MAX_PENDING_ORDER_AGE_MS) {
                updateDashboardState({
                    ...this.getDashboardExtras(),
                    marketSlug: market.slug,
                    windowEndIso: market.endDateIso,
                    consecutiveFailures: this.riskState.consecutiveOrderFailures,
                    pendingOrders: 1,
                    lastTick: new Date().toISOString(),
                    message: `WAIT: pending order resting (${Math.floor(ageMs / 1000)}s old)`,
                });
                return;
            }
        }

        if (!this.config.liveTrading) {
            this.cachedBalances.polymarketUsdc = getSimulatedBalance();
            this.cachedBalances.totalUsdc = getSimulatedBalance();
        }

        const state = this.windowState;
        const windowSec = market.windowDurationSec;
        const { elapsedSec, secondsLeft } = btcUpDownWindowElapsedAndRemaining({
            slug: market.slug,
            endDateIso: market.endDateIso,
            windowDurationSec: windowSec,
            gameStartTime: market.gameStartTime,
        });
        const warmupSec = effectiveWarmupSeconds(this.config, windowSec);

        if (!this.backtraceReplayMode && !this.startupLateJoinEvaluated) {
            this.startupLateJoinEvaluated = true;
            if (windowSec > 0 && elapsedSec > windowSec / 2) {
                this.startupSkipTradingWindowEndIso = market.endDateIso;
                qlog(
                    q,
                    `[Bot] Late start: ${elapsedSec}s elapsed in a ${windowSec}s window — no automatic orders until the next window.`
                );
            }
        }

        // ══════════════════════════════════════════════════════════════════
        // ██  Warmup: no orders until elapsed ≥ effectiveWarmupSeconds       ██
        // ══════════════════════════════════════════════════════════════════
        if (!this.backtraceReplayMode && elapsedSec < warmupSec) {
            updateDashboardState({
                ...this.getDashboardExtras(),
                marketSlug: market.slug,
                windowEndIso: market.endDateIso,
                consecutiveFailures: this.riskState.consecutiveOrderFailures,
                pendingOrders: this.activePendingOrder ? 1 : 0,
                lastTick: new Date().toISOString(),
                message: `[${market.btcMarketWindowMinutes}m] Warmup: ${warmupSec - elapsedSec}s left (${elapsedSec}s / ${warmupSec}s) — set windowEntryWarmupSeconds: 0 to trade at open`,
            });
            return;
        }

        if (
            !this.backtraceReplayMode &&
            this.startupSkipTradingWindowEndIso !== null &&
            market.endDateIso === this.startupSkipTradingWindowEndIso
        ) {
            const m = Math.floor(secondsLeft / 60);
            const s = secondsLeft % 60;
            updateDashboardState({
                ...this.getDashboardExtras(),
                marketSlug: market.slug,
                windowEndIso: market.endDateIso,
                consecutiveFailures: this.riskState.consecutiveOrderFailures,
                pendingOrders: 0,
                lastTick: new Date().toISOString(),
                message: `LATE START: bot started past half this window — no automatic orders; next window in ${m}m ${s}s`,
            });
            return;
        }

        const pairLadderOn = this.config.pairLadderMatchEnabled === true;
        const pairImbForSkip = pairLadderOn ? this.pairQtyImbalanceShares(state) : 0;
        /** Pair mode: while imbalanced, only the main path may trade (exact hedge size). */
        const pairLadderSkipAuxiliary = pairLadderOn && pairImbForSkip > 0;

        // Dual-leg: if either After PnL is below $0, do not place any new orders. Check both internal
        // window state and fill-aggregated display state (dashboard) so live chain-imputed costs cannot
        // diverge from logged fills and allow trades while the UI shows both PnLs negative.
        const zDual = 1e-8;
        const dualLegNegative = (ws: WindowState): ReturnType<typeof afterPnlsFromState> | null => {
            if (ws.qtyYes <= zDual || ws.qtyNo <= zDual) return null;
            const ap = afterPnlsFromState(ws);
            // After a Stock A buy, one outcome's After PnL can be negative until Stock B; only block if both lose.
            if (ap.afterPnlIfUp < 0 && ap.afterPnlIfDown < 0) return ap;
            return null;
        };
        const badTracked = dualLegNegative(state);
        const displayWs = this.getDashboardDisplayWindowState();
        const badDisplay = displayWs ? dualLegNegative(displayWs) : null;
        /** Matched pair ladder: fill-log display can lag one tick — do not stall the next Stock A on display only. */
        const pairLadderMatchedEqual =
            pairLadderOn &&
            state.qtyYes > zDual &&
            state.qtyNo > zDual &&
            this.pairQtyImbalanceShares(state) === 0;
        if (badTracked || (!pairLadderMatchedEqual && badDisplay)) {
            const apShow = badDisplay ?? badTracked!;
            const extra =
                badTracked && badDisplay &&
                (Math.abs(badTracked.afterPnlIfUp - badDisplay.afterPnlIfUp) > 0.005 ||
                    Math.abs(badTracked.afterPnlIfDown - badDisplay.afterPnlIfDown) > 0.005)
                    ? ` | tracked Up $${badTracked.afterPnlIfUp.toFixed(2)} Down $${badTracked.afterPnlIfDown.toFixed(2)}`
                    : '';
            updateDashboardState({
                ...this.getDashboardExtras(),
                marketSlug: market.slug,
                windowEndIso: market.endDateIso,
                consecutiveFailures: this.riskState.consecutiveOrderFailures,
                pendingOrders: this.activePendingOrder ? 1 : 0,
                lastTick: new Date().toISOString(),
                message:
                    `AFTER PNL: both Up and Down < $0 — no orders (display Up $${apShow.afterPnlIfUp.toFixed(2)} · Down $${apShow.afterPnlIfDown.toFixed(2)})${extra}`,
            });
            return;
        }

        // ══════════════════════════════════════════════════════════════════
        // ██  PHASE 3: Stop conditions + final one-sided hedge            ██
        // ══════════════════════════════════════════════════════════════════

        const absOrderCut = this.config.absoluteNoOrderSeconds ?? 2;
        if (secondsLeft <= absOrderCut) {
            updateDashboardState({
                ...this.getDashboardExtras(),
                marketSlug: market.slug,
                windowEndIso: market.endDateIso,
                consecutiveFailures: this.riskState.consecutiveOrderFailures,
                pendingOrders: 0,
                lastTick: new Date().toISOString(),
                message: `CUTOFF: ${secondsLeft}s left — no orders (absolute end buffer)`,
            });
            return;
        }

        if (!pairLadderSkipAuxiliary) {
            const earlyDownMomentumHandled = await this.tryExecuteEarlyDownAskMomentumHedge(
                market,
                state,
                secondsLeft,
                q
            );
            if (earlyDownMomentumHandled) return;

            const finalMomentumTargetHandled = await this.tryExecuteFinalOneSidedMomentumTarget(
                market,
                state,
                secondsLeft,
                q
            );
            if (finalMomentumTargetHandled) return;

            const momentumHedgeHandled = await this.tryExecuteOneSidedFokHedge(
                market,
                state,
                secondsLeft,
                q,
                'momentum'
            );
            if (momentumHedgeHandled) return;

            const finalHedgeHandled = await this.tryExecuteOneSidedFokHedge(
                market,
                state,
                secondsLeft,
                q,
                'final'
            );
            if (finalHedgeHandled) return;
        }

        if (secondsLeft <= HARD_CUTOFF_SECONDS) {
            updateDashboardState({
                ...this.getDashboardExtras(),
                marketSlug: market.slug,
                windowEndIso: market.endDateIso,
                consecutiveFailures: this.riskState.consecutiveOrderFailures,
                pendingOrders: 0,
                lastTick: new Date().toISOString(),
                message: `CUTOFF: ${secondsLeft}s left — waiting for resolution`,
            });
            return;
        }

        // Soft stop: balanced + good pair cost near end → stop only if we've deployed the window budget.
        // Pair ladder: never idle here — next Stock A leg must run as soon as a pair is matched.
        const maxPos = this.config.maxPositionPerWindowUsd ?? 0;
        const spent = state.totalSpentUsd;
        const budgetHeadroomUsd = Math.max(0, maxPos - spent);
        const nearBudgetFull =
            maxPos <= 0 ? false : budgetHeadroomUsd <= Math.max(5, maxPos * 0.02);
        const pairCeilSoftStop = pairCostCeiling(this.config);
        if (
            this.config.pairLadderMatchEnabled !== true &&
            state.qtyYes === state.qtyNo &&
            state.qtyYes > 0 &&
            state.pairCost <= pairCeilSoftStop + 1e-9 &&
            inStopTradingSecondsBeforeEndWindow(
                secondsLeft,
                this.config.stopTradingSecondsBeforeEnd
            ) &&
            nearBudgetFull
        ) {
            updateDashboardState({
                ...this.getDashboardExtras(),
                marketSlug: market.slug,
                windowEndIso: market.endDateIso,
                consecutiveFailures: this.riskState.consecutiveOrderFailures,
                pendingOrders: 0,
                lastTick: new Date().toISOString(),
                message:
                    `BALANCED: Up=${state.qtyYes} Down=${state.qtyNo} pairCost=$${state.pairCost.toFixed(4)} ` +
                    `locked=$${state.lockedProfit.toFixed(2)} — near budget cap ($${spent.toFixed(0)} / $${maxPos.toFixed(0)}) ` +
                    `— waiting for window end (${secondsLeft}s)`,
            });
            return;
        }

        const dualStopUsd = this.config.dualOutcomeProfitStopUsd ?? 5;
        // When both legs are held and both After PnL If Up/Down reach dualOutcomeProfitStopUsd, stop this
        // window — do not bypass for aggressive dual PnL hedge or pair-ladder "next Stock A" (those only apply
        // below this profit target).
        if (dualStopUsd > 0 && state.qtyYes > 0 && state.qtyNo > 0) {
            const pu = state.qtyYes - state.totalSpentUsd;
            const pd = state.qtyNo - state.totalSpentUsd;
            if (pu >= dualStopUsd && pd >= dualStopUsd) {
                updateDashboardState({
                    ...this.getDashboardExtras(),
                    marketSlug: market.slug,
                    windowEndIso: market.endDateIso,
                    consecutiveFailures: this.riskState.consecutiveOrderFailures,
                    pendingOrders: 0,
                    lastTick: new Date().toISOString(),
                    message: `DUAL_AFTER_PNL_STOP: Up $${pu.toFixed(2)} Down $${pd.toFixed(2)} ≥ $${dualStopUsd} — no further orders this window`,
                });
                return;
            }
        }

        // ══════════════════════════════════════════════════════════════════
        // ██  PHASE 4: Fetch orderbooks                                   ██
        // ══════════════════════════════════════════════════════════════════
        let bestBidYes = 0,
            bestBidNo = 0;
        let books: { bookYes: OrderBookSnapshot; bookNo: OrderBookSnapshot } | null = null;
        try {
            books = await getBothOrderBooks(this.client, market, this.orderbookWs);
            bestBidYes = books.bookYes.bestBid ?? 0;
            bestBidNo = books.bookNo.bestBid ?? 0;
            this.liveBestBidYes = bestBidYes;
            this.liveBestBidNo = bestBidNo;
            this.liveBestAskYes = books.bookYes.bestAsk ?? 0;
            this.liveBestAskNo = books.bookNo.bestAsk ?? 0;
            this.liveCombinedBid = bestBidYes + bestBidNo;
            this.liveCombinedAsk = this.liveBestAskYes + this.liveBestAskNo;
            this.recordBestAskSamplesForMomentum(books.bookYes, books.bookNo);
        } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            updateDashboardState({
                ...this.getDashboardExtras(),
                marketSlug: market.slug,
                windowEndIso: market.endDateIso,
                consecutiveFailures: this.riskState.consecutiveOrderFailures,
                pendingOrders: 0,
                message: `Orderbook error: ${msg}`,
                lastTick: new Date().toISOString(),
            });
            return;
        }

        if (books === null) return;

        const impliedPairHedgeDone = await this.tryExecuteImmediateImpliedPairCostHedge(
            market,
            state,
            secondsLeft,
            books,
            q
        );
        if (impliedPairHedgeDone) return;

        // Note: we do NOT hard-gate on (bidYES + bidNO) anymore (closer to reference wallet).

        if (books !== null && !pairLadderSkipAuxiliary) {
            const aggressiveHandled = await this.tryExecuteAggressiveDualPnlHedge(
                market,
                this.windowState!,
                secondsLeft,
                books,
                q
            );
            if (aggressiveHandled) return;
        }

        if (
            books !== null &&
            !pairLadderSkipAuxiliary &&
            this.isBalancedOpenPositionValueInStopBand(state, books.bookYes, books.bookNo)
        ) {
            const maxPos = this.config.maxPositionPerWindowUsd ?? 0;
            const stockAMax = this.config.pairStockARandomSharesMax ?? 0;
            const band = this.config.balancedOpenPositionValueStopBandUsd ?? 20;
            const center = maxPos - stockAMax;
            const by = books.bookYes.bestBid ?? 0;
            const bn = books.bookNo.bestBid ?? 0;
            const openVal = state.qtyYes * by + state.qtyNo * bn;
            this.holdsThisWindow++;
            updateDashboardState({
                ...this.getDashboardExtras(),
                marketSlug: market.slug,
                windowEndIso: market.endDateIso,
                consecutiveFailures: this.riskState.consecutiveOrderFailures,
                pendingOrders: this.activePendingOrder ? 1 : 0,
                lastTick: new Date().toISOString(),
                message:
                    `HOLD: balanced Up=${state.qtyYes.toFixed(0)} Down=${state.qtyNo.toFixed(0)} — Open Positions Value $${openVal.toFixed(2)} ` +
                    `in stop band [$${(center - band).toFixed(2)}, $${(center + band).toFixed(2)}] ` +
                    `(center = maxPosition $${maxPos.toFixed(0)} − pairStockARandomSharesMax ${stockAMax})`,
            });
            return;
        }

        // ══════════════════════════════════════════════════════════════════
        // ██  PHASE 5: Side + clip (tilt / parity / forced switch)         ██
        // ══════════════════════════════════════════════════════════════════
        this.recordEntryDecisionSnapshot(bestBidYes, bestBidNo, secondsLeft, windowSec);
        if (bestBidYes <= 0 || bestBidNo <= 0) {
            this.holdsThisWindow++;
            updateDashboardState({
                ...this.getDashboardExtras(),
                marketSlug: market.slug,
                windowEndIso: market.endDateIso,
                consecutiveFailures: this.riskState.consecutiveOrderFailures,
                pendingOrders: 0,
                lastTick: new Date().toISOString(),
                message: `HOLD: No bid liquidity (Up=$${bestBidYes.toFixed(2)} Down=$${bestBidNo.toFixed(2)})`,
            });
            return;
        }

        const btcDelta =
            this.lastBtcUsdSpot != null && this.btcUsdAtWindowOpen != null
                ? this.lastBtcUsdSpot - this.btcUsdAtWindowOpen
                : null;
        const riseInForStockA = this.buildEntryRiseSignalInputForStockA(
            btcDelta,
            books.bookYes,
            books.bookNo,
            bestBidYes,
            bestBidNo
        );
        const zPairSk = 1e-8;
        const pairBalancedBook =
            pairLadderOn &&
            state.qtyYes > zPairSk &&
            state.qtyNo > zPairSk &&
            pairImbForSkip === 0;

        let skewDecision: StrategyDecision | null = null;
        const skewOn = this.config.directionalSkewEnabled !== false;
        if (books !== null && skewOn && !pairBalancedBook) {
            skewDecision = buildDirectionalSkewInventoryDecision(
                this.config,
                state,
                books.bookYes,
                books.bookNo,
                {
                    btcUsdDeltaFromWindowOpen: btcDelta,
                }
            );
        }

        let side: 'YES' | 'NO';
        let sideLabel: string;
        let currentBid: number;
        let tokenId: string;
        let shares: number;
        let orderReasonCode: string;

        let alternateHedgeActive = false;
        let alternateBookRound = false;

        const altFrom = this.config.alternateHedgeFromRound ?? 2;
        const useAlternateHedge =
            skewDecision === null && this.roundsThisWindow >= altFrom && !pairLadderOn;

        const pairHedgeMode = pairLadderSkipAuxiliary;

        if (pairHedgeMode) {
            const lighter = this.pairLighterHedgeSide(state);
            if (!lighter) {
                this.holdsThisWindow++;
                updateDashboardState({
                    ...this.getDashboardExtras(),
                    marketSlug: market.slug,
                    windowEndIso: market.endDateIso,
                    consecutiveFailures: this.riskState.consecutiveOrderFailures,
                    pendingOrders: 0,
                    lastTick: new Date().toISOString(),
                    message: 'HOLD: pair ladder — expected imbalance for hedge but book is balanced',
                });
                return;
            }
            side = lighter;
            sideLabel = side === 'YES' ? 'Up' : 'Down';
            currentBid = side === 'YES' ? bestBidYes : bestBidNo;
            tokenId = side === 'YES' ? market.yesTokenId : market.noTokenId;
            const { lo: plHedgeLo } = this.pairStockARandomClipBounds(market, bestBidYes, bestBidNo);
            shares = Math.max(pairImbForSkip, plHedgeLo);
            orderReasonCode =
                pairImbForSkip >= plHedgeLo
                    ? `PAIR_LADDER_HEDGE|imb_${shares}sh`
                    : `PAIR_LADDER_HEDGE|imb${pairImbForSkip}_raisedToMinClip_${shares}`;
        } else if (skewDecision !== null) {
            side = skewDecision.action === 'BUY_YES' ? 'YES' : 'NO';
            sideLabel = side === 'YES' ? 'Up' : 'Down';
            currentBid = skewDecision.price;
            tokenId = side === 'YES' ? market.yesTokenId : market.noTokenId;
            shares = skewDecision.size;
            orderReasonCode = skewDecision.reason;
        } else if (useAlternateHedge) {
            alternateHedgeActive = true;
            const roundAlt = this.roundsThisWindow - altFrom;
            alternateBookRound = roundAlt % 2 === 0;
            if (alternateBookRound) {
                const raw = this.chooseSideDecision(bestBidYes, bestBidNo);
                const { decision: sideDecision, riseTag } = this.applyEntryRiseSignal(
                    raw,
                    bestBidYes,
                    bestBidNo,
                    books.bookYes,
                    books.bookNo,
                    btcDelta
                );
                side = sideDecision.side;
                orderReasonCode = riseTag
                    ? `ALT_HEDGE_BOOK|${sideDecision.reason}|${riseTag}`
                    : `ALT_HEDGE_BOOK|${sideDecision.reason}`;
            } else if (this.lastExecutedSide !== null) {
                side = this.lastExecutedSide === 'YES' ? 'NO' : 'YES';
                orderReasonCode = `ALT_HEDGE_OPP|last=${this.lastExecutedSide}`;
            } else {
                const raw = this.chooseSideDecision(bestBidYes, bestBidNo);
                const { decision: sideDecision, riseTag } = this.applyEntryRiseSignal(
                    raw,
                    bestBidYes,
                    bestBidNo,
                    books.bookYes,
                    books.bookNo,
                    btcDelta
                );
                side = sideDecision.side;
                orderReasonCode = riseTag
                    ? `ALT_HEDGE_OPP_FALLBACK|${sideDecision.reason}|${riseTag}`
                    : `ALT_HEDGE_OPP_FALLBACK|${sideDecision.reason}`;
            }
            sideLabel = side === 'YES' ? 'Up' : 'Down';
            currentBid = side === 'YES' ? bestBidYes : bestBidNo;
            tokenId = side === 'YES' ? market.yesTokenId : market.noTokenId;
            shares = this.pickAlternateHedgeClipShares(market);
        } else {
            const raw = this.chooseSideDecision(bestBidYes, bestBidNo);
            const { decision: sideDecision, riseTag } = this.applyEntryRiseSignal(
                raw,
                bestBidYes,
                bestBidNo,
                books.bookYes,
                books.bookNo,
                btcDelta
            );
            side = sideDecision.side;
            sideLabel = side === 'YES' ? 'Up' : 'Down';
            currentBid = side === 'YES' ? bestBidYes : bestBidNo;
            tokenId = side === 'YES' ? market.yesTokenId : market.noTokenId;
            shares = this.isPairLadderStockALeg(state, side)
                ? this.pickPairStockASharesForMomentum(
                      market,
                      riseInForStockA,
                      bestBidYes,
                      bestBidNo
                  )
                : this.chooseClipSize(currentBid, secondsLeft, windowSec);
            shares = Math.max(shares, market.orderMinSize || 0);
            orderReasonCode = riseTag ? `${sideDecision.reason}|${riseTag}` : sideDecision.reason;
        }

        // 5m first-entry override (same order book as first order; also used on alternate "book" rounds):
        // if chosen side is already expensive (>= $0.80), buy the opposite side first.
        if (
            !pairHedgeMode &&
            this.config.btcMarketWindowMinutes === 5 &&
            (this.roundsThisWindow === 0 || (alternateHedgeActive && alternateBookRound))
        ) {
            const chosenPrice = side === 'YES' ? bestBidYes : bestBidNo;
            const oppositePrice = side === 'YES' ? bestBidNo : bestBidYes;
            const chosenTopBidSize =
                side === 'YES'
                    ? (books?.bookYes.bids?.[0]?.size ?? 0)
                    : (books?.bookNo.bids?.[0]?.size ?? 0);
            if (
                chosenPrice >= FIRST_ENTRY_EXPENSIVE_SIDE_PRICE &&
                oppositePrice < FIRST_ENTRY_EXPENSIVE_SIDE_PRICE &&
                chosenTopBidSize < FIRST_ENTRY_EXPENSIVE_SIDE_MIN_TOP_BID_SIZE
            ) {
                side = side === 'YES' ? 'NO' : 'YES';
                sideLabel = side === 'YES' ? 'Up' : 'Down';
                currentBid = side === 'YES' ? bestBidYes : bestBidNo;
                tokenId = side === 'YES' ? market.yesTokenId : market.noTokenId;
                shares =
                    alternateHedgeActive && alternateBookRound
                        ? this.pickAlternateHedgeClipShares(market)
                        : this.isPairLadderStockALeg(state, side)
                          ? this.pickPairStockASharesForMomentum(
                                market,
                                riseInForStockA,
                                bestBidYes,
                                bestBidNo
                            )
                          : this.chooseClipSize(currentBid, secondsLeft, windowSec);
                shares = Math.max(shares, market.orderMinSize || 0);
                orderReasonCode =
                    `FIRST_ENTRY_EXPENSIVE_SIDE_FLIP(>=${FIRST_ENTRY_EXPENSIVE_SIDE_PRICE.toFixed(2)}` +
                    ` and topBidSize<${FIRST_ENTRY_EXPENSIVE_SIDE_MIN_TOP_BID_SIZE})`;
            }
        }

        // BTC gap momentum: lean inventory toward expected winner (|gap| ≥ threshold).
        // When entry rise signal is on, BTC tilt is already in applyEntryRiseSignal — avoid double-steering.
        if (
            !pairHedgeMode &&
            this.config.momentumImbalanceStrategyEnabled !== false &&
            btcDelta != null &&
            this.config.entryRiseSignalEnabled !== true
        ) {
            const thr = this.config.momentumBiasGapUsd ?? 35;
            if (btcDelta >= thr && state.qtyYes <= state.qtyNo) {
                side = 'YES';
                sideLabel = 'Up';
                currentBid = bestBidYes;
                tokenId = market.yesTokenId;
                orderReasonCode = `${orderReasonCode}|MOMENTUM_BIAS_UP`;
            } else if (btcDelta <= -thr && state.qtyNo <= state.qtyYes) {
                side = 'NO';
                sideLabel = 'Down';
                currentBid = bestBidNo;
                tokenId = market.noTokenId;
                orderReasonCode = `${orderReasonCode}|MOMENTUM_BIAS_DOWN`;
            }
        }

        const zPairEq = 1e-8;
        const pairLadderQtyEqualOrEmpty =
            pairLadderOn &&
            !pairHedgeMode &&
            skewDecision === null &&
            !alternateHedgeActive &&
            books != null &&
            ((state.qtyYes <= zPairEq && state.qtyNo <= zPairEq) ||
                (state.qtyYes > zPairEq &&
                    state.qtyNo > zPairEq &&
                    Math.abs(state.qtyYes - state.qtyNo) <= zPairEq));

        if (pairLadderQtyEqualOrEmpty) {
            const minSpan = this.config.entryRiseAskVelMinSpanSec ?? 2;
            const vy = downAskVelocityUsdPerSec(this.yesAskMomentumSamples, minSpan);
            const vn = downAskVelocityUsdPerSec(this.noAskMomentumSamples, minSpan);
            const yesAsk = books.bookYes.bestAsk ?? 0;
            const noAsk = books.bookNo.bestAsk ?? 0;
            const spreadYes = yesAsk > 0 && bestBidYes > 0 ? yesAsk - bestBidYes : 0;
            const spreadNo = noAsk > 0 && bestBidNo > 0 ? noAsk - bestBidNo : 0;
            // Must use `predictLikelyRisingSide`, not `evaluateLikelyRisingSideSignal` raw: the latter ignores
            // `entryRiseSignalEnabled` and can force a leg even when the user turned entry-rise off (then only
            // BTC gap / velocity / `predictWinnerForPairLadderStockA` tie-breaks should apply).
            const rise = predictLikelyRisingSide(this.config, {
                btcUsdDeltaFromWindowOpen: btcDelta,
                yesAsk,
                noAsk,
                yesAskVelocityUsdPerSec: vy,
                noAskVelocityUsdPerSec: vn,
                spreadYes,
                spreadNo,
            });
            const pred =
                rise.side ??
                predictWinnerForPairLadderStockA(this.config, btcDelta, {
                    yesAskVelocityUsdPerSec: vy,
                    noAskVelocityUsdPerSec: vn,
                    btcGapPredictedUsd: this.btcMomentumSnapshot.predictedGap60sUsd,
                    bestAskYes: yesAsk,
                    bestAskNo: noAsk,
                    bestBidYes,
                    bestBidNo,
                });
            side = pred;
            sideLabel = pred === 'YES' ? 'Up' : 'Down';
            currentBid = pred === 'YES' ? bestBidYes : bestBidNo;
            tokenId = pred === 'YES' ? market.yesTokenId : market.noTokenId;
            orderReasonCode =
                `${orderReasonCode}|PAIR_LADDER_RISE_${rise.side ?? 'tie'}→${pred}` +
                (rise.side ? `|${rise.detail}` : '|gapMom');
            if (this.roundsThisWindow > 0) {
                shares = this.pickPairStockASharesForMomentum(
                    market,
                    riseInForStockA,
                    bestBidYes,
                    bestBidNo
                );
                orderReasonCode = `${orderReasonCode}|PAIR_MOM_STOCK_A_${shares}`;
            }
        }

        // Final window: if still one-sided, assume the missing leg is winning — do not add to the held leg.
        const finalSecOne = this.config.finalOneSidedHedgeSeconds ?? 30;
        const absCutOne = this.config.absoluteNoOrderSeconds ?? 2;
        const zOne = 1e-8;
        const oneSidedLongYes = state.qtyYes > zOne && state.qtyNo <= zOne;
        const oneSidedLongNo = state.qtyNo > zOne && state.qtyYes <= zOne;
        if (
            secondsLeft <= finalSecOne &&
            secondsLeft > absCutOne &&
            (oneSidedLongYes || oneSidedLongNo)
        ) {
            if (oneSidedLongYes && side === 'YES') {
                this.holdsThisWindow++;
                updateDashboardState({
                    ...this.getDashboardExtras(),
                    marketSlug: market.slug,
                    windowEndIso: market.endDateIso,
                    consecutiveFailures: this.riskState.consecutiveOrderFailures,
                    pendingOrders: 0,
                    lastTick: new Date().toISOString(),
                    message: `HOLD: final ${finalSecOne}s — assume Down winning; no further Up buys until hedge restores After PnL ≥ $${minDualAfterPnlUsd(this.config).toFixed(2)} on both legs`,
                });
                return;
            }
            if (oneSidedLongNo && side === 'NO') {
                this.holdsThisWindow++;
                updateDashboardState({
                    ...this.getDashboardExtras(),
                    marketSlug: market.slug,
                    windowEndIso: market.endDateIso,
                    consecutiveFailures: this.riskState.consecutiveOrderFailures,
                    pendingOrders: 0,
                    lastTick: new Date().toISOString(),
                    message: `HOLD: final ${finalSecOne}s — assume Up winning; no further Down buys until hedge restores After PnL ≥ $${minDualAfterPnlUsd(this.config).toFixed(2)} on both legs`,
                });
                return;
            }
        }

        // First order of each window: optional recovery of last window’s net loss + base initial; skew can raise size.
        if (this.roundsThisWindow === 0) {
            const minSz = Math.max(market.orderMinSize || 0, this.config.orderMinSize || 1);
            const bid = currentBid;
            const bal = this.config.liveTrading
                ? this.cachedBalances.polymarketUsdc
                : getSimulatedBalance();
            const maxOrd = this.config.maxSingleOrderUsd ?? Number.POSITIVE_INFINITY;
            const lossFrac = this.config.firstEntryLossRecoveryFraction ?? 1;
            const capFrac = this.config.firstEntryRecoveryBalanceCapFraction ?? 0.5;
            const baseBudgetFrac =
                this.config.firstEntryBaseBudgetFraction ?? FIRST_ENTRY_PAPER_SPEND_FRACTION;

            let recoveryShares = 0;
            if (
                this.lastCompletedWindowNetProfitUsd != null &&
                this.lastCompletedWindowNetProfitUsd < 0 &&
                bid > 0
            ) {
                const lossUsd = -this.lastCompletedWindowNetProfitUsd * lossFrac;
                const budgetUsd = Math.min(lossUsd, maxOrd, bal * capFrac);
                recoveryShares = Math.floor(budgetUsd / bid);
            }

            if (pairLadderOn) {
                let mergedR = this.pickPairStockASharesForMomentum(
                    market,
                    riseInForStockA,
                    bestBidYes,
                    bestBidNo
                );
                if (skewDecision !== null) {
                    mergedR = Math.max(mergedR, skewDecision.size);
                }
                if (recoveryShares > 0) {
                    mergedR = Math.max(mergedR, recoveryShares);
                }
                mergedR = this.clampPairLadderStockAClip(market, mergedR, bestBidYes, bestBidNo);
                shares = Math.max(minSz, mergedR);
                orderReasonCode = `${orderReasonCode}|PAIR_MOM_INITIAL_${shares}sh`;
                if (recoveryShares > 0) {
                    orderReasonCode =
                        `${orderReasonCode}|LOSS_RECOVERY_LAST_NET=$${this.lastCompletedWindowNetProfitUsd!.toFixed(2)}` +
                        `|recov~${recoveryShares}sh`;
                }
            } else {
                const baseInitial = Math.floor(this.config.initialEntryShares ?? 10);
                const floorShares = Math.max(minSz, baseInitial);
                let merged = Math.max(floorShares, recoveryShares);
                if (skewDecision !== null) {
                    merged = Math.max(merged, skewDecision.size);
                }
                if (recoveryShares <= 0 && this.config.btcMarketWindowMinutes === 5) {
                    const capUsd = Math.max(0, bal * baseBudgetFrac);
                    const capSh = bid > 0 ? Math.floor(capUsd / bid) : merged;
                    merged = Math.min(merged, Math.max(capSh, floorShares));
                }
                shares = merged;
                orderReasonCode = `${orderReasonCode}|INITIAL_ENTRY_${shares}sh`;
                if (recoveryShares > 0) {
                    orderReasonCode =
                        `${orderReasonCode}|LOSS_RECOVERY_LAST_NET=$${this.lastCompletedWindowNetProfitUsd!.toFixed(2)}` +
                        `|recov~${recoveryShares}sh`;
                }
            }
        }

        // From 3rd purchase onward (round index ≥ 2): scale up Stock A clips only — never inflate Stock B
        // (hedge) or A/B share counts diverge (B must match the imbalance / prior A leg, not 2–3×).
        // Pair ladder: every Stock A leg uses the momentum-sized `[pairStockARandomSharesMin, Max]` band only — never apply the multiplier
        // (would blow past Max when the book was imbalanced because pairImbForSkip ≠ 0).
        const stockBHedgeClip = requiresMinDualAfterPnlForSimulatedBuy(state, side);
        const pairStockAClip = pairLadderOn && !stockBHedgeClip;
        if (
            this.roundsThisWindow >= 2 &&
            !alternateHedgeActive &&
            !stockBHedgeClip &&
            !pairStockAClip
        ) {
            const mult = this.config.fromThirdPurchaseClipMultiplier ?? 1.4;
            shares = Math.max(1, Math.floor(shares * mult));
            orderReasonCode = `${orderReasonCode}|FROM_ROUND3+_x${mult}`;
        }

        const diff = Math.abs(state.qtyYes - state.qtyNo);
        const tsPhCaps = this.config.tickSize || 0.01;
        const askSideCaps = side === 'YES' ? this.liveBestAskYes : this.liveBestAskNo;
        const mustHedgeLateCaps =
            inStopTradingSecondsBeforeEndWindow(
                secondsLeft,
                this.config.stopTradingSecondsBeforeEnd
            ) && diff > 0;
        const useTakerParityAllCaps =
            this.config.livePreferTakerAllEntries === true && askSideCaps > 0;
        const useTakerLiveHedgeCaps =
            askSideCaps > 0 &&
            diff > 0 &&
            requiresMinDualAfterPnlForSimulatedBuy(state, side);
        const useTakerBaseForCaps =
            useTakerParityAllCaps ||
            useTakerLiveHedgeCaps ||
            (mustHedgeLateCaps && askSideCaps > 0);
        const takerLimitPxCaps = Math.min(0.99, Math.round((askSideCaps + tsPhCaps) * 100) / 100);
        const simPriceForCaps = useTakerBaseForCaps ? takerLimitPxCaps : currentBid;
        const kSim = this.config.binaryOutcomeTakerFeeScalar ?? 0.072;
        const simRawForPairGate = simPriceForCaps;
        const simLiqForPairGate: OrderLiquidityRole = useTakerBaseForCaps ? 'TAKER' : 'MAKER';
        const simEffPerShareForSlack = buyBinaryOutcomeLegUsd(
            1,
            simRawForPairGate,
            simLiqForPairGate,
            this.config.feeBips ?? 0,
            kSim
        );

        if (skewDecision === null) {
            const minSzParity = Math.max(market.orderMinSize || 0, this.config.orderMinSize || 1);
            const zInv = 1e-8;
            const hedgeClip = requiresMinDualAfterPnlForSimulatedBuy(state, side);
            const slackBefore = shares;
            const slackMin = hedgeClip ? effectiveMinDualForSlackUsd(this.config) : 0;
            const unrestricted = this.config.unrestrictedPredictionBuys === true;
            if (!(unrestricted && !hedgeClip)) {
                shares = capClipByAfterPnlSlack(
                    state,
                    side,
                    simEffPerShareForSlack,
                    shares,
                    minSzParity,
                    slackMin
                );
            }
            if (shares !== slackBefore) {
                orderReasonCode = `${orderReasonCode}|AFTER_PNL_SLACK_${slackBefore}→${shares}`;
            }
            const extraFirst =
                this.isFirstOppositeLeg(state, side) && this.config.momentumImbalanceStrategyEnabled !== false
                    ? this.pickFirstOppositeLegExtraShares()
                    : 0;
            let sharesParity = shares;
            if (
                state.qtyYes <= zInv ||
                state.qtyNo <= zInv ||
                requiresMinDualAfterPnlForSimulatedBuy(state, side)
            ) {
                sharesParity = capClipForSettlementQtyParity(
                    state,
                    side,
                    shares,
                    minSzParity,
                    extraFirst > 0 ? { firstOppositeLegExtraShares: extraFirst } : undefined
                );
            }
            if (sharesParity !== shares) {
                orderReasonCode = `${orderReasonCode}|QTY_PARITY_CAP_${shares}→${sharesParity}`;
            }
            shares = sharesParity;
            if (pairLadderOn && hedgeClip && shares > 0) {
                const { lo: plParityLo } = this.pairStockARandomClipBounds(market, bestBidYes, bestBidNo);
                if (shares < plParityLo) {
                    const prevPs = shares;
                    shares = plParityLo;
                    orderReasonCode = `${orderReasonCode}|PAIR_LADDER_QTY_PARITY_MIN_${prevPs}→${shares}`;
                }
            }
            if (extraFirst > 0) {
                orderReasonCode = `${orderReasonCode}|FIRST_OPP_EXTRA+${extraFirst}`;
            }
        }

        // Late-window parity: cap to the exact imbalance when we're re-hedging (reference clips only).
        if (
            skewDecision === null &&
            inStopTradingSecondsBeforeEndWindow(
                secondsLeft,
                this.config.stopTradingSecondsBeforeEnd
            ) &&
            diff > 0 &&
            requiresMinDualAfterPnlForSimulatedBuy(state, side)
        ) {
            // If this hedge fill keeps both settlement outcomes profitable, allow larger clip
            // (do not force-cap to exact imbalance). Otherwise keep strict parity cap.
            const fillCostLate = buyBinaryOutcomeLegUsd(
                shares,
                simRawForPairGate,
                simLiqForPairGate,
                this.config.feeBips ?? 0,
                kSim
            );
            const commLate = takerCommissionUsdForBinaryBuy(
                shares,
                simRawForPairGate,
                simLiqForPairGate,
                this.config.feeBips ?? 0,
                kSim
            );
            const projected = updateWindowStateFromFill(state, side, shares, fillCostLate, {
                takerCommissionUsd: commLate,
            });
            const apLate = afterPnlsFromState(projected);
            const minP = minDualAfterPnlUsd(this.config);
            const strictP = minDualAfterPnlStrictAbove(this.config);
            const bothAtDualMin = dualAfterPnlMeetsMin(
                apLate.afterPnlIfUpExcludingCommission,
                apLate.afterPnlIfDownExcludingCommission,
                minP,
                strictP
            );
            if (!bothAtDualMin) {
                const { lo: plLateLo } = this.pairStockARandomClipBounds(market, bestBidYes, bestBidNo);
                const parityCap =
                    this.config.pairLadderMatchEnabled === true ? Math.max(diff, plLateLo) : diff;
                shares = Math.min(shares, parityCap);
            }
        }

        if (skewDecision === null) {
            const bypassGates =
                this.config.unrestrictedPredictionBuys === true &&
                !requiresMinDualAfterPnlForSimulatedBuy(state, side);
            const hedgeLegPairClamp = requiresMinDualAfterPnlForSimulatedBuy(state, side);
            const hedgeTargetBeforePairClamp = hedgeLegPairClamp ? shares : null;
            const clampCfgMain = alternateHedgeActive ? this.configForAlternatePairClamp() : this.config;
            const firstLegOppMain = this.oppositeAskAllInFirstLegGate(state, side, books, clampCfgMain);
            const firstLegBidMain = this.oppositeBidFirstLegGate(state, side, books);
            const clampOptsMain: {
                bypassPairCostAndSettlement?: boolean;
                oppositeAskAllInForFirstLegGate?: number;
                oppositeBidForFirstLegGate?: number;
                simulatedFillLiquidity?: OrderLiquidityRole;
            } = {
                oppositeAskAllInForFirstLegGate: firstLegOppMain,
                oppositeBidForFirstLegGate: firstLegBidMain,
                simulatedFillLiquidity: simLiqForPairGate,
            };
            if (bypassGates) clampOptsMain.bypassPairCostAndSettlement = true;
            shares = clampBuySizeForSimulatedGates(
                state,
                side,
                simRawForPairGate,
                shares,
                clampCfgMain,
                clampOptsMain
            );
            // Stock B: only match the intended hedge size when the full clip is pair-cost-valid (fee-inclusive ≤ cap).
            if (
                hedgeTargetBeforePairClamp != null &&
                hedgeTargetBeforePairClamp > 0 &&
                shares > 0 &&
                shares < hedgeTargetBeforePairClamp
            ) {
                shares = 0;
                orderReasonCode = `${orderReasonCode}|HEDGE_NO_PARTIAL_PAIR_CAP`;
            }
        }

        // Pair ladder — Stock A (not the dual-PnL hedge leg): keep every fill inside the configured clip band.
        // Skew/recovery/legacy chooseClipSize paths can still overshoot until clamped here.
        if (
            this.config.pairLadderMatchEnabled === true &&
            !requiresMinDualAfterPnlForSimulatedBuy(state, side) &&
            shares > 0
        ) {
            const beforeA = shares;
            shares = this.clampPairLadderStockAClip(market, shares, bestBidYes, bestBidNo);
            if (shares !== beforeA) {
                orderReasonCode = `${orderReasonCode}|PAIR_STOCK_A_BAND_${beforeA}→${shares}`;
            }
        }

        if (
            this.config.pairLadderMatchEnabled === true &&
            requiresMinDualAfterPnlForSimulatedBuy(state, side) &&
            shares > 0 &&
            skewDecision === null
        ) {
            const { lo: plStockBLo } = this.pairStockARandomClipBounds(market, bestBidYes, bestBidNo);
            if (shares < plStockBLo) {
                const beforeBFloor = shares;
                const bypassGatesB =
                    this.config.unrestrictedPredictionBuys === true &&
                    !requiresMinDualAfterPnlForSimulatedBuy(state, side);
                const clampCfgB = alternateHedgeActive ? this.configForAlternatePairClamp() : this.config;
                const oppB = this.oppositeAskAllInFirstLegGate(state, side, books, clampCfgB);
                const oppBidB = this.oppositeBidFirstLegGate(state, side, books);
                const clampOptsB: {
                    bypassPairCostAndSettlement?: boolean;
                    oppositeAskAllInForFirstLegGate?: number;
                    oppositeBidForFirstLegGate?: number;
                    simulatedFillLiquidity?: OrderLiquidityRole;
                } = {
                    oppositeAskAllInForFirstLegGate: oppB,
                    oppositeBidForFirstLegGate: oppBidB,
                    simulatedFillLiquidity: simLiqForPairGate,
                };
                if (bypassGatesB) clampOptsB.bypassPairCostAndSettlement = true;
                shares = clampBuySizeForSimulatedGates(
                    state,
                    side,
                    simRawForPairGate,
                    plStockBLo,
                    clampCfgB,
                    clampOptsB
                );
                if (shares > 0 && shares < plStockBLo) {
                    this.holdsThisWindow++;
                    updateDashboardState({
                        ...this.getDashboardExtras(),
                        marketSlug: market.slug,
                        windowEndIso: market.endDateIso,
                        consecutiveFailures: this.riskState.consecutiveOrderFailures,
                        pendingOrders: 0,
                        lastTick: new Date().toISOString(),
                        message:
                            `HOLD: pair Stock B — ${beforeBFloor}sh below clip floor ${plStockBLo}; ` +
                            `raised size fails pair / dual After PnL gates at fee-inclusive price`,
                    });
                    return;
                }
                if (shares !== beforeBFloor) {
                    orderReasonCode = `${orderReasonCode}|PAIR_STOCK_B_CLIP_FLOOR_${beforeBFloor}→${shares}`;
                }
            }
        }

        if (
            shares > 0 &&
            this.shouldMomentumPauseTrading(btcDelta, state, secondsLeft, side)
        ) {
            this.holdsThisWindow++;
            const pg = this.config.momentumBiasGapUsd ?? 35;
            updateDashboardState({
                ...this.getDashboardExtras(),
                marketSlug: market.slug,
                windowEndIso: market.endDateIso,
                consecutiveFailures: this.riskState.consecutiveOrderFailures,
                pendingOrders: 0,
                lastTick: new Date().toISOString(),
                message: `HOLD: momentum pause — BTC gap ${
                    btcDelta != null && Number.isFinite(btcDelta) ? btcDelta.toFixed(1) : 'n/a'
                } USD vs open; no extra Up while Up-favored (gap ≥ $${pg}) and time > ${
                    this.config.momentumPauseMinSecondsLeft ?? 0
                }s left rule`,
            });
            return;
        }
        if (shares <= 0) {
            this.holdsThisWindow++;
            const minD = minDualAfterPnlUsd(this.config);
            const cmp = minDualAfterPnlStrictAbove(this.config) ? '>' : '≥';
            const hedgeLeg = requiresMinDualAfterPnlForSimulatedBuy(state, side);
            updateDashboardState({
                ...this.getDashboardExtras(),
                marketSlug: market.slug,
                windowEndIso: market.endDateIso,
                consecutiveFailures: this.riskState.consecutiveOrderFailures,
                pendingOrders: 0,
                lastTick: new Date().toISOString(),
                message: hedgeLeg
                    ? `HOLD: ladder Stock B — no clip satisfies dual After PnL If Up/Down ${cmp} $${minD.toFixed(2)} ` +
                      `and pair cost ≤ min(safetyMargin, targetPairCostMax) with fee-inclusive simulated price`
                    : 'HOLD: ladder Stock A — no clip satisfies CLOB / orderMin / non–pair-cost gates',
            });
            return;
        }

        // ══════════════════════════════════════════════════════════════════
        // ██  PHASE 7: Balance, CLOB minimum, and risk checks             ██
        // ══════════════════════════════════════════════════════════════════
        /** When imbalanced one-sided and both After PnLs verify at ask, optional FOK @ ask (config). */
        let useTakerDualVerified = false;
        const qEps = 1e-8;
        if (this.config.takerWhenDualOutcomeVerified && shares > 0) {
            const oneSided =
                (state.qtyYes > qEps && state.qtyNo <= qEps) ||
                (state.qtyNo > qEps && state.qtyYes <= qEps);
            const hedgeLeg =
                oneSided &&
                ((state.qtyYes > state.qtyNo + qEps && side === 'NO') ||
                    (state.qtyNo > state.qtyYes + qEps && side === 'YES'));
            if (hedgeLeg) {
                const askPx = side === 'YES' ? this.liveBestAskYes : this.liveBestAskNo;
                if (askPx > 0 && isDualOutcomeProfitableFill(state, side, shares, askPx, this.config)) {
                    useTakerDualVerified = true;
                    orderReasonCode = `${orderReasonCode}|DUAL_OUTCOME_VERIFIED_TAKER`;
                }
            }
        }

        const mustHedgeLate =
            inStopTradingSecondsBeforeEndWindow(
                secondsLeft,
                this.config.stopTradingSecondsBeforeEnd
            ) && diff > 0;
        const askSide = side === 'YES' ? this.liveBestAskYes : this.liveBestAskNo;
        const useTakerParityAll =
            this.config.livePreferTakerAllEntries === true && askSide > 0;
        const useTakerLiveHedge =
            askSide > 0 && diff > 0 && requiresMinDualAfterPnlForSimulatedBuy(state, side);
        const useTaker =
            useTakerParityAll ||
            useTakerLiveHedge ||
            (mustHedgeLate && askSide > 0) ||
            (useTakerDualVerified && askSide > 0);
        if (useTakerParityAll) {
            orderReasonCode = `${orderReasonCode}|PARITY_TAKER_ALL`;
        } else if (useTakerLiveHedge) {
            orderReasonCode = `${orderReasonCode}|HEDGE_TAKER`;
        }
        const tsPh = this.config.tickSize || 0.01;
        const takerLimitPx = Math.min(0.99, Math.round((askSide + tsPh) * 100) / 100);
        let fillPriceAcct = useTaker ? takerLimitPx : currentBid;
        if (useTakerDualVerified && skewDecision === null) {
            const bypassGates =
                this.config.unrestrictedPredictionBuys === true &&
                !requiresMinDualAfterPnlForSimulatedBuy(state, side);
            const hedgePreDual = requiresMinDualAfterPnlForSimulatedBuy(state, side) ? shares : null;
            const clampCfgDv = alternateHedgeActive ? this.configForAlternatePairClamp() : this.config;
            const oppDv = this.oppositeAskAllInFirstLegGate(state, side, books, clampCfgDv);
            const oppBidDv = this.oppositeBidFirstLegGate(state, side, books);
            const clampOptsDv: {
                bypassPairCostAndSettlement?: boolean;
                oppositeAskAllInForFirstLegGate?: number;
                oppositeBidForFirstLegGate?: number;
                simulatedFillLiquidity?: OrderLiquidityRole;
            } = {
                oppositeAskAllInForFirstLegGate: oppDv,
                oppositeBidForFirstLegGate: useTaker ? undefined : oppBidDv,
                simulatedFillLiquidity: useTaker ? 'TAKER' : 'MAKER',
            };
            if (bypassGates) clampOptsDv.bypassPairCostAndSettlement = true;
            shares = clampBuySizeForSimulatedGates(
                state,
                side,
                fillPriceAcct,
                shares,
                clampCfgDv,
                clampOptsDv
            );
            if (
                hedgePreDual != null &&
                hedgePreDual > 0 &&
                shares > 0 &&
                shares < hedgePreDual
            ) {
                shares = 0;
                orderReasonCode = `${orderReasonCode}|HEDGE_NO_PARTIAL_DUAL_VERIFIED`;
            }
        }
        const minSzPhase7 = Math.max(market.orderMinSize || 0, this.config.orderMinSize || 1);
        const beforeUsdClip = shares;
        shares = this.capSingleLegSharesByMaxUsdAndMaxClip(shares, fillPriceAcct, market);
        if (shares !== beforeUsdClip) {
            orderReasonCode = `${orderReasonCode}|MAX_CLIP_MAX_USD_${beforeUsdClip}→${shares}`;
        }

        /**
         * Pair-ladder **Stock A** sizing uses bid hints in `pairStockARandomClipBounds`, but Phase 7 caps use
         * `fillPriceAcct` (often taker ask + fee scalar). That can shrink the clip **below**
         * `pairStockARandomSharesMin` while still ≥ CLOB `orderMinSize` (e.g. 5) — producing illegal small Stock A
         * orders. Repair: try the band floor at the real execution price; if it still does not fit `maxSingleOrderUsd`
         * / `maxClipShares`, hold instead of submitting an undersized Stock A leg.
         * Stock B uses the same USD repair so `maxSingleOrderUsd` cannot leave a sub-min clip on the book.
         */
        const pairStockALeg =
            this.config.pairLadderMatchEnabled === true &&
            !requiresMinDualAfterPnlForSimulatedBuy(state, side);
        const pairStockBLegUsd =
            this.config.pairLadderMatchEnabled === true &&
            requiresMinDualAfterPnlForSimulatedBuy(state, side);
        if (pairStockALeg && shares > 0) {
            const { lo: pairStockALo } = this.pairStockARandomClipBounds(market, bestBidYes, bestBidNo);
            if (shares < pairStockALo) {
                const beforeRepair = shares;
                const bumped = this.clampPairLadderStockAClip(market, pairStockALo, bestBidYes, bestBidNo);
                const afterBump = this.capSingleLegSharesByMaxUsdAndMaxClip(bumped, fillPriceAcct, market);
                if (afterBump >= pairStockALo) {
                    shares = afterBump;
                    orderReasonCode = `${orderReasonCode}|PAIR_STOCK_A_FLOOR_REPAIR_${beforeRepair}→${shares}`;
                } else {
                    this.holdsThisWindow++;
                    updateDashboardState({
                        ...this.getDashboardExtras(),
                        marketSlug: market.slug,
                        windowEndIso: market.endDateIso,
                        consecutiveFailures: this.riskState.consecutiveOrderFailures,
                        pendingOrders: this.pendingOrderCount(),
                        lastTick: new Date().toISOString(),
                        message:
                            `HOLD: pair Stock A — ${beforeRepair} sh after maxSingleOrder/maxClip @ fill ~$${fillPriceAcct.toFixed(4)} ` +
                            `< pair clip floor ${pairStockALo} (pairStockARandomSharesMin band); raise maxSingleOrderUsd / maxClipShares or widen price room`,
                    });
                    return;
                }
            }
        } else if (pairStockBLegUsd && shares > 0) {
            const { lo: pairStockBLoUsd } = this.pairStockARandomClipBounds(market, bestBidYes, bestBidNo);
            if (shares < pairStockBLoUsd) {
                const beforeRepairB = shares;
                const afterBumpB = this.capSingleLegSharesByMaxUsdAndMaxClip(pairStockBLoUsd, fillPriceAcct, market);
                if (afterBumpB >= pairStockBLoUsd) {
                    shares = afterBumpB;
                    orderReasonCode = `${orderReasonCode}|PAIR_STOCK_B_FLOOR_USD_${beforeRepairB}→${shares}`;
                } else {
                    this.holdsThisWindow++;
                    updateDashboardState({
                        ...this.getDashboardExtras(),
                        marketSlug: market.slug,
                        windowEndIso: market.endDateIso,
                        consecutiveFailures: this.riskState.consecutiveOrderFailures,
                        pendingOrders: this.pendingOrderCount(),
                        lastTick: new Date().toISOString(),
                        message:
                            `HOLD: pair Stock B — ${beforeRepairB} sh after maxSingleOrder/maxClip @ fill ~$${fillPriceAcct.toFixed(4)} ` +
                            `< clip floor ${pairStockBLoUsd}; raise maxSingleOrderUsd / maxClipShares`,
                    });
                    return;
                }
            }
        }

        if (shares <= 0) {
            this.holdsThisWindow++;
            updateDashboardState({
                ...this.getDashboardExtras(),
                marketSlug: market.slug,
                windowEndIso: market.endDateIso,
                consecutiveFailures: this.riskState.consecutiveOrderFailures,
                pendingOrders: this.pendingOrderCount(),
                lastTick: new Date().toISOString(),
                message: 'HOLD: taker / dual-verified sizing clamped to 0 shares',
            });
            return;
        }
        let minSzEffPhase7 = minSzPhase7;
        let plLoPhase7Msg = 0;
        if (this.config.pairLadderMatchEnabled === true) {
            const { lo: plLoPh7 } = this.pairStockARandomClipBounds(market, bestBidYes, bestBidNo);
            plLoPhase7Msg = plLoPh7;
            minSzEffPhase7 = Math.max(minSzPhase7, plLoPh7);
        }
        if (shares > 0 && shares < minSzEffPhase7) {
            this.holdsThisWindow++;
            updateDashboardState({
                ...this.getDashboardExtras(),
                marketSlug: market.slug,
                windowEndIso: market.endDateIso,
                consecutiveFailures: this.riskState.consecutiveOrderFailures,
                pendingOrders: this.pendingOrderCount(),
                lastTick: new Date().toISOString(),
                message:
                    this.config.pairLadderMatchEnabled === true
                        ? `HOLD: after maxClip/maxSingle cap — ${shares} sh < pair-ladder effective min ${minSzEffPhase7} (orderMin ${minSzPhase7}, clip floor ${plLoPhase7Msg})`
                        : `HOLD: after maxClip/maxSingle cap — ${shares} sh < order minimum ${minSzPhase7}`,
            });
            return;
        }
        const recomputePhase7OrderCost = (): number =>
            buyBinaryOutcomeLegUsd(
                shares,
                fillPriceAcct,
                useTaker ? 'TAKER' : 'MAKER',
                this.config.feeBips ?? 0,
                this.config.binaryOutcomeTakerFeeScalar ?? 0
            );
        let orderCost = recomputePhase7OrderCost();

        if (orderCost < 1.0) {
            this.holdsThisWindow++;
            updateDashboardState({
                ...this.getDashboardExtras(),
                marketSlug: market.slug,
                windowEndIso: market.endDateIso,
                consecutiveFailures: this.riskState.consecutiveOrderFailures,
                pendingOrders: 0,
                lastTick: new Date().toISOString(),
                message: `HOLD: order $${orderCost.toFixed(2)} < $1.00 CLOB minimum`,
            });
            return;
        }

        if (this.cachedBalances.polymarketUsdc < orderCost + 0.25) {
            this.holdsThisWindow++;
            updateDashboardState({
                ...this.getDashboardExtras(),
                marketSlug: market.slug,
                windowEndIso: market.endDateIso,
                consecutiveFailures: this.riskState.consecutiveOrderFailures,
                pendingOrders: 0,
                lastTick: new Date().toISOString(),
                message: `HOLD: insufficient balance ($${this.cachedBalances.polymarketUsdc.toFixed(2)}) for $${orderCost.toFixed(2)} order`,
            });
            return;
        }

        const riskCheck = canPlaceOrder(this.config, this.riskState, state, orderCost);
        if (!riskCheck.allowed) {
            this.holdsThisWindow++;
            const acct = this.getAccountingSnapshot(state);
            logEntry(
                {
                    timestamp: new Date().toISOString(),
                    marketSlug: state.marketSlug,
                    windowEndIso: state.windowEndIso,
                    pairCost: state.pairCost,
                    qtyYes: state.qtyYes,
                    qtyNo: state.qtyNo,
                    costYes: state.costYes,
                    costNo: state.costNo,
                    lockedProfit: state.lockedProfit,
                    totalSpentUsd: state.totalSpentUsd,
                    event: 'risk_blocked',
                    message: riskCheck.reason,
                    feeBipsAssumption: this.config.feeBips,
                    ...acct,
                },
                !q
            );
            updateDashboardState({
                ...this.getDashboardExtras(),
                marketSlug: market.slug,
                windowEndIso: market.endDateIso,
                consecutiveFailures: this.riskState.consecutiveOrderFailures,
                pendingOrders: 0,
                lastTick: new Date().toISOString(),
                message: `RISK: ${riskCheck.reason}`,
            });
            return;
        }

        let stateForPhase8Fill = state;
        if (useTaker && this.config.liveTrading) {
            const pre = await this.preflightLiveTakerClip(
                market,
                q,
                side,
                shares,
                alternateHedgeActive
            );
            if (!pre.ok) {
                this.holdsThisWindow++;
                updateDashboardState({
                    ...this.getDashboardExtras(),
                    marketSlug: market.slug,
                    windowEndIso: market.endDateIso,
                    consecutiveFailures: this.riskState.consecutiveOrderFailures,
                    pendingOrders: this.pendingOrderCount(),
                    lastTick: new Date().toISOString(),
                    message: `HOLD: live taker preflight — ${pre.reason}`,
                });
                return;
            }
            shares = pre.shares;
            fillPriceAcct = pre.takerLimitPx;
            orderCost = recomputePhase7OrderCost();
            stateForPhase8Fill = pre.stateBefore;
            if (orderCost < 1.0) {
                this.holdsThisWindow++;
                updateDashboardState({
                    ...this.getDashboardExtras(),
                    marketSlug: market.slug,
                    windowEndIso: market.endDateIso,
                    consecutiveFailures: this.riskState.consecutiveOrderFailures,
                    pendingOrders: 0,
                    lastTick: new Date().toISOString(),
                    message: `HOLD: order $${orderCost.toFixed(2)} < $1 (after preflight)`,
                });
                return;
            }
            if (this.cachedBalances.polymarketUsdc < orderCost + 0.25) {
                this.holdsThisWindow++;
                updateDashboardState({
                    ...this.getDashboardExtras(),
                    marketSlug: market.slug,
                    windowEndIso: market.endDateIso,
                    consecutiveFailures: this.riskState.consecutiveOrderFailures,
                    pendingOrders: 0,
                    lastTick: new Date().toISOString(),
                    message: `HOLD: insufficient balance after preflight for $${orderCost.toFixed(2)}`,
                });
                return;
            }
            const maxOrderPf = this.config.maxSingleOrderUsd ?? Number.POSITIVE_INFINITY;
            if (Number.isFinite(maxOrderPf) && maxOrderPf > 0 && orderCost > maxOrderPf + 1e-6) {
                const shPf0 = shares;
                shares = this.capSingleLegSharesByMaxUsdAndMaxClip(shares, fillPriceAcct, market);
                orderCost = recomputePhase7OrderCost();
                if (shPf0 !== shares) {
                    orderReasonCode = `${orderReasonCode}|MAX_CLIP_MAX_USD_POSTPF_${shPf0}→${shares}`;
                }
            }
            if (shares > 0 && shares < minSzEffPhase7) {
                this.holdsThisWindow++;
                updateDashboardState({
                    ...this.getDashboardExtras(),
                    marketSlug: market.slug,
                    windowEndIso: market.endDateIso,
                    consecutiveFailures: this.riskState.consecutiveOrderFailures,
                    pendingOrders: 0,
                    lastTick: new Date().toISOString(),
                    message:
                        this.config.pairLadderMatchEnabled === true
                            ? `HOLD: after preflight cap — ${shares} sh < pair-ladder effective min ${minSzEffPhase7} (orderMin ${minSzPhase7}, clip ${plLoPhase7Msg})`
                            : `HOLD: after preflight cap — ${shares} sh < order minimum ${minSzPhase7}`,
                });
                return;
            }
            if (orderCost < 1.0) {
                this.holdsThisWindow++;
                updateDashboardState({
                    ...this.getDashboardExtras(),
                    marketSlug: market.slug,
                    windowEndIso: market.endDateIso,
                    consecutiveFailures: this.riskState.consecutiveOrderFailures,
                    pendingOrders: 0,
                    lastTick: new Date().toISOString(),
                    message: `HOLD: order $${orderCost.toFixed(2)} < $1 after preflight re-cap`,
                });
                return;
            }
            const risk2 = canPlaceOrder(this.config, this.riskState, stateForPhase8Fill, orderCost);
            if (!risk2.allowed) {
                this.holdsThisWindow++;
                updateDashboardState({
                    ...this.getDashboardExtras(),
                    marketSlug: market.slug,
                    windowEndIso: market.endDateIso,
                    consecutiveFailures: this.riskState.consecutiveOrderFailures,
                    pendingOrders: 0,
                    lastTick: new Date().toISOString(),
                    message: `RISK (preflight): ${risk2.reason}`,
                });
                return;
            }
        }

        const stockAStyleLeg = !requiresMinDualAfterPnlForSimulatedBuy(state, side);
        if (stockAStyleLeg && shares > 0) {
            const rawExecPx = useTaker ? fillPriceAcct : currentBid;
            const lo = this.config.pairStockARawPriceMin ?? 0.2;
            const hi = this.config.pairStockARawPriceMax ?? 0.9;
            if (
                rawExecPx > 0 &&
                Number.isFinite(rawExecPx) &&
                (rawExecPx < lo - 1e-9 || rawExecPx > hi + 1e-9)
            ) {
                this.holdsThisWindow++;
                updateDashboardState({
                    ...this.getDashboardExtras(),
                    marketSlug: market.slug,
                    windowEndIso: market.endDateIso,
                    consecutiveFailures: this.riskState.consecutiveOrderFailures,
                    pendingOrders: this.pendingOrderCount(),
                    lastTick: new Date().toISOString(),
                    message:
                        `HOLD: Stock A — ${useTaker ? 'taker limit' : 'bid'} ref $${rawExecPx.toFixed(4)} outside ` +
                        `[${lo}, ${hi}] (pair-cost sim uses fee-inclusive taker $/sh when applicable)`,
                });
                return;
            }
        }

        if (this.config.pairLadderMatchEnabled === true && shares > 0) {
            const { lo: plFloorPh8 } = this.pairStockARandomClipBounds(market, bestBidYes, bestBidNo);
            if (shares < plFloorPh8) {
                this.holdsThisWindow++;
                updateDashboardState({
                    ...this.getDashboardExtras(),
                    marketSlug: market.slug,
                    windowEndIso: market.endDateIso,
                    consecutiveFailures: this.riskState.consecutiveOrderFailures,
                    pendingOrders: this.pendingOrderCount(),
                    lastTick: new Date().toISOString(),
                    message:
                        `HOLD: pair-ladder — ${shares} sh < clip floor ${plFloorPh8} (pairStockARandomSharesMin band); ` +
                        `raise maxSingleOrderUsd / maxClipShares or fix sizing`,
                });
                return;
            }
        }

        // ══════════════════════════════════════════════════════════════════
        // ██  PHASE 8: Place limit buy order                              ██
        // ══════════════════════════════════════════════════════════════════
        const roundNum = this.roundsThisWindow + 1;
        const targetInfo = `round ${roundNum} | ${market.btcMarketWindowMinutes}m window`;

        qlog(
            q,
            `[Buy #${roundNum}] ${sideLabel} ${shares}sh @ $${fillPriceAcct.toFixed(2)} ($${orderCost.toFixed(2)}) | ${targetInfo}` +
                (useTaker ? ' | FOK(ask)' : ' | limit(bid)')
        );

        const bookSnapPhase8 =
            useTaker && this.config.liveTrading
                ? {
                      bestBidYes: this.liveBestBidYes,
                      bestBidNo: this.liveBestBidNo,
                      bestAskYes: this.liveBestAskYes,
                      bestAskNo: this.liveBestAskNo,
                  }
                : {
                      bestBidYes,
                      bestBidNo,
                      bestAskYes: books !== null ? books.bookYes.bestAsk ?? 0 : 0,
                      bestAskNo: books !== null ? books.bookNo.bestAsk ?? 0 : 0,
                  };

        if (useTaker) {
            let instantResult: OrderResult | undefined;
            if (this.config.liveTrading) {
                const askLive =
                    side === 'YES' ? this.liveBestAskYes : this.liveBestAskNo;
                instantResult = await buyInstant(
                    this.client,
                    tokenId,
                    askLive > 0 ? askLive : askSide,
                    shares,
                    this.config,
                    !!market.negRisk,
                    { marketConditionId: market.conditionId }
                );
                if (
                    !instantResult.success ||
                    !instantResult.orderId ||
                    instantResult.orderId === 'unknown'
                ) {
                    this.riskState = recordOrderFailure(this.riskState);
                    console.error(`[Bot] ${sideLabel} FOK order failed: ${instantResult.error}`);
                    return;
                }
            }
            const acct = this.resolveLiveFokAccounting(this.config.liveTrading, instantResult, {
                shares,
                price: fillPriceAcct,
                costUsd: orderCost,
            });
            if (this.config.pairLadderMatchEnabled === true && this.config.liveTrading && acct.shares > 0) {
                const { lo: plFokWarn } = this.pairStockARandomClipBounds(
                    market,
                    bestBidYes,
                    bestBidNo
                );
                if (acct.shares < plFokWarn) {
                    qlog(
                        q,
                        `[WARN] FOK fill ${acct.shares} sh < pair-ladder floor ${plFokWarn} (venue vs request); check chain sync`
                    );
                }
            }
            await this.applyBuyFillAccountingUnified(
                market,
                stateForPhase8Fill,
                side,
                acct.shares,
                acct.price,
                acct.costUsd,
                bookSnapPhase8,
                orderReasonCode,
                'tick',
                (ws) =>
                    `Buy #${roundNum}: ${sideLabel} ${acct.shares}@$${acct.price.toFixed(4)} | pairCost=$${ws.pairCost.toFixed(4)} | Up=${ws.qtyYes} Down=${ws.qtyNo}`,
                q,
                { phase8EntryReasonCode: orderReasonCode, liquidity: 'TAKER' }
            );
        } else if (this.config.liveTrading) {
            const result = await placeLimitBuyOrder(
                this.client,
                tokenId,
                currentBid,
                shares,
                this.config,
                !!market.negRisk
            );
            if (result.success && result.orderId && result.orderId !== 'unknown') {
                this.activePendingOrder = createPendingOrder(
                    result.orderId,
                    tokenId,
                    side,
                    currentBid,
                    shares
                );
                this.activePendingOrderReasonCode = orderReasonCode;
                this.riskState = resetCircuitBreaker(this.riskState);
                logWindowState(
                    state,
                    'order_placed',
                    `Buy #${roundNum}: ${sideLabel} ${shares}@$${currentBid.toFixed(2)} | ${targetInfo} | limit(bid)`,
                    {
                        feeBipsAssumption: this.config.feeBips,
                        quietConsole: q,
                        ...this.getAccountingSnapshot(state),
                    }
                );
                this.lastBalanceFetchTs = 0;
                this.lastPositionFetchTs = 0;
            } else {
                this.riskState = recordOrderFailure(this.riskState);
                console.error(`[Bot] ${sideLabel} order failed: ${result.error}`);
                return;
            }
        } else if (!this.config.liveTrading && pairHedgeMode) {
            if (this.paperSimulatedMakerOrder) {
                this.abandonPaperSimulatedMaker();
            }
            const sh = Math.floor(Math.max(1, shares) + 1e-9);
            if (this.config.pairLadderMatchEnabled === true) {
                const { lo: plPaperPairHedge } = this.pairStockARandomClipBounds(
                    market,
                    bestBidYes,
                    bestBidNo
                );
                if (sh < plPaperPairHedge) {
                    this.holdsThisWindow++;
                    updateDashboardState({
                        ...this.getDashboardExtras(),
                        marketSlug: market.slug,
                        windowEndIso: market.endDateIso,
                        consecutiveFailures: this.riskState.consecutiveOrderFailures,
                        pendingOrders: this.pendingOrderCount(),
                        lastTick: new Date().toISOString(),
                        message: `HOLD: paper pair hedge — ${sh} sh < clip floor ${plPaperPairHedge}`,
                    });
                    return;
                }
            }
            const fillPx = currentBid;
            const costUsd = fillPx * sh;
            await this.applyBuyFillAccountingUnified(
                market,
                this.windowState!,
                side,
                sh,
                fillPx,
                costUsd,
                bookSnapPhase8,
                orderReasonCode,
                'order_placed',
                (ws) =>
                    `PAPER pair hedge (instant @ bid): ${sideLabel} ${sh}@$${fillPx.toFixed(4)} | pairCost=$${ws.pairCost.toFixed(4)} | Up=${ws.qtyYes} Down=${ws.qtyNo}`,
                q,
                { phase8EntryReasonCode: orderReasonCode, liquidity: 'MAKER' }
            );
        } else {
            this.paperSimulatedMakerOrder = createPendingOrder(
                `paper-sim-${Date.now()}`,
                tokenId,
                side,
                currentBid,
                shares
            );
            this.paperSimulatedMakerReasonCode = orderReasonCode;
            this.riskState = resetCircuitBreaker(this.riskState);
            logWindowState(
                state,
                'order_placed',
                `PAPER sim: Buy #${roundNum}: ${sideLabel} ${shares}@$${currentBid.toFixed(2)} | ${targetInfo} | limit(bid) resting`,
                {
                    feeBipsAssumption: this.config.feeBips,
                    quietConsole: q,
                    ...this.getAccountingSnapshot(state),
                }
            );
            this.lastBalanceFetchTs = 0;
            this.lastPositionFetchTs = 0;
        }

        // ── Dashboard update after order ─────────────────────────────────
        const ws = this.windowState!;

        updateDashboardState({
            ...this.getDashboardExtras(),
            marketSlug: market.slug,
            windowEndIso: market.endDateIso,
            consecutiveFailures: this.riskState.consecutiveOrderFailures,
            pendingOrders: this.pendingOrderCount(),
            lastTick: new Date().toISOString(),
            message:
                `Buy #${roundNum}: ${sideLabel} ${shares}@$${fillPriceAcct.toFixed(2)} ($${orderCost.toFixed(2)}) | ` +
                `${market.btcMarketWindowMinutes}m | Up=${ws.qtyYes} Down=${ws.qtyNo} pairCost=$${ws.pairCost.toFixed(4)}`,
        });
        this.options.onStateChange?.(ws, this.riskState);
    }

    private enqueueManualBuy<T>(fn: () => Promise<T>): Promise<T> {
        const next = this.manualBuyQueue.then(fn, fn) as Promise<T>;
        this.manualBuyQueue = next.catch(() => {}).then(() => {});
        return next;
    }

    /**
     * Cancel resting bot order, align `windowState` to this market, and in live mode refresh
     * inventory from chain so manual / auto actions use real positions.
     */
    private async ensureManualBuyContext(market: ActiveMarket, q: boolean): Promise<void> {
        if (this.activePendingOrder) {
            try {
                await this.client.cancelOrder({ orderID: this.activePendingOrder.orderId });
            } catch {
                /* best-effort */
            }
            this.activePendingOrder = null;
        }
        if (
            !this.windowState ||
            this.windowState.conditionId !== market.conditionId ||
            this.windowState.windowEndIso !== market.endDateIso
        ) {
            this.windowState = createEmptyWindowState(
                market.slug,
                market.conditionId,
                market.endDateIso,
                { yesTokenId: market.yesTokenId, noTokenId: market.noTokenId }
            );
        } else {
            this.syncWindowTokenIdsFromActiveMarket(market);
        }
        if (this.config.liveTrading) {
            await this.refreshLiveInventoryFromChain(market, q);
        }
    }

    /**
     * Plan FOK on the lighter leg from the given YES/NO share counts (live: use chain-synced
     * `windowState` after `ensureManualBuyContext`). Same size as the heavy side when one-sided.
     */
    private planAutoOppositeFromQuantities(
        qtyYes: number,
        qtyNo: number
    ):
        | { ok: true; side: 'YES' | 'NO'; shares: number; analysis: AutoOppositeAnalysis }
        | { ok: false; error: string; analysis?: AutoOppositeAnalysis } {
        const ws = this.windowState;
        if (!ws) {
            return { ok: false, error: 'No position state yet — wait for the bot to load this window.' };
        }
        const eps = 1e-8;
        const ap = afterPnlsFromState(ws);
        const base = (): AutoOppositeAnalysis => ({
            qtyYes,
            qtyNo,
            avgYes: ws.avgYes,
            avgNo: ws.avgNo,
            pairCost: ws.pairCost,
            totalSpentUsd: ws.totalSpentUsd,
            afterPnlIfUp: ap.afterPnlIfUp,
            afterPnlIfDown: ap.afterPnlIfDown,
            lockedProfit: ws.lockedProfit,
            plannedSide: 'YES',
            plannedShares: 0,
            reason: '',
        });

        if (qtyYes > eps && qtyNo <= eps) {
            const sh = Math.floor(qtyYes);
            if (sh < 1) {
                return {
                    ok: false,
                    error: 'UP position too small to hedge (need ≥1 share).',
                    analysis: { ...base(), plannedSide: 'NO', plannedShares: sh, reason: '—' },
                };
            }
            return {
                ok: true,
                side: 'NO',
                shares: sh,
                analysis: {
                    ...base(),
                    plannedSide: 'NO',
                    plannedShares: sh,
                    reason: `One-sided UP: hedge with ${sh} DOWN (same share count).`,
                },
            };
        }
        if (qtyNo > eps && qtyYes <= eps) {
            const sh = Math.floor(qtyNo);
            if (sh < 1) {
                return {
                    ok: false,
                    error: 'DOWN position too small to hedge (need ≥1 share).',
                    analysis: { ...base(), plannedSide: 'YES', plannedShares: sh, reason: '—' },
                };
            }
            return {
                ok: true,
                side: 'YES',
                shares: sh,
                analysis: {
                    ...base(),
                    plannedSide: 'YES',
                    plannedShares: sh,
                    reason: `One-sided DOWN: hedge with ${sh} UP (same share count).`,
                },
            };
        }
        if (qtyYes > eps && qtyNo > eps) {
            const diff = Math.abs(qtyYes - qtyNo);
            const sh = Math.floor(diff);
            if (sh < 1) {
                const a = {
                    ...base(),
                    plannedSide: 'YES' as const,
                    plannedShares: 0,
                    reason: 'Both legs held and quantities already balanced.',
                };
                return {
                    ok: false,
                    error: 'Already balanced — no auto hedge needed.',
                    analysis: a,
                };
            }
            const side: 'YES' | 'NO' = qtyYes > qtyNo ? 'NO' : 'YES';
            return {
                ok: true,
                side,
                shares: sh,
                analysis: {
                    ...base(),
                    plannedSide: side,
                    plannedShares: sh,
                    reason:
                        qtyYes > qtyNo
                            ? `More UP than DOWN — buy ${sh} DOWN to match.`
                            : `More DOWN than UP — buy ${sh} UP to match.`,
                },
            };
        }
        return {
            ok: false,
            error: 'No shares held — open a position first or use Buy now.',
            analysis: { ...base(), plannedSide: 'YES', plannedShares: 0, reason: 'Empty book.' },
        };
    }

    /**
     * Dashboard: queue an FOK on the opposite leg from current inventory (same size as example:
     * 30 UP → buy 30 DOWN). Includes settlement P/L snapshot in the response.
     */
    executeManualAutoOppositeBuy(): Promise<ManualAutoOppositeResult> {
        return this.enqueueManualBuy<ManualAutoOppositeResult>(async () => {
            const q = !!this.config.quietConsole;
            const market = await this.getMarket();
            if (!market) {
                return { ok: false, error: 'No active BTC Up/Down market.' };
            }
            await this.ensureManualBuyContext(market, q);
            const ws = this.windowState;
            if (!ws) {
                return { ok: false, error: 'No position state after market sync.' };
            }
            const planned = this.planAutoOppositeFromQuantities(ws.qtyYes, ws.qtyNo);
            if (!planned.ok) {
                return { ok: false, error: planned.error, analysis: planned.analysis };
            }
            const r = await this.runManualBuyBody(planned.side, planned.shares, 'MANUAL_AUTO_OPPOSITE');
            return { ...r, analysis: planned.analysis };
        });
    }

    /**
     * Dashboard-only force buy: immediate FOK at best ask (+1 tick, cap 0.99) for the requested size.
     * Cancels any resting bot order, aligns `windowState` to the active market, and in live mode
     * syncs inventory from chain before submitting. Does not run strategy pair-cost / risk gates.
     */
    async executeManualBuy(side: 'YES' | 'NO', shares: number): Promise<ManualBuyResult> {
        return this.enqueueManualBuy(() => this.runManualBuyBody(side, shares, 'MANUAL_BUY'));
    }

    private async runManualBuyBody(
        side: 'YES' | 'NO',
        shares: number,
        orderHistoryReasonCode: string = 'MANUAL_BUY'
    ): Promise<ManualBuyResult> {
        const q = !!this.config.quietConsole;
        this.manualBuyInProgress = true;
        try {
            const sh = Math.floor(Number(shares));
            if (!Number.isFinite(sh) || sh <= 0) {
                return { ok: false, error: 'Shares must be a positive whole number.' };
            }

            const market = await this.getMarket();
            if (!market) {
                return { ok: false, error: 'No active BTC Up/Down market.' };
            }

            await this.ensureManualBuyContext(market, q);
            const state = this.windowState!;

            const books = await getBothOrderBooks(this.client, market, this.orderbookWs);
            const askYes = books.bookYes.bestAsk ?? 0;
            const askNo = books.bookNo.bestAsk ?? 0;
            const bidYes = books.bookYes.bestBid ?? 0;
            const bidNo = books.bookNo.bestBid ?? 0;
            const ask = side === 'YES' ? askYes : askNo;
            const tokenId = side === 'YES' ? market.yesTokenId : market.noTokenId;

            if (!(ask > 0)) {
                const spentBefore = state.totalSpentUsd;
                return {
                    ok: false,
                    error: `No ask liquidity for ${side === 'YES' ? 'Up (YES)' : 'Down (NO)'}.`,
                    snapshot: {
                        side,
                        sharesRequested: sh,
                        bestAskYes: askYes,
                        bestAskNo: askNo,
                        bestBidYes: bidYes,
                        bestBidNo: bidNo,
                        askUsed: ask,
                        estCostUsd: 0,
                        qtyYesBefore: state.qtyYes,
                        qtyNoBefore: state.qtyNo,
                        totalSpentUsdBefore: spentBefore,
                        afterPnlIfUpBefore: state.qtyYes - spentBefore,
                        afterPnlIfDownBefore: state.qtyNo - spentBefore,
                        afterPnlIfUpProjected: state.qtyYes - spentBefore,
                        afterPnlIfDownProjected: state.qtyNo - spentBefore,
                        timestampIso: new Date().toISOString(),
                        liveTrading: this.config.liveTrading,
                    },
                };
            }

            const tsMan = this.config.tickSize || 0.01;
            const limitPxManual = Math.min(0.99, Math.round((ask + tsMan) * 100) / 100);
            const feeBMan = this.config.feeBips ?? 0;
            const kMan = this.config.binaryOutcomeTakerFeeScalar ?? 0;
            const estCost =
                !this.config.liveTrading && kMan > 0
                    ? buyBinaryOutcomeLegUsd(sh, limitPxManual, 'TAKER', feeBMan, kMan)
                    : limitPxManual * sh;

            const spentBefore = state.totalSpentUsd;
            const newSpentProj = spentBefore + estCost;
            const snap: ManualBuySnapshot = {
                side,
                sharesRequested: sh,
                bestAskYes: askYes,
                bestAskNo: askNo,
                bestBidYes: bidYes,
                bestBidNo: bidNo,
                askUsed: ask,
                estCostUsd: estCost,
                qtyYesBefore: state.qtyYes,
                qtyNoBefore: state.qtyNo,
                totalSpentUsdBefore: spentBefore,
                afterPnlIfUpBefore: state.qtyYes - spentBefore,
                afterPnlIfDownBefore: state.qtyNo - spentBefore,
                afterPnlIfUpProjected: state.qtyYes + (side === 'YES' ? sh : 0) - newSpentProj,
                afterPnlIfDownProjected: state.qtyNo + (side === 'NO' ? sh : 0) - newSpentProj,
                timestampIso: new Date().toISOString(),
                liveTrading: this.config.liveTrading,
            };

            this.liveBestAskYes = askYes;
            this.liveBestAskNo = askNo;
            this.liveBestBidYes = bidYes;
            this.liveBestBidNo = bidNo;
            this.liveCombinedAsk = askYes + askNo;
            this.liveCombinedBid = bidYes + bidNo;

            const sideLabel = side === 'YES' ? 'Up' : 'Down';

            if (!this.config.liveTrading) {
                const takerCommManual =
                    kMan > 0
                        ? takerCommissionUsdForBinaryBuy(
                              sh,
                              limitPxManual,
                              'TAKER',
                              feeBMan,
                              kMan
                          )
                        : 0;
                this.windowState = updateWindowStateFromFill(state, side, sh, estCost, {
                    takerCommissionUsd: takerCommManual,
                });
                this.riskState = recordOrderSuccess(this.riskState, estCost);
                this.riskState = resetCircuitBreaker(this.riskState);
                this.lastBalanceFetchTs = 0;
                recordPaperOrder({
                    windowSlug: market.slug,
                    windowEndIso: market.endDateIso,
                    side,
                    price: limitPxManual,
                    size: sh,
                    costUsd: estCost,
                    roundInWindow: this.roundsThisWindow,
                    liquidity: 'TAKER',
                });
                const ws = this.windowState;
                const acct = this.getAccountingSnapshot(ws);
                const mb = await fetchBtcUsdPrice();
                if (mb !== null) this.lastBtcUsdSpot = mb;
                this.recordOrderHistorySnapshot(
                    market,
                    ws,
                    side,
                    sh,
                    limitPxManual,
                    estCost,
                    {
                        bestBidYes: bidYes,
                        bestBidNo: bidNo,
                        bestAskYes: askYes,
                        bestAskNo: askNo,
                    },
                    orderHistoryReasonCode
                );
                logEntry(
                    {
                        timestamp: new Date().toISOString(),
                        marketSlug: ws.marketSlug,
                        windowEndIso: ws.windowEndIso,
                        pairCost: ws.pairCost,
                        qtyYes: ws.qtyYes,
                        qtyNo: ws.qtyNo,
                        costYes: ws.costYes,
                        costNo: ws.costNo,
                        lockedProfit: ws.lockedProfit,
                        totalSpentUsd: ws.totalSpentUsd,
                        event: 'manual_buy',
                        message: `PAPER manual ${sideLabel} ${sh} @ ~$${limitPxManual.toFixed(4)} estCost=$${estCost.toFixed(2)} (${orderHistoryReasonCode})`,
                        feeBipsAssumption: this.config.feeBips,
                        ...acct,
                    },
                    !q
                );
                updateDashboardState({
                    ...this.getDashboardExtras(),
                    marketSlug: market.slug,
                    windowEndIso: market.endDateIso,
                    consecutiveFailures: this.riskState.consecutiveOrderFailures,
                    pendingOrders: 0,
                    lastTick: new Date().toISOString(),
                    message: `Manual PAPER: ${sideLabel} +${sh} @ ~$${ask.toFixed(2)} | After P/L Up $${(ws.qtyYes - ws.totalSpentUsd).toFixed(2)} · Down $${(ws.qtyNo - ws.totalSpentUsd).toFixed(2)}`,
                });
                return {
                    ok: true,
                    snapshot: {
                        ...snap,
                        qtyYesAfter: ws.qtyYes,
                        qtyNoAfter: ws.qtyNo,
                        totalSpentUsdAfter: ws.totalSpentUsd,
                        afterPnlIfUpAfter: ws.qtyYes - ws.totalSpentUsd,
                        afterPnlIfDownAfter: ws.qtyNo - ws.totalSpentUsd,
                    },
                    orderId: 'paper-simulated',
                };
            }

            const result = await buyInstant(
                this.client,
                tokenId,
                ask,
                sh,
                this.config,
                !!market.negRisk,
                {
                    marketConditionId: market.conditionId,
                    verifyMaxWaitMs: 12_000,
                    verifyPollMs: 250,
                }
            );
            if (!result.success || !result.orderId || result.orderId === 'unknown') {
                this.riskState = recordOrderFailure(this.riskState);
                console.error(`[Bot] Manual buy failed: ${result.error}`);
                return {
                    ok: false,
                    error: result.error || 'CLOB rejected manual buy (FOK).',
                    snapshot: snap,
                };
            }

            const acctMan = this.resolveLiveFokAccounting(true, result, {
                shares: sh,
                price: limitPxManual,
                costUsd: estCost,
            });
            this.windowState = updateWindowStateFromFill(state, side, acctMan.shares, acctMan.costUsd);
            this.riskState = recordOrderSuccess(this.riskState, acctMan.costUsd);
            this.riskState = resetCircuitBreaker(this.riskState);
            this.recordOrderHistorySnapshot(
                market,
                this.windowState,
                side,
                acctMan.shares,
                acctMan.price,
                acctMan.costUsd,
                {
                    bestBidYes: bidYes,
                    bestBidNo: bidNo,
                    bestAskYes: askYes,
                    bestAskNo: askNo,
                },
                orderHistoryReasonCode
            );

            this.lastBalanceFetchTs = 0;
            this.lastPositionFetchTs = 0;
            await this.reconcileLiveStateAfterExchangeTouch(market, q);

            const ws = this.windowState!;
            const acct = this.getAccountingSnapshot(ws);
            logEntry(
                {
                    timestamp: new Date().toISOString(),
                    marketSlug: ws.marketSlug,
                    windowEndIso: ws.windowEndIso,
                    pairCost: ws.pairCost,
                    qtyYes: ws.qtyYes,
                    qtyNo: ws.qtyNo,
                    costYes: ws.costYes,
                    costNo: ws.costNo,
                    lockedProfit: ws.lockedProfit,
                    totalSpentUsd: ws.totalSpentUsd,
                    event: 'manual_buy',
                    message: `LIVE manual FOK ${sideLabel} ${acctMan.shares} @ ~$${acctMan.price.toFixed(4)} order=${String(result.orderId).slice(0, 14)}… (${orderHistoryReasonCode})`,
                    feeBipsAssumption: this.config.feeBips,
                    ...acct,
                },
                !q
            );

            updateDashboardState({
                ...this.getDashboardExtras(),
                marketSlug: market.slug,
                windowEndIso: market.endDateIso,
                consecutiveFailures: this.riskState.consecutiveOrderFailures,
                pendingOrders: this.activePendingOrder ? 1 : 0,
                lastTick: new Date().toISOString(),
                message: `Manual LIVE FOK: ${sideLabel} +${acctMan.shares} | After P/L Up $${(ws.qtyYes - ws.totalSpentUsd).toFixed(2)} · Down $${(ws.qtyNo - ws.totalSpentUsd).toFixed(2)}`,
            });
            this.options.onStateChange?.(ws, this.riskState);

            return {
                ok: true,
                snapshot: {
                    ...snap,
                    qtyYesAfter: ws.qtyYes,
                    qtyNoAfter: ws.qtyNo,
                    totalSpentUsdAfter: ws.totalSpentUsd,
                    afterPnlIfUpAfter: ws.qtyYes - ws.totalSpentUsd,
                    afterPnlIfDownAfter: ws.qtyNo - ws.totalSpentUsd,
                },
                orderId: result.orderId,
            };
        } finally {
            this.manualBuyInProgress = false;
        }
    }

    // ─── Lifecycle ───────────────────────────────────────────────────────

    start(): void {
        if (this.intervalId) return;
        this.startedAt = Date.now();
        if (!this.config.liveTrading) {
            const paperBalance = this.config.paperStartingBalanceUsd ?? 5000;
            resetPaperSession(paperBalance);
            console.log(`[Bot] Paper trading: simulated balance $${paperBalance.toFixed(2)}`);
        }
        updateDashboardState({
            running: true,
            liveTrading: this.config.liveTrading,
            message: this.config.liveTrading
                ? `Bot started — BTC ${this.config.btcMarketWindowMinutes}m pair strategy`
                : `Paper trading — $${(this.config.paperStartingBalanceUsd ?? 5000).toFixed(0)} simulated`,
        });
        console.log(
            `[Bot] Started (BTC ${this.config.btcMarketWindowMinutes}m). Poll: ${this.config.pollIntervalMs}ms. Live: ${this.config.liveTrading}`
        );
        if (this.orderbookWs) {
            this.orderbookWs.start();
            console.log(
                '[Bot] CLOB orderbook WebSocket enabled (USE_CLOB_ORDERBOOK_WS); REST fallback when stale.'
            );
        }
        this.tick();
        this.intervalId = setInterval(() => this.tick(), this.config.pollIntervalMs);
        this.redeemIntervalId = setInterval(
            () => this.runRedeemSweep().catch(() => {}),
            REDEEM_SWEEP_INTERVAL_MS
        );
    }

    stop(): void {
        this.orderbookWs?.stop();
        if (this.intervalId) {
            clearInterval(this.intervalId);
            this.intervalId = null;
        }
        if (this.redeemIntervalId) {
            clearInterval(this.redeemIntervalId);
            this.redeemIntervalId = null;
        }
        if (this.windowState && this.windowState.totalSpentUsd > 0) {
            const ws = this.windowState;
            const qStop = !!this.config.quietConsole;
            if (this.config.liveTrading) {
                void this.finalizeLiveWindowInventoryForClosedWindow(qStop).then(() =>
                    this.logWindowEndSummary(this.windowState!)
                );
            } else {
                void this.logWindowEndSummary(ws);
            }
        }
        flushOrderHistoryToDisk();
        updateDashboardState({ running: false, message: 'Bot stopped' });
        console.log(
            `[Bot] Stopped. Rounds: ${this.roundsThisWindow}. Pending: ${this.activePendingOrder ? 1 : 0}`
        );
    }

    getCompletedWindows() {
        return [...this.completedWindows];
    }

    getPendingOrders(): PendingOrder[] {
        return this.activePendingOrder ? [this.activePendingOrder] : [];
    }
}
