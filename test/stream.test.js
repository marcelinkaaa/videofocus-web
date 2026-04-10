const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const { createStreamRouter } = require('../src/routes/stream');

const SAMPLE_YTDLP_OUTPUT = {
    title: 'Test Video',
    channel: 'Test Channel',
    duration: 120,
    formats: [
        { format_id: '18', ext: 'mp4', vcodec: 'avc1.42001E', acodec: 'mp4a.40.2', height: 360, width: 640, url: 'https://rr1.googlevideo.com/360?expire=9999999999', tbr: 500 },
        { format_id: '22', ext: 'mp4', vcodec: 'avc1.64001F', acodec: 'mp4a.40.2', height: 720, width: 1280, url: 'https://rr1.googlevideo.com/720?expire=9999999999', tbr: 1500 },
        { format_id: '137', ext: 'mp4', vcodec: 'avc1.640028', acodec: 'none', height: 1080, width: 1920, url: 'https://rr1.googlevideo.com/1080v?expire=9999999999', tbr: 4000 },
        { format_id: '140', ext: 'm4a', vcodec: 'none', acodec: 'mp4a.40.2', height: null, width: null, url: 'https://rr1.googlevideo.com/audio?expire=9999999999', tbr: 128 },
    ],
};

function makeApp(opts = {}) {
    const store = {};
    const stubCache = {
        async get(key) { return store[key] || null; },
        async set(key, value, ttl) { store[key] = value; },
    };
    const stubYtdlp = {
        extractFormats: opts.extractFn || (async () => SAMPLE_YTDLP_OUTPUT),
        pickStreams: require('../src/ytdlp').pickStreams,
        parseExpiry: require('../src/ytdlp').parseExpiry,
    };

    const app = express();
    const router = createStreamRouter({
        cache: opts.cache || stubCache,
        ytdlp: stubYtdlp,
        apiKey: 'test-key',
    });
    app.use('/api/v1', router);
    return { app, store };
}

function request(app, path, headers = {}) {
    return new Promise((resolve) => {
        const server = app.listen(0, () => {
            const port = server.address().port;
            fetch(`http://localhost:${port}${path}`, { headers })
                .then(async (res) => {
                    const body = await res.json().catch(() => null);
                    server.close();
                    resolve({ status: res.status, body });
                });
        });
    });
}

describe('GET /api/v1/stream/:videoId', () => {
    it('returns 400 for invalid videoId', async () => {
        const { app } = makeApp();
        const res = await request(app, '/api/v1/stream/bad!id', { authorization: 'Bearer test-key' });
        assert.equal(res.status, 400);
    });

    it('returns 401 without API key', async () => {
        const { app } = makeApp();
        const res = await request(app, '/api/v1/stream/dQw4w9WgXcQ');
        assert.equal(res.status, 401);
    });

    it('returns streams on cache miss', async () => {
        const { app } = makeApp();
        const res = await request(app, '/api/v1/stream/dQw4w9WgXcQ', { authorization: 'Bearer test-key' });
        assert.equal(res.status, 200);
        assert.equal(res.body.videoId, 'dQw4w9WgXcQ');
        assert.ok(res.body.streams.muxed);
        assert.ok(res.body.streams.video);
        assert.ok(res.body.streams.audio);
        assert.equal(res.body.cached, false);
    });

    it('returns cached result on cache hit', async () => {
        const cachedData = { videoId: 'dQw4w9WgXcQ', title: 'Cached', cached: true, streams: { muxed: {}, video: {}, audio: {} } };
        const store = { 'stream:dQw4w9WgXcQ': cachedData };
        const cache = {
            async get(key) { return store[key] || null; },
            async set() {},
        };
        const { app } = makeApp({ cache });
        const res = await request(app, '/api/v1/stream/dQw4w9WgXcQ', { authorization: 'Bearer test-key' });
        assert.equal(res.status, 200);
        assert.equal(res.body.cached, true);
    });

    it('returns 502 when extraction fails', async () => {
        const { app } = makeApp({ extractFn: async () => { throw new Error('yt-dlp failed'); } });
        const res = await request(app, '/api/v1/stream/dQw4w9WgXcQ', { authorization: 'Bearer test-key' });
        assert.equal(res.status, 502);
    });

    it('returns 504 when extraction times out', async () => {
        const { app } = makeApp({
            extractFn: async () => { const e = new Error('timeout'); e.message = 'yt-dlp timed out'; throw e; },
        });
        const res = await request(app, '/api/v1/stream/dQw4w9WgXcQ', { authorization: 'Bearer test-key' });
        assert.equal(res.status, 504);
    });
});
