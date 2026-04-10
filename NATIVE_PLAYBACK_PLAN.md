# VideoFocus Native Playback — Implementation Plan

## Why We're Changing

The current approach uses WKWebView to load an HTML page (from our proxy) that embeds YouTube's iFrame player. This fails on kids' iPads when Screen Time is set to **"Allowed Websites Only"** — the content filter blocks all web requests from WKWebView, including to our own proxy domain and YouTube's CDN. There is no WKWebView configuration that bypasses this.

Apps like SafeVision and YouTube Kids solve this by using **native video playback (AVPlayer)**. iOS Screen Time's web content filter only applies to WKWebView and Safari. Native networking (URLSession, AVPlayer) is completely unaffected. To Screen Time, it's just an app making normal HTTPS requests — same as Netflix or any other video app.

**The fix:** replace WKWebView with AVPlayer. Use a self-hosted Invidious instance to extract direct video stream URLs from YouTube. The iOS app fetches the URL via URLSession, hands it to AVPlayer, and playback works regardless of Screen Time settings. No domains need to be whitelisted by the parent.

---

## Architecture

```
Kids' iPad (VideoFocus app)
        │
        │  GET https://api.videofocus.app/api/v1/stream/{videoId}
        │  Authorization: Bearer <API_KEY>
        │
        ▼
┌─────────────────────────────────────┐
│  api.videofocus.app (our server)    │
│                                     │
│  Thin API layer (Node.js/Express)   │
│         │                           │
│         ▼                           │
│  Invidious instance (Docker)        │
│  - Extracts direct stream URLs      │
│  - Caches results (~6 hr TTL)       │
│  - Returns googlevideo.com CDN URLs │
└─────────────────────────────────────┘
        │
        │  Direct CDN URL returned to app
        │
        ▼
┌─────────────────────────────────────┐
│  AVPlayer on device                 │
│  - Plays MP4 stream directly from   │
│    Google's CDN (googlevideo.com)   │
│  - Native networking, NOT filtered  │
│    by Screen Time                   │
│  - Supports PiP, AirPlay, lock     │
│    screen controls                  │
└─────────────────────────────────────┘
```

**Key point:** Our server does NOT proxy or relay video data. It only extracts and returns the direct CDN URL. Google's CDN delivers the actual video to the device. This keeps our server load and bandwidth minimal.

---

## Server Components

### 1. Invidious Instance

[Invidious](https://github.com/iv-org/invidious) is an open-source alternative YouTube frontend that exposes a REST API. We use it solely for its stream URL extraction capability.

**What it does for us:**
- Fetches YouTube video metadata and stream information
- Parses YouTube's player response to extract direct `googlevideo.com` CDN URLs
- Handles YouTube's signature cipher decryption and throttle parameter (nsig) decryption
- Stays up-to-date with YouTube's frequent obfuscation changes via community updates

**Deployment:**
- Docker container (image: `quay.io/invidious/invidious`)
- Requires a PostgreSQL database (also Docker container)
- Runs on same VPS as the existing proxy

**Invidious API endpoint we use:**
```
GET http://localhost:3001/api/v1/videos/{videoId}
```

Returns JSON with `adaptiveFormats[]` containing direct stream URLs:
```json
{
  "title": "Video Title",
  "author": "Channel Name",
  "lengthSeconds": 240,
  "adaptiveFormats": [
    {
      "url": "https://rr3---sn-xxx.googlevideo.com/videoplayback?...",
      "type": "video/mp4; codecs=\"avc1.640028\"",
      "quality": "720p",
      "bitrate": "1500000",
      "container": "mp4",
      "resolution": "1280x720",
      "fps": 30
    },
    {
      "url": "https://rr3---sn-xxx.googlevideo.com/videoplayback?...",
      "type": "audio/mp4; codecs=\"mp4a.40.2\"",
      "quality": "medium",
      "bitrate": "128000",
      "container": "m4a"
    }
  ],
  "formatStreams": [
    {
      "url": "https://rr3---sn-xxx.googlevideo.com/videoplayback?...",
      "type": "video/mp4; codecs=\"avc1.42001E, mp4a.40.2\"",
      "quality": "360p",
      "container": "mp4"
    }
  ]
}
```

- `adaptiveFormats` — separate video and audio tracks (higher quality, but app must handle merging or pick one)
- `formatStreams` — pre-muxed video+audio (lower quality options, but simplest for AVPlayer since it's a single URL)

### 2. API Layer (our Express server)

A thin wrapper around Invidious that adds authentication, caching, and formats the response for the iOS app.

**New endpoint:**

```
GET /api/v1/stream/{videoId}
Authorization: Bearer <API_KEY>

Optional query params:
  ?quality=720     (preferred max resolution: 360, 480, 720, 1080)
  ?format=muxed    (muxed = single video+audio URL, adaptive = separate tracks)
```

**Response:**
```json
{
  "videoId": "dQw4w9WgXcQ",
  "title": "Rick Astley - Never Gonna Give You Up",
  "author": "Rick Astley",
  "lengthSeconds": 212,
  "streams": {
    "muxed": {
      "url": "https://rr3---sn-xxx.googlevideo.com/videoplayback?...",
      "quality": "360p",
      "mimeType": "video/mp4",
      "expiresAt": "2026-04-10T18:00:00Z"
    },
    "video": {
      "url": "https://rr3---sn-xxx.googlevideo.com/videoplayback?...",
      "quality": "720p",
      "mimeType": "video/mp4",
      "expiresAt": "2026-04-10T18:00:00Z"
    },
    "audio": {
      "url": "https://rr3---sn-xxx.googlevideo.com/videoplayback?...",
      "quality": "medium",
      "mimeType": "audio/mp4",
      "expiresAt": "2026-04-10T18:00:00Z"
    }
  },
  "cached": true,
  "cacheExpiresAt": "2026-04-10T18:00:00Z"
}
```

**Why a wrapper instead of exposing Invidious directly:**
- Adds our API key authentication (Invidious has no auth by default)
- Caches results so repeated requests for the same video don't hit YouTube
- Simplifies the response — iOS app gets exactly what it needs, nothing more
- Allows us to swap out Invidious for Piped or yt-dlp later without changing the iOS app
- Rate limiting per API key

### 3. Caching Layer

Stream URLs from YouTube are valid for approximately **6 hours**. We cache them to minimize YouTube requests.

**Cache strategy:**
- In-memory cache (Node.js Map or Redis if scaling later)
- Key: `videoId`
- Value: extracted stream URLs + timestamp
- TTL: **5 hours** (buffer before YouTube's ~6 hour expiry)
- Cache hit: return instantly, no Invidious/YouTube call
- Cache miss: fetch from Invidious, cache result, return

**Impact on YouTube request volume:**
- 5,000 users watching the same popular video = 1 YouTube fetch (cached for 5 hours)
- 5,000 users each watching different videos = 5,000 fetches (spread over time)
- Realistic scenario: heavy long-tail caching. Most kids watch popular content repeatedly.

---

## Docker Setup

### Updated Directory Structure

```
VideoFocus-Web/
├── docker-compose.yml          # Updated: adds Invidious + PostgreSQL
├── Dockerfile                  # Existing: our Express API
├── .env                        # Updated: new config vars
├── .env.example
├── src/
│   └── server.js               # Updated: new /api/v1/stream endpoint
├── invidious/
│   └── config.yml              # Invidious configuration
├── landing/                    # Marketing website (unchanged)
└── nginx/
    ├── nginx.conf
    └── certs/
```

### Updated `docker-compose.yml`

```yaml
services:
  # Our API layer
  app:
    build: .
    restart: unless-stopped
    env_file: .env
    expose:
      - "3000"
    depends_on:
      - invidious
    healthcheck:
      test: ["CMD", "wget", "-qO-", "http://localhost:3000/health"]
      interval: 30s
      timeout: 5s
      retries: 3

  # Invidious — YouTube stream URL extraction
  invidious:
    image: quay.io/invidious/invidious:latest
    restart: unless-stopped
    environment:
      INVIDIOUS_CONFIG: |
        db:
          dbname: invidious
          user: invidious
          password: ${INVIDIOUS_DB_PASSWORD}
          host: invidious-db
          port: 5432
        check_tables: true
        external_port: 443
        domain: api.videofocus.app
        https_only: true
        registration_enabled: false
        login_enabled: false
        captcha_enabled: false
        admins: []
    expose:
      - "3000"
    depends_on:
      invidious-db:
        condition: service_healthy

  # PostgreSQL for Invidious
  invidious-db:
    image: docker.io/library/postgres:14
    restart: unless-stopped
    environment:
      POSTGRES_DB: invidious
      POSTGRES_USER: invidious
      POSTGRES_PASSWORD: ${INVIDIOUS_DB_PASSWORD}
    volumes:
      - invidious-db-data:/var/lib/postgresql/data
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U invidious"]
      interval: 10s
      timeout: 5s
      retries: 5

  # Nginx reverse proxy (existing)
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

volumes:
  invidious-db-data:
```

### Updated `.env.example`

```env
# --- Existing ---
PORT=3000
API_KEY=replace_with_a_long_random_string
PUBLIC_ORIGIN=https://api.videofocus.app
RATE_LIMIT_RPM=60

# --- New ---
# Invidious internal URL (Docker service name)
INVIDIOUS_URL=http://invidious:3000

# PostgreSQL password for Invidious
INVIDIOUS_DB_PASSWORD=replace_with_a_secure_password

# Stream cache TTL in seconds (default: 5 hours)
STREAM_CACHE_TTL=18000

# Default video quality to return (360, 480, 720, 1080)
DEFAULT_QUALITY=720
```

---

## API Layer Changes (server.js)

### New endpoint: `GET /api/v1/stream/:videoId`

```js
// --- Stream URL cache ---
const streamCache = new Map();
const STREAM_CACHE_TTL = parseInt(process.env.STREAM_CACHE_TTL || '18000', 10) * 1000;
const INVIDIOUS_URL = process.env.INVIDIOUS_URL || 'http://invidious:3000';
const DEFAULT_QUALITY = process.env.DEFAULT_QUALITY || '720';

app.get('/api/v1/stream/:videoId', limiter, requireApiKey, async (req, res) => {
    const { videoId } = req.params;
    if (!VIDEO_ID_RE.test(videoId)) {
        return res.status(400).json({ error: 'Invalid videoId' });
    }

    const preferredQuality = req.query.quality || DEFAULT_QUALITY;

    // Check cache
    const cached = streamCache.get(videoId);
    if (cached && Date.now() < cached.expiresAt) {
        return res.json({ ...cached.data, cached: true });
    }

    try {
        // Fetch from Invidious
        const response = await fetch(`${INVIDIOUS_URL}/api/v1/videos/${videoId}`);
        if (!response.ok) {
            return res.status(response.status).json({ error: 'Failed to fetch video info' });
        }
        const data = await response.json();

        // Pick best muxed stream (video+audio combined, simplest for AVPlayer)
        const muxed = pickBestStream(data.formatStreams || [], preferredQuality);

        // Pick best adaptive video + audio (higher quality option)
        const videoStream = pickBestStream(
            (data.adaptiveFormats || []).filter(f => f.type && f.type.startsWith('video/mp4')),
            preferredQuality
        );
        const audioStream = pickBestStream(
            (data.adaptiveFormats || []).filter(f => f.type && f.type.startsWith('audio/mp4')),
            'medium'
        );

        const expiresAt = new Date(Date.now() + STREAM_CACHE_TTL).toISOString();

        const result = {
            videoId,
            title: data.title,
            author: data.author,
            lengthSeconds: data.lengthSeconds,
            streams: {
                muxed: muxed ? {
                    url: muxed.url,
                    quality: muxed.quality || muxed.qualityLabel,
                    mimeType: muxed.type,
                    expiresAt
                } : null,
                video: videoStream ? {
                    url: videoStream.url,
                    quality: videoStream.qualityLabel || videoStream.quality,
                    mimeType: videoStream.type,
                    expiresAt
                } : null,
                audio: audioStream ? {
                    url: audioStream.url,
                    quality: audioStream.audioQuality || audioStream.quality,
                    mimeType: audioStream.type,
                    expiresAt
                } : null
            },
            cached: false,
            cacheExpiresAt: expiresAt
        };

        // Cache it
        streamCache.set(videoId, { data: result, expiresAt: Date.now() + STREAM_CACHE_TTL });

        res.json(result);
    } catch (err) {
        console.error('Stream fetch error:', err.message);
        res.status(502).json({ error: 'Failed to extract stream URL' });
    }
});

function pickBestStream(streams, preferredQuality) {
    if (!streams || streams.length === 0) return null;

    const qualityOrder = ['1080p', '720p', '480p', '360p', '240p', '144p'];
    const preferredIndex = qualityOrder.indexOf(preferredQuality + 'p');

    // Find the best match at or below preferred quality
    for (let i = Math.max(0, preferredIndex); i < qualityOrder.length; i++) {
        const match = streams.find(s =>
            (s.quality === qualityOrder[i]) ||
            (s.qualityLabel === qualityOrder[i])
        );
        if (match) return match;
    }

    // Fallback: return the first available stream
    return streams[0];
}
```

### Keep existing endpoints

The existing `/embed/:videoId` endpoint stays in place as a fallback for devices that don't have Screen Time restrictions (adults using the app on their own devices can still use the WKWebView player if desired). The `/health` endpoint is updated to reflect both services.

---

## Resource Requirements

### For 5,000 simultaneous users (Option A: direct CDN URLs)

| Resource | Estimate | Notes |
|----------|----------|-------|
| **CPU** | 2 vCPUs | JSON parsing only, no media processing |
| **RAM** | 2-4 GB | Express (~200 MB) + Invidious (~500 MB) + PostgreSQL (~500 MB) + cache |
| **Bandwidth** | ~50-100 KB/s | API responses only (~5-10 KB each). Video streams served by Google CDN |
| **Storage** | 2-5 GB | PostgreSQL data + Docker images |
| **VPS cost** | ~$20-40/month | 4 GB RAM, 2 vCPU, e.g., DigitalOcean, Hetzner, Linode |

**Why it's so light:** Our server returns a ~1 KB JSON response per request. Google's CDN delivers the actual video (2-5 Mbps per user). We're a lookup service, not a streaming service.

**With caching:** If 5,000 users are watching from a pool of 500 unique videos, we make ~500 Invidious requests per 5-hour cache window. The other 4,500 requests are served from memory instantly.

---

## iOS App Changes Required

### Replace WKWebView player with AVPlayer

The iOS app needs a new `NativeVideoPlayerView` that:

1. Calls `GET /api/v1/stream/{videoId}` via URLSession to get the stream URL
2. Creates an `AVPlayer` with the returned URL
3. Displays it via `AVPlayerViewController` or a custom SwiftUI `VideoPlayer` view

**Playback strategy:**
- **Primary:** Use the `muxed` stream URL (single video+audio MP4, simplest)
- **Upgrade:** If muxed quality is too low (e.g. only 360p), use the `video` + `audio` adaptive streams (requires AVPlayer composition — more complex, can implement later)
- **Fallback:** If stream URL expires mid-playback, re-fetch from the API

**What the app gains for free with AVPlayer:**
- Picture-in-Picture (PiP)
- Background audio playback
- Lock screen / Control Center controls (play/pause, scrub)
- AirPlay to Apple TV
- Native playback controls (no YouTube branding)
- Better ScreenTimeManager integration (observe `AVPlayer.timeControlStatus`)

### Keep WKWebView as fallback

For users who don't have Screen Time restrictions (adults on their own devices), the existing WKWebView player still works and provides the full YouTube embed experience. The app can:
1. Try AVPlayer (native) first — always works
2. Fall back to WKWebView if needed (e.g., if Invidious is down)

Or simply switch entirely to AVPlayer for all users for a consistent experience.

---

## Implementation Order

### Server (this repo)

1. **Add Invidious + PostgreSQL to docker-compose.yml**
2. **Create Invidious config** (`invidious/config.yml`)
3. **Add `/api/v1/stream/:videoId` endpoint** to server.js with in-memory caching
4. **Test locally** — `docker compose up`, hit the stream endpoint, verify URLs are playable
5. **Deploy to VPS** — same server as current proxy
6. **Monitor** — Invidious logs for YouTube extraction failures

### iOS app (VideoFocus repo)

7. **Create `NativeVideoPlayerView`** — AVPlayer-based SwiftUI view
8. **Create `StreamService`** — URLSession client for the stream API
9. **Replace `VideoPlayerView`** — swap WKWebView for AVPlayer
10. **Test on restricted iPad** — verify playback with "Allowed Websites Only"
11. **Add PiP and background audio support**

---

## Risks and Mitigations

| Risk | Impact | Mitigation |
|------|--------|------------|
| YouTube changes extraction logic | Stream URLs stop working until Invidious updates | Invidious community publishes updates quickly (usually within days). Pin to a stable version, update regularly. |
| YouTube rate-limits/blocks server IP | Extraction requests fail | Cache aggressively (5hr TTL). Use multiple IPs if needed. Invidious handles retries internally. |
| YouTube ToS enforcement | Legal notice from Google | Gray area — SafeVision and similar apps ship this way. Frame as parental control tool, not ad-blocker or downloader. No video content is stored or redistributed. |
| Stream URL expires during playback | Playback interrupts | iOS app detects failure, re-fetches URL from API, resumes AVPlayer at last known position. |
| Invidious instance goes down | No stream URLs available | Health check in docker-compose auto-restarts. Fall back to WKWebView player for non-restricted devices. |

---

## Notes

- **We are NOT proxying video data.** Our server returns a URL; Google's CDN delivers the video. This is critical for keeping costs low.
- **Stream URLs are tied to IP sometimes.** In rare cases, YouTube pins the CDN URL to the requester's IP. If the server IP ≠ the device IP, playback may fail. Invidious has a `local` parameter to handle this. If this becomes an issue, we can have the app request directly from Invidious (with our API key auth layer in front).
- **Muxed streams cap at 720p.** YouTube only provides pre-muxed (video+audio) streams up to 720p. For 1080p+, the app must play separate video and audio tracks simultaneously using AVPlayer composition. Start with muxed, upgrade later.
- **The existing WKWebView proxy (`/embed/:videoId`) remains available** as a fallback and for backwards compatibility during the transition.
