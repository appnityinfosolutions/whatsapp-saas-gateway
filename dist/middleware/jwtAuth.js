"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.jwtAuth = jwtAuth;
const auth_service_1 = require("../services/auth.service");
function jwtAuth(req, res, next) {
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
        return res.status(401).json({ success: false, error: 'Unauthorized: Missing or invalid token' });
    }
    const token = authHeader.split(' ')[1];
    const decoded = auth_service_1.AuthService.verifyToken(token);
    if (!decoded) {
        return res.status(401).json({ success: false, error: 'Unauthorized: Token expired or invalid' });
    }
    const user = auth_service_1.AuthService.getUserById(decoded.id);
    if (!user || !user.is_active) {
        return res.status(401).json({ success: false, error: 'Unauthorized: User not found or suspended' });
    }
    req.user = user;
    next();
}
