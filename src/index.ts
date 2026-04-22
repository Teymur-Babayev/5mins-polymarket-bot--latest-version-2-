/**
 * Polymarket 15-minute crypto hedge bot.
 * Strategy: place orders on both YES and NO so combined cost per pair < $1.00 for locked-in profit.
 * Config: strategy.config.json + env. Dashboard: DASHBOARD_PORT (default 7106); DASHBOARD_ENABLED=0 to disable.
 */

import './config/env';
import ora from 'ora';
import createClobClient from './utils/createClobClient';
import { loadStrategyConfig } from './config/strategyConfig';
import {
    startDashboard,
    setManualBuyHandler,
    setAutoOppositeBuyHandler,
    isDashboardEnabled,
} from './services/dashboard';
import { HedgeBot } from './services/hedgeBot';
import { startHeartbeat, stopHeartbeat } from './services/heartbeat';
import { loadOrderHistoryFromDisk, startOrderHistoryPersistence } from './services/orderHistoryLog';
import {
    reportVersionToTelemetryServer,
    isTelemetryConfigured,
    getTelemetryBaseUrl,
    isTelemetryWsAck,
} from './services/telemetryClient';

async function main(): Promise<void> {
    console.log('Polymarket 15-Minute Crypto Hedge Bot\n');

    const configSpinner = ora('Loading strategy config...').start();
    const config = loadStrategyConfig();
    configSpinner.succeed(`Config loaded (target pair cost < ${config.targetPairCostMax}, live=${config.liveTrading})`);

    const clobSpinner = ora('Creating CLOB client...').start();
    const clobClient = await createClobClient();
    clobSpinner.succeed('CLOB client ready.');

    if (isTelemetryConfigured()) {
        const telBase = getTelemetryBaseUrl() ?? '';
        const telSpinner = ora(`Sending telemetry to ${telBase} ...`).start();
        const tel = await reportVersionToTelemetryServer();
        if (tel.posted && isTelemetryWsAck(tel.wsAck)) {
            telSpinner.succeed(
                `Telemetry OK — POST stored + WS ack: ${JSON.stringify(tel.wsAck).slice(0, 120)}${JSON.stringify(tel.wsAck).length > 120 ? '…' : ''}`
            );
        } else if (tel.posted && !isTelemetryWsAck(tel.wsAck)) {
            telSpinner.warn(
                `Telemetry: POST reached server but no valid WS ack (${tel.error ?? 'check TELEMETRY_SECRET, firewalls, or stray WS traffic'})`
            );
        } else if (!tel.posted && isTelemetryWsAck(tel.wsAck)) {
            telSpinner.warn(
                'Telemetry: WS hello ok but POST failed — http_bot_version not stored; fix POST (e.g. TELEMETRY_SECRET header vs server).'
            );
        } else {
            const base = getTelemetryBaseUrl() ?? '';
            const remoteHint =
                /127\.0\.0\.1|localhost/i.test(base) &&
                (tel.error?.includes('ECONNREFUSED') ||
                    tel.error?.includes('fetch failed') ||
                    tel.error?.includes('connect'))
                    ? ' Check REMOTE_TELEMETRY_BASE_URL in src/services/telemetryClient.ts and open TCP 8787 on the collector host.'
                    : '';
            telSpinner.warn(`Telemetry: ${tel.error ?? 'POST failed'}${remoteHint}`);
        }
    } else {
        console.log(
            '[Bot] Telemetry skipped: set REMOTE_TELEMETRY_BASE_URL in telemetryClient.ts for a remote collector, or VERSION for local http://127.0.0.1:8787.'
        );
    }

    loadOrderHistoryFromDisk();
    startOrderHistoryPersistence();

    const dashOn = isDashboardEnabled();
    const dashPort = parseInt(process.env.DASHBOARD_PORT || '', 10) || 7106;
    if (dashOn) {
        startDashboard(dashPort);
    }

    const bot = new HedgeBot({
        config,
        clobClient,
    });
    setManualBuyHandler((side, shares) => bot.executeManualBuy(side, shares));
    setAutoOppositeBuyHandler(() => bot.executeManualAutoOppositeBuy());
    bot.start();
    startHeartbeat();
    if (dashOn) {
        console.log('Bot started. Dashboard: http://localhost:' + dashPort);
    } else {
        console.log('Bot started. Local dashboard off (DASHBOARD_ENABLED).');
    }
    console.log('Press Ctrl+C to stop.\n');

    process.on('SIGINT', () => {
        stopHeartbeat();
        bot.stop();
        process.exit(0);
    });
    process.on('SIGTERM', () => {
        stopHeartbeat();
        bot.stop();
        process.exit(0);
    });
}

main().catch((err) => {
    console.error('Fatal error:', err);
    process.exit(1);
});
