const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { pickStreams, parseExpiry } = require('../src/ytdlp');

describe('pickStreams', () => {
    const sampleFormats = [
        { format_id: '18', ext: 'mp4', vcodec: 'avc1.42001E', acodec: 'mp4a.40.2', height: 360, width: 640, url: 'https://rr1.googlevideo.com/360?expire=9999999999', tbr: 500 },
        { format_id: '22', ext: 'mp4', vcodec: 'avc1.64001F', acodec: 'mp4a.40.2', height: 720, width: 1280, url: 'https://rr1.googlevideo.com/720?expire=9999999999', tbr: 1500 },
        { format_id: '137', ext: 'mp4', vcodec: 'avc1.640028', acodec: 'none', height: 1080, width: 1920, url: 'https://rr1.googlevideo.com/1080v?expire=9999999999', tbr: 4000 },
        { format_id: '140', ext: 'm4a', vcodec: 'none', acodec: 'mp4a.40.2', height: null, width: null, url: 'https://rr1.googlevideo.com/audio?expire=9999999999', tbr: 128 },
        { format_id: '251', ext: 'webm', vcodec: 'none', acodec: 'opus', height: null, width: null, url: 'https://rr1.googlevideo.com/opus', tbr: 160 },
        { format_id: '399', ext: 'mp4', vcodec: 'av01', acodec: 'none', height: 1080, width: 1920, manifest_url: 'https://manifest.googlevideo.com/dash', tbr: 3000 },
    ];

    it('picks muxed mp4 at preferred quality', () => {
        const result = pickStreams(sampleFormats, 720);
        assert.equal(result.muxed.height, 720);
        assert.equal(result.muxed.ext, 'mp4');
    });

    it('falls back to lower quality muxed if preferred not available', () => {
        const result = pickStreams(sampleFormats, 1080);
        assert.equal(result.muxed.height, 720); // muxed caps at 720
    });

    it('picks best adaptive video at or below preferred quality', () => {
        const result = pickStreams(sampleFormats, 1080);
        assert.equal(result.video.height, 1080);
        assert.equal(result.video.acodec, 'none');
    });

    it('picks highest bitrate m4a audio', () => {
        const result = pickStreams(sampleFormats, 720);
        assert.equal(result.audio.ext, 'm4a');
        assert.equal(result.audio.tbr, 128);
    });

    it('skips formats without url field (DASH manifest only)', () => {
        const result = pickStreams(sampleFormats, 1080);
        assert.notEqual(result.video.format_id, '399');
    });

    it('skips non-mp4 for muxed and video', () => {
        const webmOnly = [
            { format_id: '43', ext: 'webm', vcodec: 'vp8', acodec: 'vorbis', height: 360, url: 'https://x.com/webm', tbr: 500 },
        ];
        const result = pickStreams(webmOnly, 720);
        assert.equal(result.muxed, null);
        assert.equal(result.video, null);
    });

    it('returns all nulls for empty formats array', () => {
        const result = pickStreams([], 720);
        assert.deepEqual(result, { muxed: null, video: null, audio: null });
    });
});

describe('parseExpiry', () => {
    it('extracts expire timestamp from googlevideo URL', () => {
        const url = 'https://rr1.googlevideo.com/videoplayback?expire=1712764800&other=1';
        const result = parseExpiry(url);
        assert.equal(result, '2024-04-10T16:00:00.000Z');
    });

    it('returns fallback when expire param missing', () => {
        const url = 'https://rr1.googlevideo.com/videoplayback?other=1';
        const before = Date.now();
        const result = parseExpiry(url);
        const parsed = new Date(result).getTime();
        assert.ok(parsed > before + 4 * 3600 * 1000);
        assert.ok(parsed < before + 6 * 3600 * 1000);
    });

    it('returns fallback for malformed input', () => {
        const before = Date.now();
        const result = parseExpiry('not-a-url');
        const parsed = new Date(result).getTime();
        assert.ok(parsed > before + 4 * 3600 * 1000);
    });
});
