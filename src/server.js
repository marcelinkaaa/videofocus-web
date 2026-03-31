const express = require('express');
const rateLimit = require('express-rate-limit');

const app = express();
const PORT = process.env.PORT || 3000;
const API_KEY = process.env.API_KEY;
const PUBLIC_ORIGIN = process.env.PUBLIC_ORIGIN || 'https://api.videofocus.app';
const RATE_LIMIT_RPM = parseInt(process.env.RATE_LIMIT_RPM || '60', 10);

// Trust first proxy (Caddy) so rate limiting uses real client IP
app.set('trust proxy', 1);

const VIDEO_ID_RE = /^[a-zA-Z0-9_-]{11}$/;

const limiter = rateLimit({
    windowMs: 60 * 1000,
    max: RATE_LIMIT_RPM,
    standardHeaders: true,
    legacyHeaders: false,
});

function requireApiKey(req, res, next) {
    const auth = req.headers['authorization'] || '';
    if (!API_KEY || auth !== `Bearer ${API_KEY}`) {
        return res.status(401).json({ error: 'Unauthorised' });
    }
    next();
}

function requireVideoFocusAgent(req, res, next) {
    const ua = req.headers['user-agent'] || '';
    if (!ua.includes('VideoFocus')) {
        return res.status(403).json({ error: 'Forbidden' });
    }
    next();
}

app.get('/health', (_req, res) => {
    res.json({ status: 'ok', version: '1.0.0' });
});

app.get('/embed/:videoId', limiter, requireApiKey, requireVideoFocusAgent, (req, res) => {
    const { videoId } = req.params;

    if (!VIDEO_ID_RE.test(videoId)) {
        return res.status(400).json({ error: 'Invalid videoId' });
    }

    const html = buildPlayerHtml(videoId, PUBLIC_ORIGIN);
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.send(html);
});

function buildPlayerHtml(videoId, origin) {
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
        var tag = document.createElement('script');
        tag.src = 'https://www.youtube.com/iframe_api';
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

app.listen(PORT, () => {
    console.log(`VideoFocus player proxy listening on port ${PORT}`);
});
