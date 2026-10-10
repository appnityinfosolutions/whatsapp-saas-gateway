import axios from 'axios';
import { v4 as uuidv4 } from 'uuid';
import { db } from '../database/db';

export class WebhookService {
  static async sendWebhook(userId: string, sessionId: string, event: string, payload: any, customUrl?: string) {
    let url = customUrl;

    if (!url) {
      // Check session webhook or user webhook
      const sessionRow: any = db.prepare('SELECT webhook_url FROM sessions WHERE id = ?').get(sessionId);
      if (sessionRow && sessionRow.webhook_url) {
        url = sessionRow.webhook_url;
      } else {
        const userRow: any = db.prepare('SELECT webhook_url FROM users WHERE id = ?').get(userId);
        if (userRow && userRow.webhook_url) {
          url = userRow.webhook_url;
        }
      }
    }

    if (!url || !url.startsWith('http')) {
      return; // No webhook configured
    }

    const logId = uuidv4();
    const body = {
      event,
      timestamp: Date.now(),
      sessionId,
      data: payload,
    };

    try {
      const response = await axios.post(url, body, {
        timeout: 8000,
        headers: {
          'Content-Type': 'application/json',
          'User-Agent': 'WhatsApp-SaaS-Gateway-Webhook/1.0',
        },
      });

      db.prepare(`
        INSERT INTO webhook_logs (id, user_id, session_id, event, url, payload, response_status, response_body, success)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1)
      `).run(
        logId,
        userId,
        sessionId,
        event,
        url,
        JSON.stringify(body),
        response.status,
        typeof response.data === 'string' ? response.data.substring(0, 500) : JSON.stringify(response.data).substring(0, 500)
      );
    } catch (error: any) {
      db.prepare(`
        INSERT INTO webhook_logs (id, user_id, session_id, event, url, payload, response_status, response_body, success)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0)
      `).run(
        logId,
        userId,
        sessionId,
        event,
        url,
        JSON.stringify(body),
        error.response?.status || 0,
        error.message || 'Connection failed'
      );
    }
  }

  static getLogs(userId: string, limit: number = 50) {
    return db.prepare(`
      SELECT * FROM webhook_logs WHERE user_id = ? ORDER BY created_at DESC LIMIT ?
    `).all(userId, limit);
  }
}
