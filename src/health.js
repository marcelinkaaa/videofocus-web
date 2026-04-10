function createHealthChecker(extractFn, videoId, intervalMs) {
    const status = {
        ok: false,
        lastSuccess: null,
        lastError: null,
        lastCheckAt: null,
    };

    let timer = null;

    async function check() {
        status.lastCheckAt = new Date().toISOString();
        try {
            await extractFn(videoId);
            status.ok = true;
            status.lastSuccess = status.lastCheckAt;
            status.lastError = null;
        } catch (err) {
            status.ok = false;
            status.lastError = err.message;
        }
    }

    setTimeout(check, 5000);
    timer = setInterval(check, intervalMs || 30 * 60 * 1000);

    return {
        status() { return { ...status }; },
        stop() { clearInterval(timer); },
    };
}

module.exports = { createHealthChecker };
