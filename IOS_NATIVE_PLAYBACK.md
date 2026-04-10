# VideoFocus Native Playback — iOS Integration Guide

## Overview

The server now extracts direct YouTube CDN URLs via yt-dlp. The iOS app fetches a stream URL from our API, then plays it with AVPlayer. This bypasses Screen Time's web content filter entirely — AVPlayer uses native networking (URLSession), not WKWebView.

---

## Playback Decision Flow

The app should pick the best playback method based on what's available. This avoids unnecessary server load and provides the best fallback chain.

```
App launch / video play requested
        │
        ▼
1. Probe youtube.com (HEAD request via URLSession)
        │
    ┌───┴───┐
    │ 200   │ blocked/timeout
    ▼       ▼
  Use      2. Try GET /api/v1/stream/:videoId
 WKWebView      │
 (/embed)  ┌───┴───┐
           │ 200   │ 502/504 (extraction broken)
           ▼       ▼
         Use      3. Show Screen Time explainer
        AVPlayer     "Ask a parent to add
                      api.videofocus.app to
                      allowed websites"
                         │
                         ▼
                     Use WKWebView (/embed)
                     as fallback
```

**Why this order:**
1. If youtube.com is reachable, WKWebView is simplest — no server-side extraction needed
2. If Screen Time blocks youtube.com, AVPlayer via our stream API works regardless of Screen Time
3. If yt-dlp is broken (YouTube changed extraction), fall back to WKWebView — but it requires the parent to whitelist `api.videofocus.app` in Screen Time settings

**Caching the probe result:** Don't probe youtube.com on every video play. Cache the result for the session (or ~5 minutes). Screen Time settings don't change mid-session.

---

## API Reference

### `GET /api/v1/stream/:videoId`

**Authentication:** `Authorization: Bearer <API_KEY>` (same key as existing endpoints)

**Query parameters:**
| Param | Default | Description |
|-------|---------|-------------|
| `quality` | `720` | Preferred max resolution (pixel height): 360, 480, 720, 1080 |

**Success response (200):**

```json
{
  "videoId": "dQw4w9WgXcQ",
  "title": "Rick Astley - Never Gonna Give You Up",
  "channel": "Rick Astley",
  "duration": 212,
  "streams": {
    "muxed": {
      "url": "https://rr3---sn-xxx.googlevideo.com/videoplayback?...",
      "quality": "720p",
      "mimeType": "video/mp4",
      "width": 1280,
      "height": 720,
      "expiresAt": "2026-04-10T18:30:00Z"
    },
    "video": {
      "url": "https://...",
      "quality": "1080p",
      "mimeType": "video/mp4",
      "width": 1920,
      "height": 1080,
      "expiresAt": "2026-04-10T18:30:00Z"
    },
    "audio": {
      "url": "https://...",
      "quality": "128kbps",
      "mimeType": "audio/mp4",
      "width": null,
      "height": null,
      "expiresAt": "2026-04-10T18:30:00Z"
    }
  },
  "cached": false
}
```

**Error responses:**
| Status | Meaning |
|--------|---------|
| 400 | Invalid video ID (not 11 chars alphanumeric) |
| 401 | Missing or invalid API key |
| 429 | Rate limited — check `Retry-After` header |
| 502 | Extraction failed (YouTube issue or video unavailable) |
| 504 | Extraction timed out |

---

## Playback Strategy

### Phase 1 (ship first): Muxed stream

Use `streams.muxed.url` with a plain `AVPlayer(url:)`. Muxed streams are single MP4 files with video + audio combined. Max quality is 720p. This is the simplest integration — one URL, one AVPlayer.

### Phase 2 (optional, later): Adaptive streams

For 1080p+, use `streams.video.url` and `streams.audio.url` separately via `AVMutableComposition` to play both tracks simultaneously. Only pursue this if 720p is insufficient.

### Free with AVPlayer

- Picture-in-Picture (PiP)
- Background audio playback (with audio session configuration)
- Lock screen / Control Center controls
- AirPlay to Apple TV
- No YouTube branding

---

## When Things Go Wrong — Error Handling Guide

The extraction pipeline can fail. The app should handle each scenario gracefully so kids see a helpful message, not a blank screen.

### Error scenarios and recommended UX

#### 1. Video temporarily unavailable (HTTP 502)

**Cause:** yt-dlp couldn't extract the video. YouTube may have changed extraction logic, or the specific video is unavailable/age-restricted.

**What to show:**

> **Can't play this video right now**
> This video is temporarily unavailable. Try again in a few minutes.
> [Try Again]

**Behavior:**
- Retry up to 2 times automatically with 2-second delay
- After 2 retries, show the message with a manual "Try Again" button
- Log the error (include videoId and HTTP status)

#### 2. Extraction timed out (HTTP 504)

**Cause:** yt-dlp took longer than 15 seconds. YouTube's servers are slow or our server is overloaded.

**What to show:** Same as 502. The user doesn't need to know the difference.

#### 3. Extraction pipeline is broken (repeated 502s for all videos)

**Cause:** YouTube changed their extraction logic and yt-dlp hasn't been updated yet. This can last hours to days.

**Detection:** If 3+ different videos all return 502 in a row, assume the pipeline is broken (not just one bad video).

**What to do:** Fall back to WKWebView. But if Screen Time is blocking WKWebView, the user needs to whitelist our domain.

**What to show (Screen Time restricted device):**

> **Videos are temporarily unavailable**
>
> We're working on a fix. In the meantime, a parent can enable video playback:
>
> 1. Open **Settings** > **Screen Time** > **Content & Privacy Restrictions**
> 2. Tap **Content Restrictions** > **Web Content**
> 3. Under **Allowed Websites**, tap **Add Website**
> 4. Enter: `api.videofocus.app`
>
> Videos will play normally once this is added.

**What to show (unrestricted device):** Silently fall back to WKWebView — no user message needed.

#### 4. Stream URL expires during playback

**Cause:** CDN URLs are valid for ~6 hours. If a child pauses and returns hours later, the URL will have expired.

**Detection:** `AVPlayerItem.status == .failed` or KVO on `AVPlayerItem.error`.

**What to do:**
1. Save current playback position (`CMTime`)
2. Re-call `GET /api/v1/stream/:videoId`
3. Create new `AVPlayerItem` with fresh URL
4. `player.replaceCurrentItem(with: newItem)`
5. `player.seek(to: savedPosition)` and resume

**What to show (only if re-fetch also fails):**

> **Lost connection to video**
> We couldn't reconnect. Please try playing the video again.
> [Retry]

#### 5. Rate limited (HTTP 429)

**Cause:** Too many requests in a short window.

**What to do:** Read `Retry-After` header (seconds), wait that long, retry once.

**What to show (only if retry also fails):**

> **Too many requests**
> Please wait a moment and try again.

#### 6. API key invalid (HTTP 401)

**Cause:** Programming error. Should never happen in production.

**What to do:** Log error. Do not retry.

**What to show:**

> **Something went wrong**
> Please update VideoFocus to the latest version.

#### 7. Network unreachable / server down

**Cause:** No internet or server is down.

**Detection:** URLSession throws before getting an HTTP status.

**What to show:**

> **No connection**
> Check your internet connection and try again.
> [Try Again]

---

## Detecting Screen Time Restrictions

To know which fallback path to show (silent WKWebView fallback vs. Screen Time explainer), the app needs to detect whether Screen Time web content filtering is active.

**Approach:** Try loading a known URL in a hidden WKWebView (e.g., `https://api.videofocus.app/health`). If it fails with a content-filter error, Screen Time is blocking WKWebView. Cache this result for the session.

---

## Migration Path

- The existing WKWebView player (`/embed/:videoId`) remains available indefinitely
- The same `API_KEY` authenticates both endpoints
- Ship AVPlayer as primary when Screen Time is detected, WKWebView otherwise
- Remove WKWebView path once native playback is proven stable

---

## Sample Swift (URLSession + AVPlayer)

```swift
struct StreamResponse: Codable {
    let videoId: String
    let title: String?
    let channel: String?
    let duration: Int?
    let streams: Streams
    let cached: Bool

    struct Streams: Codable {
        let muxed: StreamInfo?
        let video: StreamInfo?
        let audio: StreamInfo?
    }

    struct StreamInfo: Codable {
        let url: String
        let quality: String
        let mimeType: String
        let width: Int?
        let height: Int?
        let expiresAt: String
    }
}

func fetchStreamURL(videoId: String) async throws -> StreamResponse {
    let url = URL(string: "https://api.videofocus.app/api/v1/stream/\(videoId)")!
    var request = URLRequest(url: url)
    request.setValue("Bearer \(apiKey)", forHTTPHeaderField: "Authorization")
    let (data, response) = try await URLSession.shared.data(for: request)
    let http = response as! HTTPURLResponse
    guard http.statusCode == 200 else {
        throw StreamError.httpError(http.statusCode)
    }
    return try JSONDecoder().decode(StreamResponse.self, from: data)
}

// Play with AVPlayer
let stream = try await fetchStreamURL(videoId: "dQw4w9WgXcQ")
if let muxed = stream.streams.muxed, let url = URL(string: muxed.url) {
    let player = AVPlayer(url: url)
    // Present via AVPlayerViewController or SwiftUI VideoPlayer
}
```
