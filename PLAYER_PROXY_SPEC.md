# VideoFocus Player Proxy — Technical Specification

## Why This Service Exists

VideoFocus is a parental-control iOS app that lets parents curate a safe YouTube video library for their kids. Videos are played inside the app using a WKWebView that embeds YouTube's iFrame player.

On kids' iPads, iOS Screen Time commonly has `youtube.com` restricted. WKWebView is subject to Screen Time's web content filtering, so even though the video plays inside VideoFocus (not Safari), the system blocks it with a "youtube.com is a restricted website" error.

**The fix:** instead of the iOS app loading YouTube's iFrame API directly from `youtube.com`, it loads a small HTML page from the VideoFocus proxy server (`api.videofocus.app`). Screen Time sees the request going to `api.videofocus.app` — a domain the parent trusts — and allows it. YouTube's iFrame API and video streams load as sub-resources of that page, which Screen Time does not individually filter.

Parents never need to add `youtube.com` to any allowed list. They only need to allow `api.videofocus.app`, framed as "allow the VideoFocus app's own server."

---

## Architecture

```
Kids' iPad (VideoFocus app)
        │
        │  GET https://api.videofocus.app/embed/{videoId}
        │  Authorization: Bearer <API_KEY>
        ▼
┌─────────────────────────────────┐
│   Player Proxy Server           │
│   (Node.js / Express)           │
│   Docker + Docker Compose       │
│   api.videofocus.app            │
└─────────────────────────────────┘
        │
        │  <script src="youtube.com/iframe_api">  (sub-resource, not filtered)
        │  YT.Player embed iframe                 (sub-resource, not filtered)
        │  Video streams from googlevideo.com     (sub-resource, not filtered)
        ▼
    YouTube's servers
```

The proxy does **not** cache or relay YouTube video content. It only serves a small HTML page that initialises YouTube's own iFrame API. All actual media comes directly from YouTube's CDN.

---

## API Specification

### `GET /embed/:videoId`

Returns an HTML page that initialises the YouTube iFrame Player for the given video ID. This page is loaded directly into the app's WKWebView.

**Request**

| Component | Value |
|-----------|-------|
| Method | `GET` |
| Path | `/embed/:videoId` |
| `:videoId` | YouTube video ID, e.g. `dQw4w9WgXcQ` |
| Header `Authorization` | `Bearer <API_KEY>` |
| Header `User-Agent` | Must contain `VideoFocus` |

**Success Response — 200 OK**

```
Content-Type: text/html; charset=utf-8
```

HTML body — see [Player HTML](#player-html) below.

**Error Responses**

| Status | Condition |
|--------|-----------|
| 400 | Missing or invalid `videoId` (not 11 alphanumeric/dash/underscore chars) |
| 401 | Missing or invalid `Authorization` header |
| 403 | `User-Agent` does not contain `VideoFocus` |
| 429 | Rate limit exceeded |
| 500 | Internal server error |

Error responses return JSON:
```json
{ "error": "description of the problem" }
```

---

### `GET /health`

Health check endpoint. Returns 200 when the server is running.

```json
{ "status": "ok", "version": "1.0.0" }
```

No authentication required.

---

## Player HTML

The server generates and returns the following HTML. The `{videoId}` and `{origin}` placeholders are filled at request time.

```html
<!DOCTYPE html>
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
                videoId: '{videoId}',
                playerVars: {
                    playsinline: 1,
                    autoplay:    1,
                    controls:    1,
                    modestbranding: 1,
                    rel:         0,
                    origin:      '{origin}'
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
</html>
```

`{origin}` is the request origin as seen by the server, e.g. `https://api.videofocus.app`.

---

## Security

| Concern | Mitigation |
|---------|------------|
| Unauthorised use | All `/embed/*` requests require `Authorization: Bearer <API_KEY>`. The key is stored in the iOS app's keychain and in the server's environment. |
| Abuse / scraping | Rate limit per IP: 60 requests/minute. 429 after exceeded. |
| `videoId` injection | Validate that `:videoId` matches `/^[a-zA-Z0-9_-]{11}$/` before inserting into HTML. Return 400 otherwise. |
| HTTPS only | All traffic must be HTTPS. Redirect HTTP → HTTPS at the reverse proxy level. |
| CORS | The endpoint does not need to be browser-accessible. CORS headers are not required. |

---

## Docker Setup

### Directory Structure

```
player-proxy/
├── docker-compose.yml
├── Dockerfile
├── .env                  # not committed — see .env.example
├── .env.example
├── src/
│   └── server.js
└── nginx/
    ├── nginx.conf
    └── certs/            # SSL certificates (Let's Encrypt or your CA)
        ├── fullchain.pem
        └── privkey.pem
```

### `.env.example`

```env
# Port the Node.js server listens on internally
PORT=3000

# Shared secret between the iOS app and the server
API_KEY=replace_with_a_long_random_string

# The public-facing origin (used in the player HTML)
PUBLIC_ORIGIN=https://api.videofocus.app

# Rate limit: max requests per minute per IP on /embed/*
RATE_LIMIT_RPM=60
```

### `src/server.js`

```js
const express = require('express');
const rateLimit = require('express-rate-limit');

const app = express();
const PORT = process.env.PORT || 3000;
const API_KEY = process.env.API_KEY;
const PUBLIC_ORIGIN = process.env.PUBLIC_ORIGIN || 'https://api.videofocus.app';
const RATE_LIMIT_RPM = parseInt(process.env.RATE_LIMIT_RPM || '60', 10);

// Validate video ID format: exactly 11 alphanumeric/dash/underscore characters
const VIDEO_ID_RE = /^[a-zA-Z0-9_-]{11}$/;

// Rate limiter for embed endpoint
const limiter = rateLimit({
    windowMs: 60 * 1000,
    max: RATE_LIMIT_RPM,
    standardHeaders: true,
    legacyHeaders: false,
});

// Auth middleware
function requireApiKey(req, res, next) {
    const auth = req.headers['authorization'] || '';
    if (!API_KEY || auth !== `Bearer ${API_KEY}`) {
        return res.status(401).json({ error: 'Unauthorised' });
    }
    next();
}

// User-agent guard — optional extra check
function requireVideoFocusAgent(req, res, next) {
    const ua = req.headers['user-agent'] || '';
    if (!ua.includes('VideoFocus')) {
        return res.status(403).json({ error: 'Forbidden' });
    }
    next();
}

// Health check (no auth)
app.get('/health', (req, res) => {
    res.json({ status: 'ok', version: '1.0.0' });
});

// Player embed page
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
```

### `Dockerfile`

```dockerfile
FROM node:20-alpine

WORKDIR /app

COPY package*.json ./
RUN npm ci --omit=dev

COPY src/ ./src/

EXPOSE 3000

USER node

CMD ["node", "src/server.js"]
```

### `package.json`

```json
{
  "name": "videofocus-player-proxy",
  "version": "1.0.0",
  "description": "Player HTML proxy for VideoFocus iOS app",
  "main": "src/server.js",
  "scripts": {
    "start": "node src/server.js",
    "dev": "node --watch src/server.js"
  },
  "dependencies": {
    "express": "^4.18.2",
    "express-rate-limit": "^7.1.5"
  }
}
```

### `nginx/nginx.conf`

```nginx
events {}

http {
    server {
        listen 80;
        server_name api.videofocus.app;
        return 301 https://$host$request_uri;
    }

    server {
        listen 443 ssl;
        server_name api.videofocus.app;

        ssl_certificate     /etc/nginx/certs/fullchain.pem;
        ssl_certificate_key /etc/nginx/certs/privkey.pem;
        ssl_protocols       TLSv1.2 TLSv1.3;
        ssl_ciphers         HIGH:!aNULL:!MD5;

        location / {
            proxy_pass         http://app:3000;
            proxy_set_header   Host $host;
            proxy_set_header   X-Real-IP $remote_addr;
            proxy_set_header   X-Forwarded-For $proxy_add_x_forwarded_for;
            proxy_set_header   X-Forwarded-Proto $scheme;
        }
    }
}
```

### `docker-compose.yml`

```yaml
services:
  app:
    build: .
    restart: unless-stopped
    env_file: .env
    expose:
      - "3000"
    healthcheck:
      test: ["CMD", "wget", "-qO-", "http://localhost:3000/health"]
      interval: 30s
      timeout: 5s
      retries: 3

  nginx:
    image: nginx:alpine
    restart: unless-stopped
    ports:
      - "80:80"
      - "443:443"
    volumes:
      - ./nginx/nginx.conf:/etc/nginx/nginx.conf:ro
      - ./nginx/certs:/etc/nginx/certs:ro
    depends_on:
      - app
```

---

## Deployment Steps

1. Provision a VPS (any provider — 1 vCPU / 512 MB RAM is sufficient).
2. Point the DNS A record for `api.videofocus.app` at the server's IP.
3. Obtain an SSL certificate (e.g. `certbot certonly --standalone -d api.videofocus.app`) and place the PEM files in `nginx/certs/`.
4. Copy the project to the server.
5. Create `.env` from `.env.example` and fill in `API_KEY` and `PUBLIC_ORIGIN`.
6. Run:
   ```bash
   docker compose up -d
   ```
7. Verify: `curl https://api.videofocus.app/health`

---

## iOS App Changes Required

Once the server is live, two small changes are needed in `VideoPlayerView.swift`:

### 1. Load from the proxy instead of `loadHTMLString`

Replace the `updateUIView` body in `YouTubePlayerView`:

```swift
func updateUIView(_ webView: WKWebView, context: Context) {
    guard context.coordinator.currentVideoID != videoID else { return }
    context.coordinator.currentVideoID = videoID

    guard let url = URL(string: "https://api.videofocus.app/embed/\(videoID)") else { return }
    var request = URLRequest(url: url)
    request.setValue("Bearer \(apiKey)", forHTTPHeaderField: "Authorization")
    webView.load(request)
}
```

### 2. API key storage

Store `API_KEY` in `APIKeys.plist` alongside the existing `YouTubeAPIKey` entry:

```xml
<key>PlayerProxyAPIKey</key>
<string>your_api_key_here</string>
```

Read it at startup the same way `YouTubeAPIKey` is currently read.

### 3. Screen Time — what parents add to the allowed list

With this proxy in place, parents add **`api.videofocus.app`** to Screen Time's allowed websites — not `youtube.com`. The framing in the app's onboarding or error screen should be:

> "To allow VideoFocus to play videos, please add **api.videofocus.app** to your child's Screen Time allowed websites. This is VideoFocus's own server and does not allow access to YouTube directly."

---

## Notes for the Developer

- The server intentionally does **not** cache or relay YouTube video streams. It only serves the small HTML page. All media delivery remains YouTube's responsibility under their own CDN and terms.
- The `origin` parameter passed to `YT.Player` should match the server's public domain (`https://api.videofocus.app`). This is used by YouTube's postMessage protocol for player ↔ page communication and is unrelated to embedding permissions.
- Videos whose owners have disabled embedding on YouTube will still show an error (YouTube error code 101/150) regardless of this proxy. This is a per-video setting outside VideoFocus's control.
- The `requireVideoFocusAgent` middleware checks the User-Agent contains `VideoFocus`. The iOS app's custom user agent should be updated to include this string alongside the existing Safari UA string.
