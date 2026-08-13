export function createTokenBucket({ rpm = 30, now = () => Date.now() } = {}) {
    const windowMs = 60_000;
    const limit = Math.max(1, Number(rpm) || 30);
    const hits = [];

    return {
        take(n = 1) {
            const t = now();
            while (hits.length && t - hits[0] >= windowMs) hits.shift();
            if (hits.length + n > limit) {
                return { ok: false, remaining: 0, retryAfterMs: windowMs - (t - hits[0]) };
            }
            for (let i = 0; i < n; i += 1) hits.push(t);
            return { ok: true, remaining: limit - hits.length, retryAfterMs: 0 };
        },
    };
}
