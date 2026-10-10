"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.AuthController = void 0;
const auth_service_1 = require("../services/auth.service");
const db_1 = require("../database/db");
class AuthController {
    static async register(req, res) {
        try {
            const { name, email, password, plan } = req.body;
            if (!name || !email || !password) {
                return res.status(400).json({ success: false, error: 'Name, email and password are required' });
            }
            const result = await auth_service_1.AuthService.register(name, email, password, plan);
            return res.status(201).json({ success: true, ...result });
        }
        catch (error) {
            return res.status(400).json({ success: false, error: error.message });
        }
    }
    static async login(req, res) {
        try {
            const { email, password } = req.body;
            if (!email || !password) {
                return res.status(400).json({ success: false, error: 'Email and password are required' });
            }
            const result = await auth_service_1.AuthService.login(email, password);
            return res.json({ success: true, ...result });
        }
        catch (error) {
            return res.status(400).json({ success: false, error: error.message });
        }
    }
    static async me(req, res) {
        return res.json({ success: true, user: req.user });
    }
    static async updateProfile(req, res) {
        try {
            const { name, webhook_url } = req.body;
            db_1.db.prepare(`
        UPDATE users SET name = COALESCE(?, name), webhook_url = COALESCE(?, webhook_url), updated_at = CURRENT_TIMESTAMP
        WHERE id = ?
      `).run(name, webhook_url, req.user.id);
            const updated = auth_service_1.AuthService.getUserById(req.user.id);
            return res.json({ success: true, user: updated });
        }
        catch (error) {
            return res.status(400).json({ success: false, error: error.message });
        }
    }
    static async getApiKeys(req, res) {
        const keys = auth_service_1.AuthService.getApiKeys(req.user.id);
        return res.json({ success: true, keys });
    }
    static async createApiKey(req, res) {
        try {
            const { name } = req.body;
            const key = await auth_service_1.AuthService.generateApiKey(req.user.id, name || 'API Key');
            return res.status(201).json({ success: true, key });
        }
        catch (error) {
            return res.status(400).json({ success: false, error: error.message });
        }
    }
    static async deleteApiKey(req, res) {
        try {
            const { keyId } = req.params;
            auth_service_1.AuthService.deleteApiKey(req.user.id, keyId);
            return res.json({ success: true, message: 'API Key deleted' });
        }
        catch (error) {
            return res.status(400).json({ success: false, error: error.message });
        }
    }
}
exports.AuthController = AuthController;
