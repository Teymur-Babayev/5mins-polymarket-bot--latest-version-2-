/**
 * Order history for dashboard export: per-fill snapshot (BTC, Up/Down prices, After PnL),
 * persisted on a 5-minute interval, Excel download with profitable vs unprofitable windows.
 */

import * as fs from 'fs';
import * as path from 'path';
import ExcelJS from 'exceljs';
import type { SettlementWinnerSource } from './btcUpDownSettlement';

export type OrderHistoryMarketOutcome = 'profitable' | 'unprofitable' | 'pending';

export interface OrderHistoryEntry {
    id: string;
    timestampIso: string;
    windowSlug: string;
    windowEndIso: string;
    /** Polymarket condition id — ties rows to CLOB / on-chain market. */
    conditionId?: string;
    btcMarketWindowMinutes: 5 | 15;
    liveTrading: boolean;
    side: 'YES' | 'NO';
    orderSizeShares: number;
    /** All-in USD per share (includes fee model when used). */
    fillPriceUsd: number;
    /** Venue/limit notional price before the `p + k·p·(1−p)` fee term. */
    fillPriceRawUsd?: number;
    /** Total fee USD attributed to this fill under the fee model (`(all-in − raw) × shares`). */
    feeModelUsdOnFill?: number;
    /** After a leg at all-in `a`, approximate max other-leg bid: `1 − a − margin`. */
    pairSecondLegTargetBidUsd?: number;
    costUsd: number;
    btcUsdWindowOpen: number | null;
    /** Snapshot at window settlement (same for all rows in that window once settled). */
    btcUsdWindowEnd?: number | null;
    btcUsdAtOrder: number | null;
    upBestBidUsd: number;
    downBestBidUsd: number;
    upBestAskUsd: number;
    downBestAskUsd: number;
    afterPnlIfUpUsd: number;
    afterPnlIfDownUsd: number;
    /** If Up wins: qtyYes − notional spent (excludes modeled taker commission); used vs `minDualAfterPnlUsd`. */
    afterPnlIfUpExcludingCommissionUsd?: number;
    afterPnlIfDownExcludingCommissionUsd?: number;
    /** Filled when the window is settled in logWindowEndSummary */
    windowNetProfitUsd: number | null;
    marketOutcome: OrderHistoryMarketOutcome;
    /** Settled outcome (Up/Down); UNKNOWN when resolution not yet in log */
    winnerSide?: 'YES' | 'NO' | 'UNKNOWN';
    settlementWinnerSource?: SettlementWinnerSource;
    reasonCode?: string;
}

const entries: OrderHistoryEntry[] = [];
let idCounter = 0;

const DATA_DIR = process.env.ORDER_HISTORY_DATA_DIR || path.join(process.cwd(), 'data');
const SNAPSHOT_FILE = path.join(DATA_DIR, 'order-history.json');

let persistInterval: ReturnType<typeof setInterval> | null = null;

function nextId(): string {
    idCounter += 1;
    return `ord-${Date.now()}-${idCounter}`;
}

export function loadOrderHistoryFromDisk(): void {
    try {
        if (!fs.existsSync(SNAPSHOT_FILE)) return;
        const raw = JSON.parse(fs.readFileSync(SNAPSHOT_FILE, 'utf8')) as unknown;
        if (!Array.isArray(raw)) return;
        entries.length = 0;
        for (const row of raw) {
            if (row && typeof row === 'object') entries.push(row as OrderHistoryEntry);
        }
    } catch {
        /* ignore corrupt file */
    }
}

export function flushOrderHistoryToDisk(): void {
    try {
        if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
        fs.writeFileSync(SNAPSHOT_FILE, JSON.stringify(entries, null, 2), 'utf8');
    } catch (e) {
        console.warn('[OrderHistory] Could not persist snapshot:', e);
    }
}

/** Flush to disk every 5 minutes (and load existing data on start). */
export function startOrderHistoryPersistence(intervalMs = 5 * 60 * 1000): void {
    if (persistInterval) clearInterval(persistInterval);
    persistInterval = setInterval(() => flushOrderHistoryToDisk(), intervalMs);
}

export function stopOrderHistoryPersistence(): void {
    if (persistInterval) {
        clearInterval(persistInterval);
        persistInterval = null;
    }
}

export function pushOrderHistoryEntry(
    partial: Omit<OrderHistoryEntry, 'id' | 'marketOutcome' | 'windowNetProfitUsd'> & {
        marketOutcome?: OrderHistoryMarketOutcome;
        windowNetProfitUsd?: number | null;
        conditionId?: string;
    }
): OrderHistoryEntry {
    const e: OrderHistoryEntry = {
        id: nextId(),
        marketOutcome: partial.marketOutcome ?? 'pending',
        windowNetProfitUsd: partial.windowNetProfitUsd ?? null,
        ...partial,
    };
    entries.push(e);
    return e;
}

export function markWindowOrderHistorySettlement(
    windowEndIso: string,
    netProfitUsd: number,
    winnerSide?: 'YES' | 'NO' | 'UNKNOWN',
    extras?: {
        btcUsdWindowOpen?: number | null;
        btcUsdWindowEnd?: number | null;
        settlementWinnerSource?: SettlementWinnerSource;
    }
): void {
    const profitable = netProfitUsd > 0;
    const outcome: OrderHistoryMarketOutcome = profitable ? 'profitable' : 'unprofitable';
    for (const e of entries) {
        if (e.windowEndIso === windowEndIso) {
            e.windowNetProfitUsd = netProfitUsd;
            e.marketOutcome = outcome;
            if (winnerSide !== undefined) {
                e.winnerSide = winnerSide;
            }
            if (extras?.btcUsdWindowOpen !== undefined) {
                e.btcUsdWindowOpen = extras.btcUsdWindowOpen;
            }
            if (extras?.btcUsdWindowEnd !== undefined) {
                e.btcUsdWindowEnd = extras.btcUsdWindowEnd;
            }
            if (extras?.settlementWinnerSource !== undefined) {
                e.settlementWinnerSource = extras.settlementWinnerSource;
            }
        }
    }
}

/** One market window worth of rows (same windowEnd + condition), orders chronological. */
export interface OrderHistoryWindowAggregate {
    windowEndIso: string;
    conditionId?: string;
    windowSlug: string;
    btcMarketWindowMinutes: 5 | 15;
    liveTrading: boolean;
    orders: OrderHistoryEntry[];
}

/** Group entries into windows; newest window first. */
export function listOrderHistoryWindowsDesc(entries: OrderHistoryEntry[]): OrderHistoryWindowAggregate[] {
    const map = new Map<string, OrderHistoryEntry[]>();
    for (const e of entries) {
        const key = `${e.windowEndIso}\0${e.conditionId ?? ''}`;
        if (!map.has(key)) map.set(key, []);
        map.get(key)!.push(e);
    }
    for (const list of map.values()) {
        list.sort((a, b) => new Date(a.timestampIso).getTime() - new Date(b.timestampIso).getTime());
    }
    const agg: OrderHistoryWindowAggregate[] = [];
    for (const orders of map.values()) {
        const first = orders[0];
        agg.push({
            windowEndIso: first.windowEndIso,
            conditionId: first.conditionId,
            windowSlug: first.windowSlug,
            btcMarketWindowMinutes: first.btcMarketWindowMinutes,
            liveTrading: first.liveTrading,
            orders,
        });
    }
    agg.sort((a, b) => new Date(b.windowEndIso).getTime() - new Date(a.windowEndIso).getTime());
    return agg;
}

/**
 * Last 24h rollup from persisted order log (works for live + paper). One row per fill;
 * window-level net P/L counted once per window.
 */
export function getLast24hOrderHistorySummary(liveOnly: boolean): {
    netProfit: number;
    windowsCount: number;
    ordersCount: number;
    totalSpent: number;
    totalPayout: number;
} {
    const TWENTY_FOUR_H = 24 * 60 * 60 * 1000;
    const since = Date.now() - TWENTY_FOUR_H;
    const all = getOrderHistoryEntries().filter((e) => !liveOnly || e.liveTrading);
    const byWindow = new Map<string, OrderHistoryEntry[]>();
    for (const e of all) {
        const endMs = new Date(e.windowEndIso).getTime();
        if (Number.isNaN(endMs) || endMs < since) continue;
        const k = `${e.windowEndIso}\0${e.conditionId ?? ''}`;
        if (!byWindow.has(k)) byWindow.set(k, []);
        byWindow.get(k)!.push(e);
    }
    let netProfit = 0;
    let windowsCount = 0;
    let ordersCount = 0;
    let totalSpent = 0;
    let totalPayout = 0;
    for (const list of byWindow.values()) {
        windowsCount += 1;
        for (const e of list) {
            ordersCount += 1;
            totalSpent += e.costUsd;
        }
        const net = list.find((x) => x.windowNetProfitUsd != null)?.windowNetProfitUsd;
        const spent = list.reduce((s, x) => s + x.costUsd, 0);
        if (net != null) {
            netProfit += net;
            totalPayout += net + spent;
        }
    }
    return { netProfit, windowsCount, ordersCount, totalSpent, totalPayout };
}

export function getOrderHistoryEntries(): OrderHistoryEntry[] {
    return [...entries];
}

const HEADERS = [
    'Timestamp (UTC)',
    'Window slug',
    'Window end (ISO)',
    'BTC window (min)',
    'Mode',
    'Side',
    'Size (shares)',
    'Fill price all-in (USD/sh)',
    'Fill price raw (USD/sh)',
    'Fee model (USD)',
    'Pair 2nd leg max bid (est)',
    'Cost (USD)',
    'BTC USD at window open',
    'BTC USD at window end',
    'BTC USD at order',
    'Up (YES) best bid',
    'Down (NO) best bid',
    'Up (YES) best ask',
    'Down (NO) best ask',
    'After PnL if Up (USD)',
    'After PnL if Down (USD)',
    'After PnL Up ex-commission (USD)',
    'After PnL Down ex-commission (USD)',
    'Window net P/L (USD)',
    'Market outcome',
    'Winner source',
    'Reason code',
] as const;

function rowValues(e: OrderHistoryEntry): (string | number | null)[] {
    return [
        e.timestampIso,
        e.windowSlug,
        e.windowEndIso,
        e.btcMarketWindowMinutes,
        e.liveTrading ? 'LIVE' : 'PAPER',
        e.side === 'YES' ? 'Up (YES)' : 'Down (NO)',
        e.orderSizeShares,
        e.fillPriceUsd,
        e.fillPriceRawUsd ?? '',
        e.feeModelUsdOnFill ?? '',
        e.pairSecondLegTargetBidUsd ?? '',
        e.costUsd,
        e.btcUsdWindowOpen,
        e.btcUsdWindowEnd ?? '',
        e.btcUsdAtOrder,
        e.upBestBidUsd,
        e.downBestBidUsd,
        e.upBestAskUsd,
        e.downBestAskUsd,
        e.afterPnlIfUpUsd,
        e.afterPnlIfDownUsd,
        e.afterPnlIfUpExcludingCommissionUsd ?? '',
        e.afterPnlIfDownExcludingCommissionUsd ?? '',
        e.windowNetProfitUsd,
        e.marketOutcome,
        e.settlementWinnerSource ?? '',
        e.reasonCode ?? '',
    ];
}

function addSheet(workbook: ExcelJS.Workbook, name: string, rows: OrderHistoryEntry[]): void {
    const sheet = workbook.addWorksheet(name, {
        views: [{ state: 'frozen', ySplit: 1 }],
    });
    sheet.addRow([...HEADERS]);
    const headerRow = sheet.getRow(1);
    headerRow.font = { bold: true };
    for (const e of rows) {
        sheet.addRow(rowValues(e));
    }
    for (let c = 1; c <= HEADERS.length; c++) {
        sheet.getColumn(c).width = c === HEADERS.length ? 40 : 18;
    }
}

export async function buildOrderHistoryExcelBuffer(): Promise<Buffer> {
    const workbook = new ExcelJS.Workbook();
    workbook.creator = 'Polymarket hedge bot';
    workbook.created = new Date();

    const all = getOrderHistoryEntries();
    addSheet(workbook, 'All orders', all);
    addSheet(
        workbook,
        'Profitable windows',
        all.filter((e) => e.marketOutcome === 'profitable')
    );
    addSheet(
        workbook,
        'Unprofitable windows',
        all.filter((e) => e.marketOutcome === 'unprofitable')
    );
    addSheet(
        workbook,
        'Pending settlement',
        all.filter((e) => e.marketOutcome === 'pending')
    );

    const buf = await workbook.xlsx.writeBuffer();
    return Buffer.isBuffer(buf) ? buf : Buffer.from(buf);
}
