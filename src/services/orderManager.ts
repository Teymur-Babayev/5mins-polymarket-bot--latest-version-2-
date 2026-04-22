/**
 * Order placement, cancellation, and fill tracking via Polymarket CLOB client.
 * Uses limit orders (GTC) by default; respects config for tick size and neg risk.
 *
 * Partial fill handling:
 *   - After placing a GTC order, it is stored as "pending"
 *   - Each tick, reconcilePendingOrders() checks if pending orders have filled
 *   - Fills are returned so the bot can update its window state from ACTUAL fills
 *   - Unfilled/partial orders remain pending and are not double-counted
 */

import { ClobClient, Side, OrderType } from '@polymarket/clob-client';
import type { TickSize, OpenOrder } from '@polymarket/clob-client';
import type { ActiveMarket } from '../interfaces/strategyInterfaces';
import type { StrategyConfig } from '../interfaces/strategyInterfaces';
import { orderBookFromClob } from './hedgeStrategy';
import type { OrderBookSnapshot } from '../interfaces/strategyInterfaces';
import type { ClobOrderbookWs } from './clobOrderbookWs';
import { binaryOutcomeBuyAllInPerShare } from '../utils/polymarketFees';

/** Reported FOK fill — use for accounting, not the pre-trade share target. */
export interface FokBuyFill {
    shares: number;
    costUsd: number;
    avgPriceUsd: number;
}

export interface OrderResult {
    success: boolean;
    orderId?: string;
    error?: string;
    /** Live FOK: matched shares and cost from CLOB when resolved. */
    fokFill?: FokBuyFill;
}

function parsePostOrderResponse(resp: unknown): { ok: boolean; orderId?: string; error?: string } {
    if (resp == null || typeof resp !== 'object') {
        return { ok: false, error: 'Empty or invalid CLOB response' };
    }
    const r = resp as Record<string, unknown>;
    if (r.success === false) {
        const err = r.errorMsg ?? r.error ?? r.message ?? 'Order rejected by CLOB';
        return { ok: false, error: String(err) };
    }
    const orderId = r.orderID ?? r.id;
    if (!orderId || orderId === 'unknown') {
        const err = r.errorMsg ?? r.error ?? r.message ?? 'No orderID in CLOB response';
        return { ok: false, error: String(err) };
    }
    return { ok: true, orderId: String(orderId) };
}

async function sleep(ms: number): Promise<void> {
    await new Promise((r) => setTimeout(r, ms));
}

/**
 * After posting a FOK/FAK market order, confirm matched size via getOrder.
 * The HTTP post may return an order id before size_matched is visible — do not treat as success until confirmed.
 *
 * @param expectedShares  When set (FOK share-based buys), matched size must reach this (vs original_size). When omitted, any BUY fill counts.
 */
export async function verifyMarketOrderFilled(
    client: ClobClient,
    orderId: string,
    expectedShares?: number,
    opts?: { maxWaitMs?: number; pollMs?: number }
): Promise<{ ok: boolean; matched: number; error?: string }> {
    const maxWaitMs = opts?.maxWaitMs ?? 5000;
    const pollMs = opts?.pollMs ?? 200;
    const deadline = Date.now() + maxWaitMs;
    let lastMatched = 0;
    const eps = 1e-4;

    while (Date.now() < deadline) {
        try {
            const o = await client.getOrder(orderId);
            const matched = parseFloat(o?.size_matched || '0');
            lastMatched = matched;
            const orig = parseFloat(o?.original_size || '0');
            const st = (o?.status || '').toUpperCase();

            if (matched > eps) {
                if (expectedShares == null || expectedShares <= 0) {
                    return { ok: true, matched };
                }
                if (st === 'MATCHED' || st === 'FILLED') {
                    return { ok: true, matched };
                }
                const target = orig > 0 ? Math.min(orig, expectedShares) : expectedShares;
                // FOK clips: accept only near-full fills (not loose 98% vs full-share accounting).
                if (matched + eps >= target - 0.02 || matched + eps >= expectedShares - 0.02) {
                    return { ok: true, matched };
                }
                if (matched + eps >= target * 0.998 || matched + eps >= expectedShares * 0.998) {
                    return { ok: true, matched };
                }
            }

            if ((st === 'CANCELLED' || st === 'EXPIRED') && matched <= eps) {
                return {
                    ok: false,
                    matched: 0,
                    error: `Market order ended ${st} with no fill`,
                };
            }
        } catch {
            /* retry until deadline */
        }
        await sleep(pollMs);
    }

    if (lastMatched <= eps) {
        return {
            ok: false,
            matched: 0,
            error:
                expectedShares != null && expectedShares > 0
                    ? `No confirmed fill for order ${orderId.slice(0, 12)}… (expected ~${expectedShares} sh)`
                    : `No confirmed fill for market order ${orderId.slice(0, 12)}…`,
        };
    }
    return { ok: true, matched: lastMatched };
}

/** A placed order we're tracking for fill status */
export interface PendingOrder {
    orderId: string;
    tokenId: string;
    side: 'YES' | 'NO';
    price: number;
    sizeRequested: number;
    sizeFilled: number; // how many shares have been confirmed filled so far
    costFilled: number; // total cost of confirmed fills
    placedAt: string; // ISO timestamp
    status: 'open' | 'filled' | 'partial' | 'cancelled' | 'unknown';
}

/** Result of checking a pending order's fill status */
export interface FillUpdate {
    orderId: string;
    side: 'YES' | 'NO';
    newFillQty: number; // NEW shares filled since last check (delta)
    newFillCost: number; // NEW cost since last check (delta), includes fee model when enabled
    /** Limit / venue notional price for this delta (before all-in fee term). */
    unitPriceRaw?: number;
    orderDone: boolean; // true if order is fully filled or cancelled (remove from pending)
}

/**
 * Resolve tick size string to the TickSize union type expected by the CLOB client.
 * Valid values: "0.1" | "0.01" | "0.001" | "0.0001"
 */
function resolveTickSize(config: StrategyConfig): TickSize {
    const ts = config.tickSize ?? 0.01;
    if (ts === 0.1) return '0.1';
    if (ts === 0.001) return '0.001';
    if (ts === 0.0001) return '0.0001';
    return '0.01'; // default
}

// ─── Orderbook ───────────────────────────────────────────────────────────

/**
 * Fetch orderbook for a token from CLOB.
 */
export async function getOrderBook(
    client: ClobClient,
    tokenId: string
): Promise<{
    bids: Array<{ price: string; size: string }>;
    asks: Array<{ price: string; size: string }>;
}> {
    try {
        const book = await client.getOrderBook(tokenId);
        const bids = (book?.bids || []).map((b: { price: string; size: string }) => ({
            price: b.price,
            size: b.size,
        }));
        const asks = (book?.asks || []).map((a: { price: string; size: string }) => ({
            price: a.price,
            size: a.size,
        }));
        return { bids, asks };
    } catch (err) {
        console.error(`[orderManager] getOrderBook failed for ${tokenId.slice(0, 12)}...:`, err);
        return { bids: [], asks: [] };
    }
}

/**
 * Get orderbook snapshots for both YES and NO tokens.
 * When `wsFeed` is provided and has fresh data, uses WebSocket stream; otherwise REST (CLOB HTTP).
 */
export async function getBothOrderBooks(
    client: ClobClient,
    market: ActiveMarket,
    wsFeed?: ClobOrderbookWs | null
): Promise<{ bookYes: OrderBookSnapshot; bookNo: OrderBookSnapshot }> {
    const fromWs = wsFeed?.tryGetBothOrderBooks(market) ?? null;
    if (fromWs) return fromWs;

    const [yesBook, noBook] = await Promise.all([
        getOrderBook(client, market.yesTokenId),
        getOrderBook(client, market.noTokenId),
    ]);
    const bookYes = orderBookFromClob(market.yesTokenId, 'YES', yesBook.bids, yesBook.asks);
    const bookNo = orderBookFromClob(market.noTokenId, 'NO', noBook.bids, noBook.asks);
    return { bookYes, bookNo };
}

// ─── Order Placement ─────────────────────────────────────────────────────

/**
 * Place a single limit buy order (GTC). Returns success + orderId or error.
 */
export async function placeLimitBuyOrder(
    client: ClobClient,
    tokenId: string,
    price: number,
    size: number,
    config: StrategyConfig,
    negRisk: boolean
): Promise<OrderResult> {
    // Polymarket CLOB requires minimum $1.00 per order
    const orderDollarAmount = price * size;
    if (orderDollarAmount < 1.0) {
        const msg = `Order too small: ${size} shares × $${price.toFixed(4)} = $${orderDollarAmount.toFixed(2)} < $1.00 CLOB minimum`;
        console.error(`[orderManager] ${msg}`);
        return { success: false, error: msg };
    }

    try {
        const tickSize = resolveTickSize(config);
        const resp = await client.createAndPostOrder(
            {
                tokenID: tokenId,
                price,
                side: Side.BUY,
                size,
            },
            { tickSize, negRisk },
            OrderType.GTC
        );

        const parsed = parsePostOrderResponse(resp);
        if (!parsed.ok || !parsed.orderId) {
            const errorMsg = parsed.error ?? 'Order rejected by CLOB';
            console.error(`[orderManager] Order rejected:`, errorMsg);
            return { success: false, error: errorMsg };
        }
        return { success: true, orderId: parsed.orderId };
    } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        console.error(`[orderManager] placeLimitBuyOrder failed: ${message}`);
        return { success: false, error: message };
    }
}

/**
 * Place a market buy order with strict safeguards.
 * Uses the CLOB client's createAndPostMarketOrder with FOK (Fill Or Kill).
 *
 * Safeguards:
 *   - Requires bestAskPrice to verify slippage before placing
 *   - Rejects if best ask >= $0.99 (too expensive)
 *   - Caps slippage to maxSlippageBps above best ask
 *   - Amount capped at config.maxSingleOrderUsd (USD) when set, else config.orderSizeShares × limit price
 *   - FOK ensures the order fills entirely or not at all (no partial resting)
 */
export async function placeMarketBuyOrder(
    client: ClobClient,
    tokenId: string,
    bestAskPrice: number,
    amountUsd: number,
    config: StrategyConfig,
    negRisk: boolean,
    maxSlippageBps: number = 50 // default 50 bps = 0.5% max slippage
): Promise<OrderResult> {
    try {
        // Safeguard 1: reject if best ask is unreasonably high
        if (bestAskPrice >= 0.99) {
            return {
                success: false,
                error: 'Market order rejected: best ask >= $0.99 (too expensive)',
            };
        }

        // Safeguard 2: set limit price with slippage cap
        const slippageFactor = 1 + maxSlippageBps / 10000;
        const maxPrice = Math.min(bestAskPrice * slippageFactor, 0.99);
        const limitPrice = Math.round(maxPrice * 100) / 100;

        // Safeguard 3: cap amount (prefer maxSingleOrderUsd when configured)
        const maxSpendUsd =
            config.maxSingleOrderUsd != null && config.maxSingleOrderUsd > 0
                ? config.maxSingleOrderUsd
                : config.orderSizeShares * limitPrice;
        const cappedAmount = Math.min(amountUsd, maxSpendUsd);

        const tickSize = resolveTickSize(config);

        // Use createAndPostMarketOrder with FOK
        const resp = await client.createAndPostMarketOrder(
            {
                tokenID: tokenId,
                price: limitPrice,
                amount: cappedAmount,
                side: Side.BUY,
            },
            { tickSize, negRisk },
            OrderType.FOK
        );

        const parsed = parsePostOrderResponse(resp);
        if (!parsed.ok || !parsed.orderId) {
            const errorMsg = parsed.error ?? 'Market order rejected by CLOB';
            console.error(`[orderManager] Market order rejected:`, errorMsg);
            return { success: false, error: errorMsg };
        }

        const verified = await verifyMarketOrderFilled(client, parsed.orderId, undefined, {
            maxWaitMs: 6000,
            pollMs: 200,
        });
        if (!verified.ok) {
            console.error(`[orderManager] Market order not filled:`, verified.error);
            return {
                success: false,
                error: verified.error ?? 'Market order produced no confirmed fill',
            };
        }
        return { success: true, orderId: parsed.orderId };
    } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        console.error(`[orderManager] placeMarketBuyOrder failed: ${message}`);
        return { success: false, error: message };
    }
}

/**
 * Replace an existing order: cancel the old one, then place a new one.
 * This is the standard approach for order replacement on CLOB systems.
 */
export async function replaceOrder(
    client: ClobClient,
    oldOrderId: string,
    tokenId: string,
    newPrice: number,
    newSize: number,
    config: StrategyConfig,
    negRisk: boolean
): Promise<OrderResult> {
    try {
        // Step 1: Cancel existing order
        await client.cancelOrder({ orderID: oldOrderId });

        // Step 2: Place new order
        return await placeLimitBuyOrder(client, tokenId, newPrice, newSize, config, negRisk);
    } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        console.error(`[orderManager] replaceOrder failed: ${message}`);
        return { success: false, error: message };
    }
}

/**
 * Create a PendingOrder record after successful order placement.
 */
export function createPendingOrder(
    orderId: string,
    tokenId: string,
    side: 'YES' | 'NO',
    price: number,
    size: number
): PendingOrder {
    return {
        orderId,
        tokenId,
        side,
        price,
        sizeRequested: size,
        sizeFilled: 0,
        costFilled: 0,
        placedAt: new Date().toISOString(),
        status: 'open',
    };
}

// ─── Fill Reconciliation ─────────────────────────────────────────────────

/**
 * Check the fill status of a single pending order.
 * Uses getOrder() to check size_matched from the OpenOrder response.
 * Falls back to checking getOpenOrders() if getOrder() fails.
 */
async function checkOrderFillStatus(
    client: ClobClient,
    pending: PendingOrder,
    opts?: { feeScalar?: number }
): Promise<FillUpdate> {
    const noUpdate: FillUpdate = {
        orderId: pending.orderId,
        side: pending.side,
        newFillQty: 0,
        newFillCost: 0,
        orderDone: false,
    };

    try {
        // Try getOrder() to get detailed fill info
        const order: OpenOrder = await client.getOrder(pending.orderId);
        if (order) {
            const sizeMatched = parseFloat(order.size_matched || '0');
            const originalSize = parseFloat(order.original_size || String(pending.sizeRequested));
            const status = (order.status || '').toUpperCase();

            // Calculate new fills since last check
            const totalFilled = Math.min(sizeMatched, originalSize);
            const newFillQty = Math.max(0, totalFilled - pending.sizeFilled);
            const px = parseFloat(order.price || String(pending.price));
            const fillPx = Number.isFinite(px) && px > 0 ? px : pending.price;
            const k = opts?.feeScalar;
            const unitAllIn =
                k != null && k > 0 && fillPx > 0 && fillPx < 1
                    ? binaryOutcomeBuyAllInPerShare(fillPx, k)
                    : fillPx;
            const newFillCost = newFillQty * unitAllIn;

            const isDone =
                status === 'MATCHED' ||
                status === 'FILLED' ||
                status === 'CANCELLED' ||
                status === 'EXPIRED' ||
                totalFilled >= originalSize;

            return {
                orderId: pending.orderId,
                side: pending.side,
                newFillQty,
                newFillCost,
                unitPriceRaw: fillPx,
                orderDone: isDone,
            };
        }

        return noUpdate;
    } catch {
        // getOrder() failed — fall back to checking open orders list
        try {
            const openOrders = await client.getOpenOrders();
            const stillOpen = openOrders.some((o: OpenOrder) => o.id === pending.orderId);

            if (!stillOpen) {
                // Conservative handling: if we cannot fetch authoritative order status
                // and the order is no longer open, do NOT assume it fully filled.
                // It might have been cancelled/expired/rejected.
                return { ...noUpdate, orderDone: true };
            }
            return noUpdate;
        } catch (innerErr) {
            console.error(
                `[orderManager] checkOrderFillStatus error for ${pending.orderId}:`,
                innerErr
            );
            return noUpdate;
        }
    }
}

/**
 * Reconcile all pending orders: check fills and return updates.
 * Called each tick by the bot to get actual fill data.
 *
 * SAFETY: Skips orders with orderId "unknown" — those were never placed on CLOB.
 */
export async function reconcilePendingOrders(
    client: ClobClient,
    pendingOrders: PendingOrder[],
    opts?: { feeScalar?: number }
): Promise<{ fills: FillUpdate[]; updatedPending: PendingOrder[] }> {
    if (pendingOrders.length === 0) return { fills: [], updatedPending: [] };

    const fills: FillUpdate[] = [];
    const updatedPending: PendingOrder[] = [];

    for (const pending of pendingOrders) {
        // Never reconcile phantom orders that were rejected by CLOB
        if (!pending.orderId || pending.orderId === 'unknown') {
            console.warn(
                `[orderManager] Dropping phantom order (no real orderId) for ${pending.side} ${pending.sizeRequested} @ ${pending.price}`
            );
            continue; // drop it — it was never placed
        }

        const update = await checkOrderFillStatus(client, pending, opts);

        if (update.newFillQty > 0) {
            fills.push(update);
        }

        if (!update.orderDone) {
            updatedPending.push({
                ...pending,
                sizeFilled: pending.sizeFilled + update.newFillQty,
                costFilled: pending.costFilled + update.newFillCost,
                status: update.newFillQty > 0 ? 'partial' : pending.status,
            });
        }
        // If orderDone, don't add to updatedPending (order is complete)
    }

    return { fills, updatedPending };
}

// ─── Instant Execution (FOK) ─────────────────────────────────────────────

const TRADES_PAGINATION_END = 'LTE=';

/**
 * Matched size and USD cost after a FOK BUY. Prefers `getTrades` rows for this taker order (VWAP);
 * falls back to `size_matched` × order limit price.
 */
export async function resolveFokBuyFillDetails(
    client: ClobClient,
    orderId: string,
    requestedShareCap: number,
    limitPriceFallback: number,
    opts?: { marketConditionId?: string; assetId?: string; feeScalar?: number }
): Promise<FokBuyFill | null> {
    let o: OpenOrder;
    try {
        o = await client.getOrder(orderId);
    } catch {
        return null;
    }
    const matched = parseFloat(o?.size_matched || '0');
    if (!(matched > 1e-9)) return null;
    const cap = requestedShareCap > 0 ? requestedShareCap : matched;
    const shares = Math.min(cap, matched);

    let costUsd: number | null = null;
    const cid = opts?.marketConditionId;
    const aid = opts?.assetId;
    if (cid && aid) {
        let nextCursor: string | undefined;
        for (let page = 0; page < 8; page++) {
            const res = await client.getTradesPaginated({ market: cid }, nextCursor);
            const batch = res?.trades ?? [];
            let sum = 0;
            for (const t of batch) {
                if (!t || t.side !== Side.BUY) continue;
                if (t.taker_order_id !== orderId) continue;
                if (t.asset_id !== aid) continue;
                const sz = parseFloat(t.size || '0');
                const px = parseFloat(t.price || '0');
                if (sz > 0 && px > 0) sum += sz * px;
            }
            if (sum > 1e-9) {
                costUsd = sum;
                break;
            }
            const nc = (res as { next_cursor?: string }).next_cursor;
            if (!nc || nc === TRADES_PAGINATION_END || nc === nextCursor) break;
            nextCursor = nc;
        }
    }

    const pxOrder = parseFloat(o?.price || '0');
    const lim = Number.isFinite(pxOrder) && pxOrder > 0 ? pxOrder : limitPriceFallback;
    if (costUsd == null || !(costUsd > 0)) {
        costUsd = shares * lim;
    }
    let avgPriceUsd = shares > 1e-12 ? costUsd! / shares : lim;
    let costOut = costUsd!;
    const k = opts?.feeScalar;
    if (k != null && k > 0 && shares > 1e-12 && avgPriceUsd > 0 && avgPriceUsd < 1) {
        avgPriceUsd = binaryOutcomeBuyAllInPerShare(avgPriceUsd, k);
        costOut = shares * avgPriceUsd;
    }
    return { shares, costUsd: costOut, avgPriceUsd };
}

/**
 * Buy instantly using FOK (Fill or Kill) market order at the ask price.
 * The order fills entirely or is killed — never rests on the book.
 *
 * @param askPrice  The best ask price (our limit/slippage cap)
 * @param shares    Number of shares to buy
 * @param opts.marketConditionId  When set, resolves true fill cost via `getTrades` for this market.
 * @param opts.verifyMaxWaitMs     Poll window for `getOrder` fill confirmation (default 6000).
 * @param opts.verifyPollMs        Poll interval ms (default 200).
 */
export async function buyInstant(
    client: ClobClient,
    tokenId: string,
    askPrice: number,
    shares: number,
    config: StrategyConfig,
    negRisk: boolean,
    opts?: { marketConditionId?: string; verifyMaxWaitMs?: number; verifyPollMs?: number }
): Promise<OrderResult> {
    try {
        const tickSize = resolveTickSize(config);
        const ts = config.tickSize || 0.01;
        // Add 1 tick buffer above ask for slippage protection (cap at 0.99 like strategy FOK limits)
        const priceWithBuffer = Math.min(
            0.99,
            Math.round((askPrice + ts) * 100) / 100
        );
        const buyAmountUsd = shares * priceWithBuffer;

        if (buyAmountUsd < 1.0) {
            return {
                success: false,
                error: `Order $${buyAmountUsd.toFixed(2)} < $1.00 CLOB min (at limit $${priceWithBuffer.toFixed(4)} × ${shares} sh)`,
            };
        }

        const resp = await client.createAndPostMarketOrder(
            {
                tokenID: tokenId,
                price: priceWithBuffer,
                amount: buyAmountUsd,
                side: Side.BUY,
            },
            { tickSize, negRisk },
            OrderType.FOK
        );

        const parsed = parsePostOrderResponse(resp);
        if (!parsed.ok || !parsed.orderId) {
            const errorMsg = parsed.error ?? 'FOK buy rejected by CLOB';
            return { success: false, error: errorMsg };
        }

        const verified = await verifyMarketOrderFilled(client, parsed.orderId, shares, {
            maxWaitMs: opts?.verifyMaxWaitMs ?? 6000,
            pollMs: opts?.verifyPollMs ?? 200,
        });
        if (!verified.ok) {
            return {
                success: false,
                error: verified.error ?? 'FOK buy produced no confirmed fill',
            };
        }

        const feeScalar = config.binaryOutcomeTakerFeeScalar ?? 0.072;
        let fokFill =
            (await resolveFokBuyFillDetails(client, parsed.orderId, shares, priceWithBuffer, {
                marketConditionId: opts?.marketConditionId,
                assetId: tokenId,
                feeScalar,
            })) ?? null;

        if (!fokFill && verified.matched > 1e-9) {
            const m = Math.min(shares, verified.matched);
            fokFill = {
                shares: m,
                costUsd: m * priceWithBuffer,
                avgPriceUsd: priceWithBuffer,
            };
        }
        if (!fokFill || !(fokFill.shares > 0) || !(fokFill.costUsd > 0)) {
            return {
                success: false,
                error: 'FOK buy confirmed but could not resolve matched size/cost from CLOB',
            };
        }

        return { success: true, orderId: parsed.orderId, fokFill };
    } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        console.error(`[orderManager] buyInstant failed: ${message}`);
        return { success: false, error: message };
    }
}

/**
 * Sell instantly using FOK (Fill or Kill) market order at the bid price.
 * Used to exit positions when the other side fails to fill (sell-back safety).
 *
 * Max loss = spread × shares (typically 2-3%).
 *
 * @param bidPrice  The best bid price (our minimum acceptable sell price)
 * @param shares    Number of shares to sell
 */
export async function sellInstant(
    client: ClobClient,
    tokenId: string,
    bidPrice: number,
    shares: number,
    config: StrategyConfig,
    negRisk: boolean
): Promise<OrderResult> {
    try {
        const tickSize = resolveTickSize(config);
        const ts = config.tickSize || 0.01;
        // Subtract 1 tick from bid for slippage tolerance
        const priceWithBuffer = Math.max(ts, Math.round((bidPrice - ts) * 100) / 100);

        const resp = await client.createAndPostMarketOrder(
            {
                tokenID: tokenId,
                price: priceWithBuffer,
                amount: shares, // For SELL orders, amount = number of shares
                side: Side.SELL,
            },
            { tickSize, negRisk },
            OrderType.FOK
        );

        const orderId = resp?.orderID ?? resp?.id;
        if (!orderId || orderId === 'unknown') {
            const errorMsg =
                (resp as Record<string, unknown>)?.error ??
                (resp as Record<string, unknown>)?.message ??
                'FOK sell rejected by CLOB';
            return { success: false, error: String(errorMsg) };
        }
        return { success: true, orderId: String(orderId) };
    } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        console.error(`[orderManager] sellInstant failed: ${message}`);
        return { success: false, error: message };
    }
}

// ─── Cancellation ────────────────────────────────────────────────────────

/**
 * Cancel all open orders for a given token.
 * Uses cancelMarketOrders for targeted cancellation, falls back to cancelAll.
 */
export async function cancelOpenOrders(
    client: ClobClient,
    tokenId: string
): Promise<{ cancelled: number; error?: string }> {
    try {
        // Try targeted cancel by asset_id first
        try {
            await client.cancelMarketOrders({ asset_id: tokenId });
            return { cancelled: -1 }; // -1 = bulk cancel (count unknown)
        } catch {
            // cancelMarketOrders not available or failed, try manual approach
        }

        // Get open orders and cancel matching ones
        const openOrders = await client.getOpenOrders({ asset_id: tokenId });
        let cancelled = 0;
        for (const order of openOrders) {
            if (order.asset_id === tokenId && order.id) {
                try {
                    await client.cancelOrder({ orderID: order.id });
                    cancelled++;
                } catch (cancelErr) {
                    console.error(`[orderManager] Failed to cancel order ${order.id}:`, cancelErr);
                }
            }
        }
        return { cancelled };
    } catch (err) {
        // Last resort: cancel ALL orders
        try {
            await client.cancelAll();
            return { cancelled: -1 };
        } catch {
            const message = err instanceof Error ? err.message : String(err);
            console.error(`[orderManager] cancelOpenOrders error:`, message);
            return { cancelled: 0, error: message };
        }
    }
}
