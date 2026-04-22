/**
 * Down (NO) best-ask momentum from rolling samples — linear velocity and naive extrapolation to window end.
 * Complements BTC gap momentum (dashboard) for early one-sided hedge decisions.
 */

export const DEFAULT_NO_ASK_SAMPLE_MAX_AGE_MS = 120_000;

export function pruneNoAskSamples(
    samples: Array<{ t: number; ask: number }>,
    maxAgeMs: number,
    nowMs: number = Date.now()
): Array<{ t: number; ask: number }> {
    const cut = nowMs - maxAgeMs;
    return samples.filter((s) => s.t >= cut).sort((a, b) => a.t - b.t);
}

/** $/s over oldest→newest sample in the window (null if not enough span). */
export function downAskVelocityUsdPerSec(
    samples: Array<{ t: number; ask: number }>,
    minSpanSec = 2
): number | null {
    if (samples.length < 2) return null;
    const first = samples[0];
    const last = samples[samples.length - 1];
    const dt = (last.t - first.t) / 1000;
    if (dt < minSpanSec) return null;
    return (last.ask - first.ask) / dt;
}

/** Naive linear extrapolation: ask_now + velocity * secondsLeft. */
export function extrapolateDownAskToWindowEnd(
    noAskNow: number,
    velocityUsdPerSec: number | null,
    secondsLeft: number
): number | null {
    if (velocityUsdPerSec == null || !Number.isFinite(velocityUsdPerSec)) return null;
    return noAskNow + velocityUsdPerSec * secondsLeft;
}
