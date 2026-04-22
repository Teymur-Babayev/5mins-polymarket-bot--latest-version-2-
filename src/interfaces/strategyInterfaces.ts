/**
 * Interfaces for BTC Up/Down pair strategy (reference-wallet logic, maker bids).
 * Works for 5m or 15m windows via btcMarketWindowMinutes.
 */

export interface StrategyConfig {
    /** 5 or 15 — which btc-updown-{n}m market series to trade */
    btcMarketWindowMinutes: 5 | 15;
    /** Max allowed pair cost (avg_YES + avg_NO). Must be < 1.0. e.g. 0.96–0.99 */
    targetPairCostMax: number;
    /** Safety margin: only place order if simulated new pair cost stays below this */
    safetyMargin: number;
    /**
     * Hard cap on fee-inclusive pair cost (avg_YES + avg_NO) for all gated buys.
     * Effective ceiling = min(this, safetyMargin, targetPairCostMax). Default 0.98 when omitted.
     */
    strictMaxPairCostInclusive?: number;
    /** Max total position size (in USD) per window */
    maxPositionPerWindowUsd: number;
    /** Order size per leg (in shares) */
    orderSizeShares: number;
    /** First order of each window: target share count (≥ market/order min). Default 10. */
    initialEntryShares?: number;
    /**
     * When true: each matched pair is Up+Down equal. While |Up−Down|>0, only buy the lighter leg for exactly
     * that gap. When quantities are equal (matched) or both zero (initiation), Stock A uses ask/BTC rise
     * prediction then a random clip in [pairStockARandomSharesMin, Max]; `minDualAfterPnlUsd` slack/simulation
     * applies only on the hedge leg when quantities differ.
     */
    pairLadderMatchEnabled?: boolean;
    /** Inclusive min shares for random Stock A clip (pair ladder). Default 25. */
    pairStockARandomSharesMin?: number;
    /** Inclusive max shares for random Stock A clip (pair ladder). Default 75. */
    pairStockARandomSharesMax?: number;
    /**
     * Stock A legs only (not hedge / Stock B): require execution reference price in [min, max].
     * Uses best bid when posting maker; taker limit (rounded ask + tick) when taking. Default 0.2 / 0.9.
     */
    pairStockARawPriceMin?: number;
    pairStockARawPriceMax?: number;
    /**
     * Pair ladder: when Up/Down quantities are equal (matched book), skip new buys if **Open Positions Value**
     * (qtyYes×bestBidYes + qtyNo×bestBidNo, same as dashboard) lies in
     * `[maxPositionPerWindowUsd − pairStockARandomSharesMax ± balancedOpenPositionValueStopBandUsd]`.
     * Default true when omitted (loader default); set false to disable.
     */
    balancedOpenPositionValueStopEnabled?: boolean;
    /** Half-width of the USD stop band around `(maxPositionPerWindowUsd − pairStockARandomSharesMax)`. Default 20. */
    balancedOpenPositionValueStopBandUsd?: number;
    /**
     * Min |YES ask $/s − NO ask $/s| to use ask-rise momentum when the spot BTC gap alone does not pick a side.
     * Default 0.0008.
     */
    pairLadderAskVelocityMinSepUsdPerSec?: number;
    /**
     * After a losing window, scale the prior net P/L by this when sizing the next window’s first order (notional ≈ loss × fraction).
     * Capped by maxSingleOrderUsd and firstEntryRecoveryBalanceCapFraction. Default 1 = aim to deploy ~the loss in USD on leg one.
     */
    firstEntryLossRecoveryFraction?: number;
    /** Max fraction of available balance usable on the first order when recovering a prior-window loss. Default 0.5. */
    firstEntryRecoveryBalanceCapFraction?: number;
    /** When the prior window was flat or profitable, cap first-order notional to this fraction of balance (small probe). Default 0.05. */
    firstEntryBaseBudgetFraction?: number;
    /** Multiply clip size for orders from the 3rd purchase onward (roundsThisWindow ≥ 2). Default 1.4. */
    /** Applied only to ladder Stock A clips (round ≥ 2); Stock B hedges are never multiplied so A/B sizes stay matched. */
    fromThirdPurchaseClipMultiplier?: number;
    /** Min order size (market min) */
    orderMinSize: number;
    /** Tick size for prices (e.g. 0.01) */
    tickSize: number;
    /** Poll interval in ms (e.g. 5000) */
    pollIntervalMs: number;
    /**
     * Soft-stop window before window end (balanced-hold, late parity cap, FOK hedge hint).
     * Set to 0 to disable — purchases continue until `absoluteNoOrderSeconds` / hard cutoff (see bot).
     */
    stopTradingSecondsBeforeEnd: number;
    /** Market slugs or keywords to find 15m crypto markets (e.g. ["btc", "bitcoin", "15"]) */
    marketSlugs: string[];
    /** Enable live trading (false = paper only) */
    liveTrading: boolean;
    /**
     * Live parity mode: when true, execute normal live entries as taker/FOK at ask (instead of maker bid).
     * This reduces paper-vs-live timing drift by prioritizing immediate fills, at the cost of higher entry prices.
     */
    livePreferTakerAllEntries?: boolean;
    /**
     * Hybrid live mode timeout (ms): when an entry is placed as maker and still pending beyond this age,
     * cancel it and immediately retry remaining shares as taker/FOK at ask.
     * Set to 0 or negative to disable maker->taker fallback.
     */
    liveMakerFallbackToTakerMs?: number;
    /** Kill switch: if true, no orders are placed */
    killSwitch: boolean;
    /** Circuit breaker: pause after this many consecutive order failures */
    circuitBreakerFailures: number;
    /**
     * Polymarket-style fee rate scalar: taker fee per fill ≈ `C * (feeBips/10_000) * p * (1-p)` USD
     * (makers: 0). Stored as basis points of the rate factor, e.g. 10 → 0.001.
     */
    feeBips: number;
    /**
     * Polymarket-style taker fee for binary outcome buys: fee/share ≈ `k * p * (1-p)`,
     * all-in/share = `p + fee`. Set to `0` to use only `feeBips` add-on for Stock B taker (legacy).
     * Loader default: `0.072` (`C × k × p × (1−p)` commission).
     */
    binaryOutcomeTakerFeeScalar?: number;
    /** Diagnostic: implied max opposing bid after first leg all-in, before this margin. Default `0.02`. */
    pairSecondLegMargin?: number;
    /** Max USD to spend on a single order (one side). Prevents oversized bets. */
    maxSingleOrderUsd?: number;
    /**
     * Cap each order’s notional at this fraction of available trading balance (e.g. 0.05 = 1/20).
     * Tightened together with maxSingleOrderUsd (whichever is smaller). Requires balance passed into clip sizing.
     */
    orderSpendBalanceFraction?: number;
    /** Suppress per-tick console.log output (dashboard + file logs still active). Default: false */
    quietConsole?: boolean;
    /** When liveTrading is false, starting simulated balance in USD for paper trading (e.g. 5000). */
    paperStartingBalanceUsd?: number;
    /** Bid separation to call market "up-tilt" vs "down-tilt" (default 0.02). */
    marketTiltEpsilon?: number;
    /** When |YES−NO| share gap ≥ this, favor buying the smaller side. */
    pairTiltImbalanceShares?: number;
    /**
     * Legacy field: was incorrectly reused as the global order warmup duration in older builds.
     * Prefer `windowEntryWarmupSeconds`; `loadStrategyConfig` maps this to `windowEntryWarmupSeconds` only when
     * the latter is omitted from JSON.
     */
    pairTiltMinElapsedSeconds?: number;
    /**
     * Seconds after the window opens before the bot may place the first order (same clock as `elapsedSec` in HedgeBot).
     * **0** = decisions use the book and BTC anchor as soon as the first tick runs (recommended for BTC windows).
     * Capped at ~35% of window length. Env: `WINDOW_ENTRY_WARMUP_SECONDS`.
     */
    windowEntryWarmupSeconds?: number;
    /** Max shares per clip. */
    maxClipShares?: number;
    /** Size ladder (ascending); clips chosen from this set. */
    sizeLadderShares?: number[];
    /** Force opposite leg every N completed orders (two-sided book; 0 = off). */
    forcedSwitchEveryNOrders?: number;
    /**
     * If only one leg (Up or Down) is held, force-buy the opposite at the ask in the last N seconds
     * before expiry to match share counts (equal After PnL If Up / Down). Default 30.
     */
    finalOneSidedHedgeSeconds?: number;
    /** No new orders when seconds to window end are at or below this (default 2). */
    absoluteNoOrderSeconds?: number;
    /**
     * Use CLOB market-channel WebSocket for orderbooks (REST fallback when stale).
     * Env `USE_CLOB_ORDERBOOK_WS` overrides when set; JSON may use `useClobOrderbookWebSocket` or `USE_CLOB_ORDERBOOK_WS`.
     */
    useClobOrderbookWebSocket?: boolean;
    /**
     * When false, skip directional skew (no extra shares on the “favored” leg from spot+book).
     * Keeps After PnL If Up / Down closer by not deliberately leaning inventory. Default true.
     */
    directionalSkewEnabled?: boolean;
    /** Min |Down bid − Up bid| (or reverse) to treat orderbook as favoring a leg for directional skew. Lower = more skew signals. */
    directionalSkewMinBidSpread?: number;
    /** Min |BTC USD move vs window open| to confirm skew with spot. Lower = more hedges aligned with BTC. */
    directionalSkewBtcUsdThreshold?: number;
    /** Extra shares to lean on the favored leg when skewing (inventory target gap). Higher = stronger hedge clip. */
    directionalSkewShareEdge?: number;
    /** After warmup: fraction of window length added to ramp toward large clips (default ~0.08). Smaller = faster to max size. */
    clipRampExtraFraction?: number;
    /** Fraction of window treated as end “tail” where clip size tapers (default ~0.15). Smaller = large clips for more of the window. */
    clipTailFraction?: number;
    /**
     * From this completed-round index onward (0 = first order), use alternate book / opposite-hedge
     * clips in HedgeBot only. Default 2 = third order onward.
     */
    alternateHedgeFromRound?: number;
    /** Alternate-hedge clip lower bound (shares). Default 10. */
    alternateHedgeClipMinShares?: number;
    /** Alternate-hedge clip upper bound (shares). Default 30. */
    alternateHedgeClipMaxShares?: number;
    /** When both After PnL If Up/Down (gross) reach this USD, HedgeBot stops placing orders. Default 5. Set 0 to disable. */
    dualOutcomeProfitStopUsd?: number;
    /** Max pair cost (avg YES + avg NO) when simulating alternate-hedge orders. Default 0.99. */
    alternatePairCostMax?: number;
    /**
     * When true (default), if BTC USD gap vs window open crosses from positive to negative dead zone
     * or vice versa while inventory is one-sided, FOK-buy the missing leg at ask immediately — avoids
     * waiting until finalOneSidedHedgeSeconds when the market runs one way.
     */
    momentumInversionHedgeEnabled?: boolean;
    /**
     * Treat BTC gap as "neutral" inside ±this USD band when detecting sign (reduces flip noise). Default 5.
     */
    btcGapSignDeadZoneUsd?: number;
    /**
     * When true (default), ladder Stock B may use a fast path when dual After PnLs meet
     * {@link minDualAfterPnlUsd} — but **pair cost (avgYes + avgNo) must still be ≤ min(safetyMargin, targetPairCostMax)**
     * and &lt; 1. Pass all-in $/share (incl. taker fee model) into sizing so simulation matches execution.
     */
    dualOutcomePurchasePriority?: boolean;
    /**
     * When true (default false), a one-sided hedge that is dual-outcome-profitable at the **ask** uses
     * FOK @ ask instead of a limit @ bid — faster execution when verified against both settlement PnLs.
     */
    takerWhenDualOutcomeVerified?: boolean;
    /**
     * When not false (default on): while strictly one-sided, if held-leg avg + opposite best ask ≤
     * `immediateOppositePairCostMax` (else min(safetyMargin, 0.98)), FOK-buy the opposite for the full imbalance
     * right after each orderbook refresh — avoids stalling on resting bids or final-window momentum “wait”.
     */
    immediateImpliedPairCostHedgeEnabled?: boolean;
    /** Implied pair ceiling for {@link immediateImpliedPairCostHedgeEnabled}; omit to use min(safetyMargin, 0.98). */
    immediateOppositePairCostMax?: number;
    /**
     * When true, if long Up only and Down best ask is rising (orderbook momentum), extrapolate that Down
     * will stay above `earlyDownMomentumAskFloorUsd` before expiry and FOK-buy Down (imbalance + extra)
     * **before** `finalOneSidedHedgeSeconds` — avoids waiting until the last 30s at expensive asks.
     */
    earlyDownMomentumHedgeEnabled?: boolean;
    /** Min Down ask ($) we require (current or extrapolated to window end) vs floor. Default 0.43. */
    earlyDownMomentumAskFloorUsd?: number;
    /** Down ask must rise at least this many $/s (positive = up). Default 0. */
    earlyDownMomentumMinRisingVelocity?: number;
    /** Buy this many more Down shares than the Up/Down imbalance (when long Up only). Default 0. */
    earlyDownMomentumExtraShares?: number;
    /** Min ms between early Down momentum hedges. Default 45000. */
    earlyDownMomentumCooldownMs?: number;
    /**
     * Ladder **Stock B** only: after a simulated buy on the hedge leg, require both After PnL If Up / Down
     * (qty − spent) to be at least this USD. Stock A entries do not use this floor. Default 0.7.
     */
    minDualAfterPnlUsd?: number;
    /** When true, require After PnL strictly greater than minDualAfterPnlUsd (not equal). Default false. */
    minDualAfterPnlStrictAbove?: boolean;
    /**
     * One-sided → first opposite (Stock B): optional extra shares on top of strict parity. Use 0/0 for 1:1 A/B shares.
     */
    oppositeLegFirstHedgeExtraSharesMin?: number;
    oppositeLegFirstHedgeExtraSharesMax?: number;
    /**
     * BTC gap (spot − window open) momentum rules: bias inventory toward expected winner and optional
     * pause when already favored; Down buys always allowed when gap ≤ momentumAllowDownGapUsd.
     */
    momentumImbalanceStrategyEnabled?: boolean;
    /** |gap| ≥ this (USD) activates bias/pause logic. Default 35. */
    momentumBiasGapUsd?: number;
    /** When gap ≥ momentumBiasGapUsd and qtyYes > qtyNo, pause new orders (unless seconds left low). */
    momentumPauseWhenUpFavoredEnabled?: boolean;
    /** When gap ≤ this (negative), never apply pause to Down (NO) purchases. Default -35. */
    momentumAllowDownGapUsd?: number;
    /** Momentum pause is disabled when secondsLeft ≤ this (trade freely near expiry). Default 60. */
    momentumPauseMinSecondsLeft?: number;
    /**
     * When true: prediction-driven ladder Stock A skips momentum pause, After-PnL slack cap, and pair-cost
     * simulation clamp (still subject to CLOB $1 min, balance, maxSingleOrderUsd, kill switch).
     * Final-window one-sided momentum chase also keeps buying at a minimum clip when PnL target is already met.
     * Default false.
     */
    unrestrictedPredictionBuys?: boolean;

    /**
     * 5m BTC window only: in the last `finalOneSidedHedgeSeconds`, when still one-sided, FOK @ ask on
     * the BTC gap–predicted outcome until that side's After PnL reaches minDualAfterPnlUsd (re-evaluated
     * each tick if gap flips). Does not run when both legs are held; does not mix with Phase 4 maker entry.
     */
    finalOneSidedMomentumTargetEnabled?: boolean;
    /** If BTC gap ≤ this (USD), prediction favors Down (NO). Default -15. */
    finalOneSidedMomentumFavorDownGapUsd?: number;
    /** If BTC gap ≥ this (USD), prediction favors Up (YES). Default 15. */
    finalOneSidedMomentumFavorUpGapUsd?: number;
    /** Max shares per FOK clip in that window. Default 2000. */
    finalOneSidedMomentumMaxChunkShares?: number;

    /**
     * When true, after reference `explainReferenceBuySide` (unless parity/inventory rebalance), blend
     * BTC gap vs window open + YES/NO best-ask velocity + bid/ask spread tilt to override entry side
     * when the composite score is decisive. Reference: gap = spot − btcUsdAtWindowOpen (same as skew).
     */
    entryRiseSignalEnabled?: boolean;
    /** Weight on BTC gap tilt in [-1,1] after dead zone. Default 1. */
    entryRiseBtcWeight?: number;
    /** Scale USD for excess |gap| beyond btcGapSignDeadZoneUsd. Default 40. */
    entryRiseBtcGapScaleUsd?: number;
    /** Weight on (YES ask vel − NO ask vel) tilt. Default 1. */
    entryRiseVelWeight?: number;
    /** $/s that maps relative velocity to ~±1 tilt. Default 0.005. */
    entryRiseAskVelScaleUsdPerSec?: number;
    /** Min span (s) for velocity from rolling ask samples. Default 2. */
    entryRiseAskVelMinSpanSec?: number;
    /** Weight on (spreadNO − spreadYES) tilt (tighter YES spread → buy YES). Default 0.35. */
    entryRiseSpreadWeight?: number;
    /** Spread difference (USD) that maps spread tilt to ~±1. Default 0.04. */
    entryRiseSpreadScaleUsd?: number;
    /** Min composite tilt magnitude to override baseline side. Default 0.25. */
    entryRiseMinScoreSeparation?: number;

    /**
     * When both legs are held and both After PnL If Up/Down exceed `aggressiveDualPnlHedgeMinAfterPnlUsd`
     * (default $0.70), immediately FOK-buy the undersized leg (or the leg with lower After PnL when balanced)
     * each tick until budget / clamps stop — simulates chasing hedge under strong dual profitability.
     * Paper and live use the same sizing (`clampBuySizeForSimulatedGates`).
     */
    aggressiveDualPnlHedgeEnabled?: boolean;
    /** Require both After PnL strictly above this USD (default 0.7). */
    aggressiveDualPnlHedgeMinAfterPnlUsd?: number;
    /** Minimum completed buys this window before aggressive hedge (default 1 = from 2nd purchase onward). */
    aggressiveDualPnlHedgeMinRoundsInWindow?: number;
    /**
     * Previously: when true, aggressive dual PnL hedge could bypass `dualOutcomeProfitStopUsd` while both
     * After PnLs stayed above `aggressiveDualPnlHedgeMinAfterPnlUsd`. Ignored by HedgeBot: the dual profit
     * stop always applies once both legs meet `dualOutcomeProfitStopUsd`.
     */
    aggressiveDualPnlHedgeBypassDualProfitStop?: boolean;
}

/** Current active market from Gamma API (binary YES/NO) */
export interface ActiveMarket {
    conditionId: string;
    question: string;
    slug: string;
    /** YES token ID for CLOB */
    yesTokenId: string;
    /** NO token ID for CLOB */
    noTokenId: string;
    endDateIso: string;
    gameStartTime?: string;
    acceptingOrders: boolean;
    closed: boolean;
    orderPriceMinTickSize?: number;
    orderMinSize?: number;
    negRisk?: boolean;
    /** Window length in seconds (300 or 900) — used for elapsed/taper math */
    windowDurationSec: number;
    btcMarketWindowMinutes: 5 | 15;
}

/** Per-window inventory and cost state */
export interface WindowState {
    marketSlug: string;
    conditionId: string;
    windowEndIso: string;
    /**
     * LIVE: CLOB outcome token ids for this window. Used to pull on-chain balances and CLOB trades
     * after the active `getMarket()` slug rolls to the next window so end-of-round totals stay accurate.
     */
    yesTokenId?: string;
    noTokenId?: string;
    /** Total shares filled on YES */
    qtyYes: number;
    /** Total shares filled on NO */
    qtyNo: number;
    /** Total cost (USD) for YES */
    costYes: number;
    /** Total cost (USD) for NO */
    costNo: number;
    /** Average price YES (costYes / qtyYes) */
    avgYes: number;
    /** Average price NO (costNo / qtyNo) */
    avgNo: number;
    /** Pair cost = avgYes + avgNo. Must be < 1.0 for profit */
    pairCost: number;
    /** Locked-in profit from MATCHED pairs only = min(qty) × (1 - pairCost). Excess shares excluded. */
    lockedProfit: number;
    /** Total USD spent this window */
    totalSpentUsd: number;
    /**
     * Cumulative taker commission (USD) using `C × k × p × (1−p)` per fill when modeled as TAKER.
     * Notional spend ≈ `totalSpentUsd − takerCommissionPaidUsd`. Used for min-dual gates vs `minDualAfterPnlUsd`.
     */
    takerCommissionPaidUsd?: number;
    lastUpdated: string;
}

/** Orderbook level (bid or ask) */
export interface OrderBookLevel {
    price: number;
    size: number;
}

/** Snapshot for strategy decision */
export interface OrderBookSnapshot {
    tokenId: string;
    side: 'YES' | 'NO';
    bids: OrderBookLevel[];
    asks: OrderBookLevel[];
    bestBid?: number;
    bestAsk?: number;
}

/** Optional clock + fill history for decide() in demos/backtests (matches HedgeBot). */
export interface StrategyDecisionContext {
    roundsThisWindow: number;
    lastExecutedSide: 'YES' | 'NO' | null;
    secondsLeft: number;
    /** USDC available for sizing when orderSpendBalanceFraction is set (Polymarket proxy or paper cash). */
    availableBalanceUsd?: number;
    /**
     * BTC/USD change vs. price captured at window start (e.g. Binance).
     * Live bot: finite = enforce ±$30 with directional skew; null = skip skew (missing data).
     * Demos/backtests: omit field to use orderbook 30¢ spread only for skew (no BTC gate).
     */
    btcUsdDeltaFromWindowOpen?: number | null;
}

/** Decision from strategy: what to do this tick */
export interface StrategyDecision {
    action: 'BUY_YES' | 'BUY_NO' | 'HOLD';
    tokenId: string;
    price: number;
    size: number;
    reason: string;
    /** Simulated pair cost after this fill */
    simulatedPairCost?: number;
}

/** Log entry for P/L and metrics (client: average cost, fees/slippage vs realized, net P/L by day/window) */
export interface StrategyLogEntry {
    timestamp: string;
    marketSlug: string;
    windowEndIso: string;
    pairCost: number;
    qtyYes: number;
    qtyNo: number;
    costYes: number;
    costNo: number;
    lockedProfit: number;
    totalSpentUsd: number;
    event:
        | 'tick'
        | 'order_placed'
        | 'order_filled'
        | 'order_failed'
        | 'window_end'
        | 'risk_blocked'
        | 'manual_buy';
    message?: string;
    /** Fee assumption (bips) used for P/L – "fees/slippage assumptions vs realized" */
    feeBipsAssumption?: number;
    /** Realized fees in USD when available from CLOB/trades */
    realizedFeesUsd?: number;
    /** Mark-to-market value of currently held shares at live best bids */
    positionValueUsd?: number;
    /** Cost basis of currently held shares (costYes + costNo) */
    positionCostUsd?: number;
    /** Unrealized P/L of currently held shares = positionValueUsd - positionCostUsd */
    unrealizedPnlUsd?: number;
    /** Portfolio value snapshot = total USDC balance + position value */
    portfolioValueUsd?: number;
    /** Session P/L from bot start baseline = portfolioValueUsd - baseline */
    sessionPnlUsd?: number;
}
