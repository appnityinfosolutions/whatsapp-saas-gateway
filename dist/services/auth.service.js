"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.AuthService = void 0;
const bcryptjs_1 = __importDefault(require("bcryptjs"));
const jsonwebtoken_1 = __importDefault(require("jsonwebtoken"));
const crypto_1 = __importDefault(require("crypto"));
const uuid_1 = require("uuid");
const db_1 = require("../database/db");
const config_1 = require("../config");
class AuthService {
    static async register(name, email, password, plan = 'starter') {
        const existing = db_1.db.prepare('SELECT id FROM users WHERE email = ?').get(email);
        if (existing) {
            throw new Error('Email is already registered');
        }
        const salt = await bcryptjs_1.default.genSalt(10);
        const passwordHash = await bcryptjs_1.default.hash(password, salt);
        const userId = (0, uuid_1.v4)();
        let maxSessions = config_1.config.defaultMaxSessions;
        let dailyMsgLimit = config_1.config.defaultDailyMsgLimit;
        if (plan === 'pro') {
            maxSessions = 10;
            dailyMsgLimit = 10000;
        }
        else if (plan === 'enterprise') {
            maxSessions = 50;
            dailyMsgLimit = 100000;
        }
        db_1.db.prepare(`
      INSERT INTO users (id, name, email, password_hash, role, plan, max_sessions, daily_msg_limit)
      VALUES (?, ?, ?, ?, 'user', ?, ?, ?)
    `).run(userId, name, email, passwordHash, plan, maxSessions, dailyMsgLimit);
        // Auto generate default API key for the new user
        const apiKey = await this.generateApiKey(userId, 'Default Key');
        const user = this.getUserById(userId);
        const token = this.generateToken(user);
        return { user, token, apiKey };
    }
    static async login(email, password) {
        const userRow = db_1.db.prepare('SELECT * FROM users WHERE email = ?').get(email);
        if (!userRow) {
            throw new Error('Invalid email or password');
        }
        if (!userRow.is_active) {
            throw new Error('Account is suspended. Please contact support.');
        }
        const isMatch = await bcryptjs_1.default.compare(password, userRow.password_hash);
        if (!isMatch) {
            throw new Error('Invalid email or password');
        }
        const { password_hash, ...user } = userRow;
        const token = this.generateToken(user);
        return { user, token };
    }
    static generateToken(user) {
        return jsonwebtoken_1.default.sign({ id: user.id, email: user.email, role: user.role, plan: user.plan }, config_1.config.jwtSecret, { expiresIn: '7d' });
    }
    static verifyToken(token) {
        try {
            return jsonwebtoken_1.default.verify(token, config_1.config.jwtSecret);
        }
        catch {
            return null;
        }
    }
    static getUserById(id) {
        const row = db_1.db.prepare(`
      SELECT id, name, email, role, plan, max_sessions, daily_msg_limit, webhook_url, is_active, created_at 
      FROM users WHERE id = ?
    `).get(id);
        return row || null;
    }
    static async generateApiKey(userId, name = 'API Key') {
        const keyId = (0, uuid_1.v4)();
        const rawKey = 'ak_live_' + crypto_1.default.randomBytes(24).toString('hex');
        const keyPrefix = rawKey.substring(0, 15) + '...';
        const keyHash = crypto_1.default.createHash('sha256').update(rawKey).digest('hex');
        db_1.db.prepare(`
      INSERT INTO api_keys (id, user_id, name, key_hash, key_prefix)
      VALUES (?, ?, ?, ?, ?)
    `).run(keyId, userId, name, keyHash, keyPrefix);
        return {
            id: keyId,
            name,
            apiKey: rawKey,
            keyPrefix,
        };
    }
    static validateApiKey(apiKey) {
        if (!apiKey || !apiKey.startsWith('ak_live_'))
            return null;
        const keyHash = crypto_1.default.createHash('sha256').update(apiKey).digest('hex');
        const keyRow = db_1.db.prepare(`
      SELECT k.id as key_id, k.user_id, k.is_active as key_active, u.*
      FROM api_keys k
      JOIN users u ON k.user_id = u.id
      WHERE k.key_hash = ? AND k.is_active = 1 AND u.is_active = 1
    `).get(keyHash);
        if (!keyRow)
            return null;
        // Update last_used_at timestamp
        db_1.db.prepare('UPDATE api_keys SET last_used_at = CURRENT_TIMESTAMP WHERE id = ?').run(keyRow.key_id);
        const { password_hash, key_id, key_active, user_id, ...user } = keyRow;
        return user;
    }
    static getApiKeys(userId) {
        return db_1.db.prepare(`
      SELECT id, name, key_prefix, is_active, last_used_at, created_at
      FROM api_keys WHERE user_id = ? ORDER BY created_at DESC
    `).all(userId);
    }
    static deleteApiKey(userId, keyId) {
        return db_1.db.prepare('DELETE FROM api_keys WHERE id = ? AND user_id = ?').run(keyId, userId);
    }
}
exports.AuthService = AuthService;
