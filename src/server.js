const express = require('express');
const https = require('https');
const http = require('http');
const { limiter, requireApiKey, requireVideoFocusAgent } = require('./middleware');
const { createCache } = require('./cache');
const { createHealthChecker } = require('./health');
const { createStreamRouter } = require('./routes/stream');
const { extractFormats, pickStreams, parseExpiry } = require('./ytdlp');

const app = express();
const PORT = process.env.PORT || 3000;
const PUBLIC_ORIGIN = process.env.PUBLIC_ORIGIN || 'https://api.videofocus.app';

// Trust first proxy (Caddy) so rate limiting uses real client IP
app.set('trust proxy', 1);

const VIDEO_ID_RE = /^[a-zA-Z0-9_-]{11}$/;

const cache = createCache(process.env.REDIS_URL);
const healthChecker = createHealthChecker(
    extractFormats,
    process.env.HEALTH_CHECK_VIDEO_ID || 'dQw4w9WgXcQ',
    30 * 60 * 1000,
);

// --- YouTube iframe API script cache ---
// Fetches youtube.com/iframe_api server-side so the client never hits youtube.com directly.
// This is critical for "Allowed Websites Only" Screen Time mode on kids' iPads.
let cachedIframeApiScript = null;
let cacheTimestamp = 0;
const CACHE_TTL_MS = 60 * 60 * 1000; // 1 hour

function fetchYouTubeIframeApi() {
    return new Promise((resolve, reject) => {
        https.get('https://www.youtube.com/iframe_api', (resp) => {
            let data = '';
            resp.on('data', (chunk) => { data += chunk; });
            resp.on('end', () => resolve(data));
        }).on('error', reject);
    });
}

async function getIframeApiScript() {
    const now = Date.now();
    if (cachedIframeApiScript && (now - cacheTimestamp) < CACHE_TTL_MS) {
        return cachedIframeApiScript;
    }
    try {
        cachedIframeApiScript = await fetchYouTubeIframeApi();
        cacheTimestamp = now;
        return cachedIframeApiScript;
    } catch (err) {
        console.error('Failed to fetch YouTube iframe API:', err.message);
        if (cachedIframeApiScript) return cachedIframeApiScript; // stale cache better than nothing
        throw err;
    }
}

// --- Reverse proxy helper ---
// Proxies requests to YouTube/Google domains through our server so the kid's device
// only sees requests to api.videofocus.app.
function proxyRequest(targetUrl, req, res) {
    const parsedUrl = new URL(targetUrl);
    const transport = parsedUrl.protocol === 'https:' ? https : http;

    const proxyReq = transport.request(parsedUrl, {
        method: req.method,
        headers: {
            'User-Agent': req.headers['user-agent'] || 'VideoFocus-Proxy/1.0',
            'Accept': req.headers['accept'] || '*/*',
            'Accept-Language': req.headers['accept-language'] || 'en',
            'Referer': 'https://www.youtube.com/',
            'Origin': 'https://www.youtube.com',
        },
    }, (proxyRes) => {
        // Forward status and safe headers
        const forwardHeaders = {};
        const safeHeaders = ['content-type', 'content-length', 'cache-control', 'expires', 'access-control-allow-origin'];
        for (const h of safeHeaders) {
            if (proxyRes.headers[h]) forwardHeaders[h] = proxyRes.headers[h];
        }
        res.writeHead(proxyRes.statusCode, forwardHeaders);
        proxyRes.pipe(res);
    });

    proxyReq.on('error', (err) => {
        console.error('Proxy error:', err.message);
        if (!res.headersSent) res.status(502).json({ error: 'Proxy error' });
    });

    proxyReq.end();
}

// --- Stream API ---

app.use('/api/v1', createStreamRouter({
    cache,
    ytdlp: { extractFormats, pickStreams, parseExpiry },
    apiKey: process.env.API_KEY,
}));

// --- Routes ---

app.get('/health', async (_req, res) => {
    const redisHealth = await cache.health();
    const ytdlpHealth = healthChecker.status();
    const status = redisHealth.connected && ytdlpHealth.ok ? 'ok' : 'degraded';
    res.json({ status, version: '3.0.0', redis: redisHealth, ytdlp: ytdlpHealth });
});

// Serve YouTube iframe API script from our domain
app.get('/yt-api.js', limiter, requireApiKey, async (req, res) => {
    try {
        const script = await getIframeApiScript();
        res.setHeader('Content-Type', 'application/javascript; charset=utf-8');
        res.setHeader('Cache-Control', 'public, max-age=3600');
        res.send(script);
    } catch (err) {
        res.status(502).json({ error: 'Failed to fetch YouTube API script' });
    }
});

// Reverse proxy for YouTube embed iframe and related resources
// Handles: /yt-proxy/www.youtube.com/embed/VIDEO_ID, /yt-proxy/www.youtube.com/s/player/...
// and /yt-proxy/i.ytimg.com/... etc.
app.get('/yt-proxy/*', limiter, requireApiKey, (req, res) => {
    // Extract the target URL from the path: /yt-proxy/www.youtube.com/embed/xxx → https://www.youtube.com/embed/xxx
    const targetPath = req.params[0];
    if (!targetPath) return res.status(400).json({ error: 'Missing target path' });

    // Only allow proxying to known YouTube/Google domains
    const allowedDomains = [
        'www.youtube.com',
        'www.youtube-nocookie.com',
        'youtube.com',
        'i.ytimg.com',
        's.ytimg.com',
        'yt3.ggpht.com',
        'fonts.googleapis.com',
        'fonts.gstatic.com',
        'play.google.com',
        'www.google.com',
    ];

    const firstSlash = targetPath.indexOf('/');
    const domain = firstSlash > 0 ? targetPath.substring(0, firstSlash) : targetPath;
    if (!allowedDomains.includes(domain)) {
        return res.status(403).json({ error: 'Domain not allowed' });
    }

    const targetUrl = `https://${targetPath}${req.url.includes('?') ? '?' + req.url.split('?')[1] : ''}`;
    proxyRequest(targetUrl, req, res);
});

// Main embed endpoint
app.get('/embed/:videoId', limiter, requireApiKey, requireVideoFocusAgent, (req, res) => {
    const { videoId } = req.params;

    if (!VIDEO_ID_RE.test(videoId)) {
        return res.status(400).json({ error: 'Invalid videoId' });
    }

    // Pass API key to buildPlayerHtml so sub-resources can authenticate via query param
    const clientKey = req.query.key || (req.headers['authorization'] || '').replace('Bearer ', '');
    const html = buildPlayerHtml(videoId, PUBLIC_ORIGIN, clientKey);
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.send(html);
});

function buildPlayerHtml(videoId, origin, apiKey) {
    return `<!DOCTYPE html>
<html>
<head>
    <meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0">
    <style>
        * { margin: 0; padding: 0; }
        html, body { width: 100%; height: 100%; background: #000; overflow: hidden; }
        #player { width: 100%; height: 100%; }
    </style>
</head>
<body>
    <div id="player"></div>
    <script>
        // Load iframe API from our own proxy to avoid content filter blocking youtube.com
        var tag = document.createElement('script');
        tag.src = '${origin}/yt-api.js?key=${apiKey}';
        tag.onerror = function() {
            window.webkit && window.webkit.messageHandlers.ytEvent &&
                window.webkit.messageHandlers.ytEvent.postMessage('scriptError');
        };
        document.head.appendChild(tag);

        var ytPlayer;
        function onYouTubeIframeAPIReady() {
            window.webkit && window.webkit.messageHandlers.ytEvent &&
                window.webkit.messageHandlers.ytEvent.postMessage('apiReady');
            ytPlayer = new YT.Player('player', {
                videoId: '${videoId}',
                host: 'https://www.youtube-nocookie.com',
                playerVars: {
                    playsinline: 1,
                    autoplay:    1,
                    controls:    1,
                    modestbranding: 1,
                    rel:         0,
                    origin:      '${origin}'
                },
                events: {
                    onReady: function(e) {
                        window.webkit && window.webkit.messageHandlers.ytEvent &&
                            window.webkit.messageHandlers.ytEvent.postMessage('playerReady');
                        e.target.playVideo();
                    },
                    onStateChange: function(e) {
                        if (e.data === YT.PlayerState.ENDED) {
                            window.webkit && window.webkit.messageHandlers.ytEvent &&
                                window.webkit.messageHandlers.ytEvent.postMessage('ended');
                        }
                    },
                    onError: function(e) {
                        window.webkit && window.webkit.messageHandlers.ytEvent &&
                            window.webkit.messageHandlers.ytEvent.postMessage('error:' + e.data);
                    }
                }
            });
        }
    </script>
</body>
</html>`;
}

process.on('SIGTERM', async () => {
    healthChecker.stop();
    await cache.close();
    process.exit(0);
});

app.listen(PORT, () => {
    console.log(`VideoFocus v3 listening on port ${PORT}`);
});
