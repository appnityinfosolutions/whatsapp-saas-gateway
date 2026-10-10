"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.StatsController = void 0;
const db_1 = require("../database/db");
class StatsController {
    static async getOverview(req, res) {
        try {
            const userId = req.user.id;
            // 1. Session counts
            const totalSessions = db_1.db.prepare('SELECT COUNT(*) as count FROM sessions WHERE user_id = ?').get(userId);
            const activeSessions = db_1.db.prepare("SELECT COUNT(*) as count FROM sessions WHERE user_id = ? AND status = 'CONNECTED'").get(userId);
            // 2. Message counts
            const sentMsgs = db_1.db.prepare('SELECT COUNT(*) as count FROM messages WHERE user_id = ? AND from_me = 1').get(userId);
            const receivedMsgs = db_1.db.prepare('SELECT COUNT(*) as count FROM messages WHERE user_id = ? AND from_me = 0').get(userId);
            // 3. Today's message usage
            const startOfDay = Math.floor(new Date().setHours(0, 0, 0, 0) / 1000);
            const todayMsgs = db_1.db.prepare('SELECT COUNT(*) as count FROM messages WHERE user_id = ? AND from_me = 1 AND timestamp >= ?').get(userId, startOfDay);
            // 4. Webhook deliveries
            const totalWebhooks = db_1.db.prepare('SELECT COUNT(*) as count FROM webhook_logs WHERE user_id = ?').get(userId);
            const successWebhooks = db_1.db.prepare('SELECT COUNT(*) as count FROM webhook_logs WHERE user_id = ? AND success = 1').get(userId);
            // 5. Recent Activity
            const recentMessages = db_1.db.prepare(`
        SELECT m.*, s.session_name 
        FROM messages m
        JOIN sessions s ON m.session_id = s.id
        WHERE m.user_id = ?
        ORDER BY m.created_at DESC
        LIMIT 10
      `).all(userId);
            return res.json({
                success: true,
                stats: {
                    sessions: {
                        total: totalSessions.count,
                        active: activeSessions.count,
                        maxAllowed: req.user.max_sessions,
                    },
                    messages: {
                        sentTotal: sentMsgs.count,
                        receivedTotal: receivedMsgs.count,
                        sentToday: todayMsgs.count,
                        dailyLimit: req.user.daily_msg_limit,
                    },
                    webhooks: {
                        total: totalWebhooks.count,
                        success: successWebhooks.count,
                        rate: totalWebhooks.count > 0 ? Math.round((successWebhooks.count / totalWebhooks.count) * 100) : 100,
                    },
                    plan: {
                        name: req.user.plan,
                        role: req.user.role,
                    },
                    recentMessages,
                },
            });
        }
        catch (error) {
            return res.status(500).json({ success: false, error: error.message });
        }
    }
}
exports.StatsController = StatsController;
