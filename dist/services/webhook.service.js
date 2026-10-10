"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.WebhookService = void 0;
const axios_1 = __importDefault(require("axios"));
const uuid_1 = require("uuid");
const db_1 = require("../database/db");
class WebhookService {
    static async sendWebhook(userId, sessionId, event, payload, customUrl) {
        let url = customUrl;
        if (!url) {
            // Check session webhook or user webhook
            const sessionRow = db_1.db.prepare('SELECT webhook_url FROM sessions WHERE id = ?').get(sessionId);
            if (sessionRow && sessionRow.webhook_url) {
                url = sessionRow.webhook_url;
            }
            else {
                const userRow = db_1.db.prepare('SELECT webhook_url FROM users WHERE id = ?').get(userId);
                if (userRow && userRow.webhook_url) {
                    url = userRow.webhook_url;
                }
            }
        }
        if (!url || !url.startsWith('http')) {
            return; // No webhook configured
        }
        const logId = (0, uuid_1.v4)();
        const body = {
            event,
            timestamp: Date.now(),
            sessionId,
            data: payload,
        };
        try {
            const response = await axios_1.default.post(url, body, {
                timeout: 8000,
                headers: {
                    'Content-Type': 'application/json',
                    'User-Agent': 'WhatsApp-SaaS-Gateway-Webhook/1.0',
                },
            });
            db_1.db.prepare(`
        INSERT INTO webhook_logs (id, user_id, session_id, event, url, payload, response_status, response_body, success)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1)
      `).run(logId, userId, sessionId, event, url, JSON.stringify(body), response.status, typeof response.data === 'string' ? response.data.substring(0, 500) : JSON.stringify(response.data).substring(0, 500));
        }
        catch (error) {
            db_1.db.prepare(`
        INSERT INTO webhook_logs (id, user_id, session_id, event, url, payload, response_status, response_body, success)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0)
      `).run(logId, userId, sessionId, event, url, JSON.stringify(body), error.response?.status || 0, error.message || 'Connection failed');
        }
    }
    static getLogs(userId, limit = 50) {
        return db_1.db.prepare(`
      SELECT * FROM webhook_logs WHERE user_id = ? ORDER BY created_at DESC LIMIT ?
    `).all(userId, limit);
    }
}
exports.WebhookService = WebhookService;
