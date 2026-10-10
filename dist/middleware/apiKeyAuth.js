"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.apiKeyOrJwtAuth = apiKeyOrJwtAuth;
const auth_service_1 = require("../services/auth.service");
function apiKeyOrJwtAuth(req, res, next) {
    // 1. Check API Key in headers or query
    const apiKey = req.headers['x-api-key'] || req.query.api_key;
    if (apiKey) {
        const user = auth_service_1.AuthService.validateApiKey(apiKey);
        if (!user) {
            return res.status(401).json({ success: false, error: 'Unauthorized: Invalid or inactive API Key' });
        }
        req.user = user;
        return next();
    }
    // 2. Check Authorization Bearer header (could be API Key or JWT)
    const authHeader = req.headers.authorization;
    if (authHeader && authHeader.startsWith('Bearer ')) {
        const token = authHeader.split(' ')[1];
        if (token.startsWith('ak_live_')) {
            const user = auth_service_1.AuthService.validateApiKey(token);
            if (!user) {
                return res.status(401).json({ success: false, error: 'Unauthorized: Invalid or inactive API Key' });
            }
            req.user = user;
            return next();
        }
        const decoded = auth_service_1.AuthService.verifyToken(token);
        if (decoded) {
            const user = auth_service_1.AuthService.getUserById(decoded.id);
            if (user && user.is_active) {
                req.user = user;
                return next();
            }
        }
    }
    return res.status(401).json({
        success: false,
        error: 'Unauthorized: Provide an API Key via X-API-Key header or Bearer token',
    });
}
