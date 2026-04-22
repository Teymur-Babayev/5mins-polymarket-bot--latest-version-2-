/**
 * Load strategy config from strategy.config.json (in project root) with env overrides.
 */

import * as fs from 'fs';
import * as path from 'path';
import type { StrategyConfig } from '../interfaces/strategyInterfaces';

const CONFIG_PATH =
    process.env.STRATEGY_CONFIG_PATH || path.join(process.cwd(), 'strategy.config.json');

const defaults: StrategyConfig = {
    btcMarketWindowMinutes: 15,
    targetPairCostMax: 0.99,
    safetyMargin: 0.98,
    strictMaxPairCostInclusive: 0.98,
    maxPositionPerWindowUsd: 500,
    orderSizeShares: 10,
    initialEntryShares: 10,
    orderMinSize: 1,
    tickSize: 0.01,
    pollIntervalMs: 5000,
    stopTradingSecondsBeforeEnd: 0,
    marketSlugs: ['btc', 'bitcoin', '15'],
    liveTrading: false,
    livePreferTakerAllEntries: false,
    liveMakerFallbackToTakerMs: 2500,
    killSwitch: false,
    circuitBreakerFailures: 5,
    feeBips: 10,
    binaryOutcomeTakerFeeScalar: 0.072,
    pairSecondLegMargin: 0.02,
    maxClipShares: 54,
    sizeLadderShares: [2, 8, 20, 35, 54],
    forcedSwitchEveryNOrders: 4,
    marketTiltEpsilon: 0.02,
    pairTiltImbalanceShares: 10,
    pairTiltMinElapsedSeconds: 0,
    /** 0 = allow first orders on window open (see `effectiveWarmupSeconds`). */
    windowEntryWarmupSeconds: 0,
    finalOneSidedHedgeSeconds: 30,
    absoluteNoOrderSeconds: 2,
    useClobOrderbookWebSocket: false,
    directionalSkewEnabled: true,
    dualOutcomePurchasePriority: true,
    takerWhenDualOutcomeVerified: false,
    earlyDownMomentumHedgeEnabled: false,
    earlyDownMomentumAskFloorUsd: 0.43,
    earlyDownMomentumMinRisingVelocity: 0,
    earlyDownMomentumExtraShares: 0,
    earlyDownMomentumCooldownMs: 45_000,
    minDualAfterPnlUsd: 0.7,
    minDualAfterPnlStrictAbove: false,
    oppositeLegFirstHedgeExtraSharesMin: 0,
    oppositeLegFirstHedgeExtraSharesMax: 0,
    momentumImbalanceStrategyEnabled: true,
    momentumBiasGapUsd: 35,
    momentumPauseWhenUpFavoredEnabled: true,
    momentumAllowDownGapUsd: -35,
    momentumPauseMinSecondsLeft: 60,
    unrestrictedPredictionBuys: false,
    finalOneSidedMomentumTargetEnabled: true,
    finalOneSidedMomentumFavorDownGapUsd: -15,
    finalOneSidedMomentumFavorUpGapUsd: 15,
    finalOneSidedMomentumMaxChunkShares: 2000,
    entryRiseSignalEnabled: false,
    entryRiseBtcWeight: 1,
    entryRiseBtcGapScaleUsd: 40,
    entryRiseVelWeight: 1,
    entryRiseAskVelScaleUsdPerSec: 0.005,
    entryRiseAskVelMinSpanSec: 2,
    entryRiseSpreadWeight: 0.35,
    entryRiseSpreadScaleUsd: 0.04,
    entryRiseMinScoreSeparation: 0.25,
    aggressiveDualPnlHedgeEnabled: false,
    aggressiveDualPnlHedgeMinAfterPnlUsd: 0.7,
    aggressiveDualPnlHedgeMinRoundsInWindow: 1,
    aggressiveDualPnlHedgeBypassDualProfitStop: true,
    pairLadderMatchEnabled: false,
    pairStockARandomSharesMin: 25,
    pairStockARandomSharesMax: 75,
    pairStockARawPriceMin: 0.2,
    pairStockARawPriceMax: 0.9,
    balancedOpenPositionValueStopEnabled: true,
    balancedOpenPositionValueStopBandUsd: 20,
    immediateImpliedPairCostHedgeEnabled: true,
};

/** Env set (any non-empty value) wins over JSON; unset means “use file default”. */
function boolFromEnv(key: string): boolean | undefined {
    const v = process.env[key];
    if (v == null || v === '') return undefined;
    return v === '1' || /^true$/i.test(v);
}

type StrategyFile = Partial<StrategyConfig> & { USE_CLOB_ORDERBOOK_WS?: string | boolean };

function useClobOrderbookWsFromFile(file: StrategyFile): boolean | undefined {
    if (file.useClobOrderbookWebSocket !== undefined) {
        const v = file.useClobOrderbookWebSocket;
        return typeof v === 'boolean' ? v : undefined;
    }
    const legacy = file.USE_CLOB_ORDERBOOK_WS;
    if (legacy === undefined) return undefined;
    if (typeof legacy === 'boolean') return legacy;
    if (typeof legacy === 'string') return legacy === '1' || /^true$/i.test(legacy);
    return undefined;
}

function fromEnv(key: string, parse: (s: string) => unknown): unknown {
    const v = process.env[key];
    if (v == null || v === '') return undefined;
    try {
        return parse(v);
    } catch {
        return undefined;
    }
}

function normalizeBtcWindowMinutes(raw: unknown): 5 | 15 {
    const n = raw === undefined || raw === null ? NaN : Number(raw);
    if (n === 5) return 5;
    return 15;
}

/** True when `secondsLeft` is inside the configured soft-stop band; `stop === 0` disables it. */
export function inStopTradingSecondsBeforeEndWindow(
    secondsLeft: number,
    stopTradingSecondsBeforeEnd: number
): boolean {
    return stopTradingSecondsBeforeEnd > 0 && secondsLeft <= stopTradingSecondsBeforeEnd;
}

export function loadStrategyConfig(): StrategyConfig {
    let file: StrategyFile = {};
    if (fs.existsSync(CONFIG_PATH)) {
        try {
            const raw = fs.readFileSync(CONFIG_PATH, 'utf-8');
            file = JSON.parse(raw) as StrategyFile;
        } catch (err) {
            console.warn('Could not load strategy.config.json:', err);
        }
    }
    const config: StrategyConfig = {
        btcMarketWindowMinutes: normalizeBtcWindowMinutes(
            (fromEnv('BTC_MARKET_WINDOW_MINUTES', parseFloat) as number) ??
                file.btcMarketWindowMinutes
        ),
        targetPairCostMax:
            (fromEnv('TARGET_PAIR_COST_MAX', parseFloat) as number) ??
            file.targetPairCostMax ??
            defaults.targetPairCostMax,
        safetyMargin:
            (fromEnv('SAFETY_MARGIN', parseFloat) as number) ??
            file.safetyMargin ??
            defaults.safetyMargin,
        strictMaxPairCostInclusive:
            (fromEnv('STRICT_MAX_PAIR_COST_INCLUSIVE', parseFloat) as number) ??
            file.strictMaxPairCostInclusive ??
            defaults.strictMaxPairCostInclusive,
        maxPositionPerWindowUsd:
            (fromEnv('MAX_POSITION_PER_WINDOW_USD', parseFloat) as number) ??
            file.maxPositionPerWindowUsd ??
            defaults.maxPositionPerWindowUsd,
        orderSizeShares:
            (fromEnv('ORDER_SIZE_SHARES', parseInt) as number) ??
            file.orderSizeShares ??
            defaults.orderSizeShares,
        initialEntryShares:
            (fromEnv('INITIAL_ENTRY_SHARES', parseInt) as number) ??
            file.initialEntryShares ??
            defaults.initialEntryShares,
        orderMinSize:
            (fromEnv('ORDER_MIN_SIZE', parseInt) as number) ??
            file.orderMinSize ??
            defaults.orderMinSize,
        tickSize:
            (fromEnv('TICK_SIZE', parseFloat) as number) ?? file.tickSize ?? defaults.tickSize,
        pollIntervalMs:
            (fromEnv('POLL_INTERVAL_MS', parseInt) as number) ??
            file.pollIntervalMs ??
            defaults.pollIntervalMs,
        stopTradingSecondsBeforeEnd:
            (fromEnv('STOP_TRADING_SECONDS_BEFORE_END', parseInt) as number) ??
            file.stopTradingSecondsBeforeEnd ??
            defaults.stopTradingSecondsBeforeEnd,
        liveTrading:
            (fromEnv('LIVE_TRADING', (s) => s === '1' || s.toLowerCase() === 'true') as boolean) ??
            file.liveTrading ??
            defaults.liveTrading,
        livePreferTakerAllEntries:
            boolFromEnv('LIVE_PREFER_TAKER_ALL_ENTRIES') ??
            file.livePreferTakerAllEntries ??
            defaults.livePreferTakerAllEntries,
        liveMakerFallbackToTakerMs:
            (fromEnv('LIVE_MAKER_FALLBACK_TO_TAKER_MS', parseInt) as number) ??
            file.liveMakerFallbackToTakerMs ??
            defaults.liveMakerFallbackToTakerMs,
        killSwitch:
            (fromEnv('KILL_SWITCH', (s) => s === '1' || s.toLowerCase() === 'true') as boolean) ??
            file.killSwitch ??
            defaults.killSwitch,
        circuitBreakerFailures:
            (fromEnv('CIRCUIT_BREAKER_FAILURES', parseInt) as number) ??
            file.circuitBreakerFailures ??
            defaults.circuitBreakerFailures,
        feeBips: (fromEnv('FEE_BIPS', parseInt) as number) ?? file.feeBips ?? defaults.feeBips,
        binaryOutcomeTakerFeeScalar:
            (fromEnv('BINARY_OUTCOME_TAKER_FEE_SCALAR', parseFloat) as number) ??
            file.binaryOutcomeTakerFeeScalar ??
            defaults.binaryOutcomeTakerFeeScalar,
        pairSecondLegMargin:
            (fromEnv('PAIR_SECOND_LEG_MARGIN', parseFloat) as number) ??
            file.pairSecondLegMargin ??
            defaults.pairSecondLegMargin,
        marketSlugs:
            file.marketSlugs && file.marketSlugs.length > 0
                ? file.marketSlugs
                : defaults.marketSlugs,
        maxSingleOrderUsd:
            (fromEnv('MAX_SINGLE_ORDER_USD', parseFloat) as number) ?? file.maxSingleOrderUsd,
        quietConsole:
            (fromEnv('QUIET_CONSOLE', (s) => s === '1' || s.toLowerCase() === 'true') as boolean) ??
            file.quietConsole ??
            false,
        paperStartingBalanceUsd:
            (fromEnv('PAPER_STARTING_BALANCE_USD', parseFloat) as number) ??
            file.paperStartingBalanceUsd ??
            5000,
        maxClipShares:
            (fromEnv('MAX_CLIP_SHARES', parseFloat) as number) ??
            file.maxClipShares ??
            defaults.maxClipShares,
        sizeLadderShares: file.sizeLadderShares ?? defaults.sizeLadderShares,
        forcedSwitchEveryNOrders:
            (fromEnv('FORCED_SWITCH_EVERY_N_ORDERS', parseInt) as number) ??
            file.forcedSwitchEveryNOrders ??
            defaults.forcedSwitchEveryNOrders,
        marketTiltEpsilon:
            (fromEnv('MARKET_TILT_EPSILON', parseFloat) as number) ??
            file.marketTiltEpsilon ??
            defaults.marketTiltEpsilon,
        pairTiltImbalanceShares:
            (fromEnv('PAIR_TILT_IMBALANCE_SHARES', parseFloat) as number) ??
            file.pairTiltImbalanceShares ??
            defaults.pairTiltImbalanceShares,
        pairTiltMinElapsedSeconds:
            (fromEnv('PAIR_TILT_MIN_ELAPSED_SECONDS', parseInt) as number) ??
            file.pairTiltMinElapsedSeconds ??
            defaults.pairTiltMinElapsedSeconds,
        windowEntryWarmupSeconds: (() => {
            const envW = fromEnv('WINDOW_ENTRY_WARMUP_SECONDS', parseInt) as number | undefined;
            if (envW !== undefined && Number.isFinite(envW)) {
                return Math.max(0, Math.floor(envW));
            }
            if (file.windowEntryWarmupSeconds !== undefined && file.windowEntryWarmupSeconds !== null) {
                return Math.max(0, Math.floor(file.windowEntryWarmupSeconds));
            }
            if (file.pairTiltMinElapsedSeconds !== undefined && file.pairTiltMinElapsedSeconds !== null) {
                return Math.max(0, Math.floor(file.pairTiltMinElapsedSeconds));
            }
            return defaults.windowEntryWarmupSeconds ?? 0;
        })(),
        finalOneSidedHedgeSeconds:
            (fromEnv('FINAL_ONE_SIDED_HEDGE_SECONDS', parseInt) as number) ??
            file.finalOneSidedHedgeSeconds ??
            defaults.finalOneSidedHedgeSeconds,
        absoluteNoOrderSeconds:
            (fromEnv('ABSOLUTE_NO_ORDER_SECONDS', parseInt) as number) ??
            file.absoluteNoOrderSeconds ??
            defaults.absoluteNoOrderSeconds,
        orderSpendBalanceFraction:
            (fromEnv('ORDER_SPEND_BALANCE_FRACTION', parseFloat) as number) ??
            file.orderSpendBalanceFraction,
        useClobOrderbookWebSocket:
            boolFromEnv('USE_CLOB_ORDERBOOK_WS') ??
            useClobOrderbookWsFromFile(file) ??
            defaults.useClobOrderbookWebSocket,
        directionalSkewEnabled:
            boolFromEnv('DIRECTIONAL_SKEW_ENABLED') ??
            file.directionalSkewEnabled ??
            defaults.directionalSkewEnabled,
        directionalSkewMinBidSpread: file.directionalSkewMinBidSpread,
        directionalSkewBtcUsdThreshold: file.directionalSkewBtcUsdThreshold,
        directionalSkewShareEdge: file.directionalSkewShareEdge,
        clipRampExtraFraction: file.clipRampExtraFraction,
        clipTailFraction: file.clipTailFraction,
        firstEntryLossRecoveryFraction: file.firstEntryLossRecoveryFraction,
        firstEntryRecoveryBalanceCapFraction: file.firstEntryRecoveryBalanceCapFraction,
        firstEntryBaseBudgetFraction: file.firstEntryBaseBudgetFraction,
        fromThirdPurchaseClipMultiplier: file.fromThirdPurchaseClipMultiplier,
        alternateHedgeFromRound: file.alternateHedgeFromRound,
        alternateHedgeClipMinShares: file.alternateHedgeClipMinShares,
        alternateHedgeClipMaxShares: file.alternateHedgeClipMaxShares,
        dualOutcomeProfitStopUsd: file.dualOutcomeProfitStopUsd,
        alternatePairCostMax: file.alternatePairCostMax,
        momentumInversionHedgeEnabled:
            boolFromEnv('MOMENTUM_INVERSION_HEDGE_ENABLED') ??
            file.momentumInversionHedgeEnabled ??
            true,
        btcGapSignDeadZoneUsd:
            (fromEnv('BTC_GAP_SIGN_DEAD_ZONE_USD', parseFloat) as number) ??
            file.btcGapSignDeadZoneUsd ??
            5,
        dualOutcomePurchasePriority: file.dualOutcomePurchasePriority ?? defaults.dualOutcomePurchasePriority,
        takerWhenDualOutcomeVerified:
            file.takerWhenDualOutcomeVerified ?? defaults.takerWhenDualOutcomeVerified,
        earlyDownMomentumHedgeEnabled:
            file.earlyDownMomentumHedgeEnabled ?? defaults.earlyDownMomentumHedgeEnabled,
        earlyDownMomentumAskFloorUsd:
            file.earlyDownMomentumAskFloorUsd ?? defaults.earlyDownMomentumAskFloorUsd,
        earlyDownMomentumMinRisingVelocity:
            file.earlyDownMomentumMinRisingVelocity ?? defaults.earlyDownMomentumMinRisingVelocity,
        earlyDownMomentumExtraShares:
            file.earlyDownMomentumExtraShares ?? defaults.earlyDownMomentumExtraShares,
        earlyDownMomentumCooldownMs:
            file.earlyDownMomentumCooldownMs ?? defaults.earlyDownMomentumCooldownMs,
        minDualAfterPnlUsd:
            (fromEnv('MIN_DUAL_AFTER_PNL_USD', parseFloat) as number) ??
            file.minDualAfterPnlUsd ??
            defaults.minDualAfterPnlUsd,
        minDualAfterPnlStrictAbove:
            boolFromEnv('MIN_DUAL_AFTER_PNL_STRICT_ABOVE') ??
            file.minDualAfterPnlStrictAbove ??
            defaults.minDualAfterPnlStrictAbove,
        oppositeLegFirstHedgeExtraSharesMin:
            file.oppositeLegFirstHedgeExtraSharesMin ?? defaults.oppositeLegFirstHedgeExtraSharesMin,
        oppositeLegFirstHedgeExtraSharesMax:
            file.oppositeLegFirstHedgeExtraSharesMax ?? defaults.oppositeLegFirstHedgeExtraSharesMax,
        momentumImbalanceStrategyEnabled:
            file.momentumImbalanceStrategyEnabled ?? defaults.momentumImbalanceStrategyEnabled,
        momentumBiasGapUsd:
            (fromEnv('MOMENTUM_BIAS_GAP_USD', parseFloat) as number) ??
            file.momentumBiasGapUsd ??
            defaults.momentumBiasGapUsd,
        momentumPauseWhenUpFavoredEnabled:
            file.momentumPauseWhenUpFavoredEnabled ?? defaults.momentumPauseWhenUpFavoredEnabled,
        momentumAllowDownGapUsd:
            (fromEnv('MOMENTUM_ALLOW_DOWN_GAP_USD', parseFloat) as number) ??
            file.momentumAllowDownGapUsd ??
            defaults.momentumAllowDownGapUsd,
        momentumPauseMinSecondsLeft:
            (fromEnv('MOMENTUM_PAUSE_MIN_SECONDS_LEFT', parseInt) as number) ??
            file.momentumPauseMinSecondsLeft ??
            defaults.momentumPauseMinSecondsLeft,
        unrestrictedPredictionBuys:
            boolFromEnv('UNRESTRICTED_PREDICTION_BUYS') ??
            file.unrestrictedPredictionBuys ??
            defaults.unrestrictedPredictionBuys,
        finalOneSidedMomentumTargetEnabled:
            file.finalOneSidedMomentumTargetEnabled ?? defaults.finalOneSidedMomentumTargetEnabled,
        finalOneSidedMomentumFavorDownGapUsd:
            file.finalOneSidedMomentumFavorDownGapUsd ??
            defaults.finalOneSidedMomentumFavorDownGapUsd,
        finalOneSidedMomentumFavorUpGapUsd:
            file.finalOneSidedMomentumFavorUpGapUsd ??
            defaults.finalOneSidedMomentumFavorUpGapUsd,
        finalOneSidedMomentumMaxChunkShares:
            file.finalOneSidedMomentumMaxChunkShares ??
            defaults.finalOneSidedMomentumMaxChunkShares,
        entryRiseSignalEnabled: file.entryRiseSignalEnabled ?? defaults.entryRiseSignalEnabled,
        entryRiseBtcWeight: file.entryRiseBtcWeight ?? defaults.entryRiseBtcWeight,
        entryRiseBtcGapScaleUsd: file.entryRiseBtcGapScaleUsd ?? defaults.entryRiseBtcGapScaleUsd,
        entryRiseVelWeight: file.entryRiseVelWeight ?? defaults.entryRiseVelWeight,
        entryRiseAskVelScaleUsdPerSec:
            file.entryRiseAskVelScaleUsdPerSec ?? defaults.entryRiseAskVelScaleUsdPerSec,
        entryRiseAskVelMinSpanSec:
            file.entryRiseAskVelMinSpanSec ?? defaults.entryRiseAskVelMinSpanSec,
        entryRiseSpreadWeight: file.entryRiseSpreadWeight ?? defaults.entryRiseSpreadWeight,
        entryRiseSpreadScaleUsd: file.entryRiseSpreadScaleUsd ?? defaults.entryRiseSpreadScaleUsd,
        entryRiseMinScoreSeparation:
            file.entryRiseMinScoreSeparation ?? defaults.entryRiseMinScoreSeparation,
        aggressiveDualPnlHedgeEnabled:
            file.aggressiveDualPnlHedgeEnabled ?? defaults.aggressiveDualPnlHedgeEnabled,
        aggressiveDualPnlHedgeMinAfterPnlUsd:
            file.aggressiveDualPnlHedgeMinAfterPnlUsd ??
            defaults.aggressiveDualPnlHedgeMinAfterPnlUsd,
        aggressiveDualPnlHedgeMinRoundsInWindow:
            file.aggressiveDualPnlHedgeMinRoundsInWindow ??
            defaults.aggressiveDualPnlHedgeMinRoundsInWindow,
        aggressiveDualPnlHedgeBypassDualProfitStop:
            file.aggressiveDualPnlHedgeBypassDualProfitStop ??
            defaults.aggressiveDualPnlHedgeBypassDualProfitStop,
        pairLadderMatchEnabled:
            boolFromEnv('PAIR_LADDER_MATCH_ENABLED') ??
            file.pairLadderMatchEnabled ??
            defaults.pairLadderMatchEnabled,
        pairStockARandomSharesMin:
            file.pairStockARandomSharesMin ?? defaults.pairStockARandomSharesMin,
        pairStockARandomSharesMax:
            file.pairStockARandomSharesMax ?? defaults.pairStockARandomSharesMax,
        pairStockARawPriceMin: file.pairStockARawPriceMin ?? defaults.pairStockARawPriceMin,
        pairStockARawPriceMax: file.pairStockARawPriceMax ?? defaults.pairStockARawPriceMax,
        balancedOpenPositionValueStopEnabled:
            boolFromEnv('BALANCED_OPEN_POSITION_VALUE_STOP_ENABLED') ??
            file.balancedOpenPositionValueStopEnabled ??
            defaults.balancedOpenPositionValueStopEnabled,
        balancedOpenPositionValueStopBandUsd:
            (fromEnv('BALANCED_OPEN_POSITION_VALUE_STOP_BAND_USD', parseFloat) as number) ??
            file.balancedOpenPositionValueStopBandUsd ??
            defaults.balancedOpenPositionValueStopBandUsd,
        immediateImpliedPairCostHedgeEnabled:
            file.immediateImpliedPairCostHedgeEnabled ?? defaults.immediateImpliedPairCostHedgeEnabled,
        immediateOppositePairCostMax: file.immediateOppositePairCostMax,
    };
    return config;
}
