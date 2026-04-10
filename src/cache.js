const Redis = require('ioredis');

function createCache(redisUrl) {
    const redis = new Redis(redisUrl || 'redis://localhost:6379', {
        maxRetriesPerRequest: 1,
        lazyConnect: true,
        retryStrategy(times) {
            if (times > 3) return null;
            return Math.min(times * 500, 2000);
        },
    });

    let connected = false;

    redis.on('connect', () => { connected = true; });
    redis.on('close', () => { connected = false; });
    redis.on('error', (err) => {
        connected = false;
        console.error('Redis error:', err.message);
    });

    redis.connect().catch(() => {});

    return {
        async get(key) {
            if (!connected) return null;
            try {
                const val = await redis.get(key);
                return val ? JSON.parse(val) : null;
            } catch { return null; }
        },

        async set(key, value, ttlSeconds) {
            if (!connected) return;
            try {
                await redis.set(key, JSON.stringify(value), 'EX', ttlSeconds);
            } catch {}
        },

        async health() {
            try {
                const start = Date.now();
                await redis.ping();
                return { connected: true, latencyMs: Date.now() - start };
            } catch {
                return { connected: false, latencyMs: null };
            }
        },

        async close() {
            try { await redis.quit(); } catch {}
        },
    };
}

module.exports = { createCache };
