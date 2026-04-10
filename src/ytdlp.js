const SIDECAR_URL = process.env.YT_DLP_SIDECAR_URL || 'http://ytdlp-sidecar:3001';
const YT_DLP_TIMEOUT = parseInt(process.env.YT_DLP_TIMEOUT || '15000', 10);
const STREAM_CACHE_TTL = parseInt(process.env.STREAM_CACHE_TTL || '18000', 10);

async function extractFormats(videoId) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), YT_DLP_TIMEOUT);

    try {
        const res = await fetch(`${SIDECAR_URL}/extract/${videoId}`, {
            signal: controller.signal,
        });
        clearTimeout(timeout);

        if (!res.ok) {
            const body = await res.json().catch(() => ({}));
            throw new Error(body.error || `Sidecar returned ${res.status}`);
        }

        return await res.json();
    } catch (err) {
        clearTimeout(timeout);
        if (err.name === 'AbortError') throw new Error('yt-dlp timed out');
        throw err;
    }
}

function pickStreams(formats, preferredQuality) {
    if (!formats || formats.length === 0) return { muxed: null, video: null, audio: null };

    const hasUrl = (f) => !!f.url;
    const isMp4Muxed = (f) => f.ext === 'mp4' && f.vcodec && f.vcodec !== 'none' && f.acodec && f.acodec !== 'none';
    const isMp4VideoOnly = (f) => f.ext === 'mp4' && f.vcodec && f.vcodec !== 'none' && (!f.acodec || f.acodec === 'none');
    const isM4aAudioOnly = (f) => f.ext === 'm4a' && (!f.vcodec || f.vcodec === 'none') && f.acodec && f.acodec !== 'none';

    const pick = (list, quality) => {
        const sorted = [...list].sort((a, b) => (b.height || 0) - (a.height || 0));
        return sorted.find((f) => (f.height || 0) <= quality) || sorted[sorted.length - 1] || null;
    };

    const muxed = pick(formats.filter((f) => hasUrl(f) && isMp4Muxed(f)), preferredQuality);
    const video = pick(formats.filter((f) => hasUrl(f) && isMp4VideoOnly(f)), preferredQuality);

    const audioCandidates = formats.filter((f) => hasUrl(f) && isM4aAudioOnly(f));
    const audio = audioCandidates.sort((a, b) => (b.tbr || 0) - (a.tbr || 0))[0] || null;

    return { muxed, video, audio };
}

function parseExpiry(url) {
    const fallback = new Date(Date.now() + STREAM_CACHE_TTL * 1000).toISOString();
    try {
        const parsed = new URL(url);
        const expire = parsed.searchParams.get('expire');
        if (!expire) return fallback;
        return new Date(parseInt(expire, 10) * 1000).toISOString();
    } catch {
        return fallback;
    }
}

module.exports = { extractFormats, pickStreams, parseExpiry };
