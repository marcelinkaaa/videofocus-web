const { execFile } = require('node:child_process');

const YT_DLP_PATH = process.env.YT_DLP_PATH || 'yt-dlp';
const YT_DLP_TIMEOUT = parseInt(process.env.YT_DLP_TIMEOUT || '15000', 10);
const STREAM_CACHE_TTL = parseInt(process.env.STREAM_CACHE_TTL || '18000', 10);

// Concurrency limiter — prevent spawning too many yt-dlp processes
const MAX_CONCURRENT = 3;
let active = 0;
const queue = [];

function acquireSlot() {
    if (active < MAX_CONCURRENT) {
        active++;
        return Promise.resolve();
    }
    return new Promise((resolve) => queue.push(resolve));
}

function releaseSlot() {
    active--;
    if (queue.length > 0) {
        active++;
        queue.shift()();
    }
}

function extractFormats(videoId) {
    return new Promise(async (resolve, reject) => {
        await acquireSlot();
        const args = [
            '-j', '--no-download',
            '--extractor-args', 'youtube:player_client=web',
            '--js-runtimes', 'node',
            '--', `https://www.youtube.com/watch?v=${videoId}`,
        ];
        execFile(YT_DLP_PATH, args, {
            timeout: YT_DLP_TIMEOUT,
            maxBuffer: 5 * 1024 * 1024,
            killSignal: 'SIGKILL',
        }, (err, stdout, stderr) => {
            releaseSlot();
            if (err) {
                if (err.killed) return reject(new Error('yt-dlp timed out'));
                const detail = stderr || stdout || err.message;
                return reject(new Error(`yt-dlp failed: ${detail}`));
            }
            try {
                resolve(JSON.parse(stdout));
            } catch (e) {
                reject(new Error('yt-dlp returned invalid JSON'));
            }
        });
    });
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
