const rateLimit = require('express-rate-limit');

const RATE_LIMIT_RPM = parseInt(process.env.RATE_LIMIT_RPM || '60', 10);
const API_KEY = process.env.API_KEY;

const limiter = rateLimit({
    windowMs: 60 * 1000,
    max: RATE_LIMIT_RPM,
    standardHeaders: true,
    legacyHeaders: false,
});

function requireApiKey(req, res, next) {
    const auth = req.headers['authorization'] || '';
    const queryKey = req.query.key || '';
    if (!API_KEY || (auth !== `Bearer ${API_KEY}` && queryKey !== API_KEY)) {
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

module.exports = { limiter, requireApiKey, requireVideoFocusAgent };
