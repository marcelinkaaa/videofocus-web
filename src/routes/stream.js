const { Router } = require('express');

const VIDEO_ID_RE = /^[a-zA-Z0-9_-]{11}$/;
const STREAM_CACHE_TTL = parseInt(process.env.STREAM_CACHE_TTL || '18000', 10);
const DEFAULT_QUALITY = parseInt(process.env.DEFAULT_QUALITY || '720', 10);

function createStreamRouter({ cache, ytdlp, apiKey }) {
    const router = Router();

    function requireKey(req, res, next) {
        const auth = req.headers['authorization'] || '';
        const queryKey = req.query.key || '';
        if (!apiKey || (auth !== `Bearer ${apiKey}` && queryKey !== apiKey)) {
            return res.status(401).json({ error: 'Unauthorised' });
        }
        next();
    }

    router.get('/stream/:videoId', requireKey, async (req, res) => {
        const { videoId } = req.params;
        if (!VIDEO_ID_RE.test(videoId)) {
            return res.status(400).json({ error: 'Invalid videoId' });
        }

        const preferredQuality = parseInt(req.query.quality || DEFAULT_QUALITY, 10);
        const force = req.query.force === 'true';

        if (!force) {
            const cached = await cache.get(`stream:${videoId}`);
            if (cached) {
                return res.json({ ...cached, cached: true });
            }
        }

        try {
            const data = await ytdlp.extractFormats(videoId);
            const streams = ytdlp.pickStreams(data.formats || [], preferredQuality);

            const formatStream = (s) => {
                if (!s) return null;
                return {
                    url: s.url,
                    quality: s.height ? `${s.height}p` : `${s.tbr}kbps`,
                    mimeType: s.ext === 'm4a' ? 'audio/mp4' : 'video/mp4',
                    width: s.width || null,
                    height: s.height || null,
                    expiresAt: ytdlp.parseExpiry(s.url),
                };
            };

            const result = {
                videoId,
                title: data.title || null,
                channel: data.channel || null,
                duration: data.duration || null,
                streams: {
                    muxed: formatStream(streams.muxed),
                    video: formatStream(streams.video),
                    audio: formatStream(streams.audio),
                },
                cached: false,
            };

            await cache.set(`stream:${videoId}`, result, STREAM_CACHE_TTL);
            res.json(result);
        } catch (err) {
            const status = err.message.includes('timed out') ? 504 : 502;
            res.status(status).json({ error: err.message });
        }
    });

    return router;
}

module.exports = { createStreamRouter };
