"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.MessageController = void 0;
const path_1 = __importDefault(require("path"));
const fs_1 = __importDefault(require("fs"));
const uuid_1 = require("uuid");
const whatsapp_service_1 = require("../services/whatsapp.service");
const db_1 = require("../database/db");
const config_1 = require("../config");
class MessageController {
    static async sendText(req, res) {
        try {
            const { sessionId, to, text } = req.body;
            if (!sessionId || !to || !text) {
                return res.status(400).json({ success: false, error: 'sessionId, to, and text are required' });
            }
            // Verify session belongs to user
            const session = whatsapp_service_1.WhatsAppService.getSessionById(sessionId);
            if (!session || session.user_id !== req.user.id) {
                return res.status(404).json({ success: false, error: 'WhatsApp session not found' });
            }
            const result = await whatsapp_service_1.WhatsAppService.sendTextMessage(req.user.id, sessionId, to, text);
            return res.json({ success: true, ...result });
        }
        catch (error) {
            return res.status(400).json({ success: false, error: error.message });
        }
    }
    static async sendMedia(req, res) {
        try {
            const { sessionId, to, mediaUrl, mediaType, caption, fileName } = req.body;
            if (!sessionId || !to || (!mediaUrl && !req.file) || !mediaType) {
                return res.status(400).json({ success: false, error: 'sessionId, to, media file/url, and mediaType are required' });
            }
            const session = whatsapp_service_1.WhatsAppService.getSessionById(sessionId);
            if (!session || session.user_id !== req.user.id) {
                return res.status(404).json({ success: false, error: 'WhatsApp session not found' });
            }
            const mediaSource = req.file ? req.file.buffer : mediaUrl;
            const originalName = req.file ? req.file.originalname : fileName;
            const result = await whatsapp_service_1.WhatsAppService.sendMediaMessage(req.user.id, sessionId, to, mediaSource, mediaType, caption, originalName);
            return res.json({ success: true, ...result });
        }
        catch (error) {
            return res.status(400).json({ success: false, error: error.message });
        }
    }
    static async sendBulk(req, res) {
        try {
            const { sessionId, numbers, message, delaySeconds = 3 } = req.body;
            if (!sessionId || !Array.isArray(numbers) || numbers.length === 0 || !message) {
                return res.status(400).json({ success: false, error: 'sessionId, numbers array, and message are required' });
            }
            const session = whatsapp_service_1.WhatsAppService.getSessionById(sessionId);
            if (!session || session.user_id !== req.user.id) {
                return res.status(404).json({ success: false, error: 'WhatsApp session not found' });
            }
            // Process in background asynchronously so API returns immediate campaign tracking ID
            const results = [];
            const delayMs = Math.max(delaySeconds * 1000, 1500); // minimum 1.5s delay to prevent bans
            // Start asynchronous sending loop
            (async () => {
                for (const num of numbers) {
                    try {
                        const sent = await whatsapp_service_1.WhatsAppService.sendTextMessage(req.user.id, sessionId, num, message);
                        results.push({ number: num, status: 'SENT', messageId: sent.messageId });
                    }
                    catch (err) {
                        results.push({ number: num, status: 'FAILED', error: err.message });
                    }
                    await new Promise((resolve) => setTimeout(resolve, delayMs));
                }
            })();
            return res.json({
                success: true,
                message: `Campaign initiated for ${numbers.length} recipients with ${delaySeconds}s delay`,
                total: numbers.length,
            });
        }
        catch (error) {
            return res.status(400).json({ success: false, error: error.message });
        }
    }
    static async getMessages(req, res) {
        try {
            const { sessionId, jid } = req.query;
            let query = 'SELECT * FROM messages WHERE user_id = ?';
            const params = [req.user.id];
            if (sessionId) {
                query += ' AND session_id = ?';
                params.push(sessionId);
            }
            if (jid) {
                const jidStr = String(jid).trim();
                const baseId = jidStr.includes('@') ? jidStr.split('@')[0] : jidStr;
                query += ` AND (
          remote_jid = ? 
          OR substr(remote_jid, 1, instr(remote_jid, '@') - 1) = ?
          OR remote_jid LIKE ?
        )`;
                params.push(jidStr, baseId, `${baseId}@%`);
            }
            query += ' ORDER BY timestamp ASC LIMIT 300';
            const messages = db_1.db.prepare(query).all(...params);
            return res.json({ success: true, messages });
        }
        catch (error) {
            return res.status(500).json({ success: false, error: error.message });
        }
    }
    static async getChats(req, res) {
        try {
            const { sessionId } = req.query;
            // Query that groups by contact base ID (merging @lid, @s.whatsapp.net, etc.) and filters out broadcasts
            const query = `
        SELECT 
          m.remote_jid,
          m.session_id,
          m.body as last_message,
          m.timestamp as last_timestamp,
          m.from_me,
          m.media_type,
          m.media_url,
          COALESCE(
            NULLIF(c.name, ''),
            (SELECT push_name FROM messages m_name WHERE m_name.session_id = m.session_id AND (m_name.remote_jid = m.remote_jid OR substr(m_name.remote_jid, 1, instr(m_name.remote_jid, '@') - 1) = substr(m.remote_jid, 1, instr(m.remote_jid, '@') - 1)) AND push_name IS NOT NULL AND push_name != '' AND push_name != 'You' ORDER BY timestamp DESC LIMIT 1),
            ''
          ) as name,
          COALESCE(
            NULLIF(c.phone_number, ''),
            (CASE WHEN m.remote_jid NOT LIKE '%@lid' THEN substr(m.remote_jid, 1, instr(m.remote_jid, '@') - 1) ELSE '' END)
          ) as phone_number,
          COALESCE(c.avatar_url, '') as avatar_url,
          substr(m.remote_jid, 1, instr(m.remote_jid, '@') - 1) as base_id
        FROM messages m
        INNER JOIN (
          SELECT 
            substr(remote_jid, 1, instr(remote_jid, '@') - 1) as group_id,
            MAX(timestamp) as max_time
          FROM messages
          WHERE user_id = ? 
            AND remote_jid NOT LIKE '%@broadcast' 
            AND remote_jid NOT LIKE '%newsletter%'
            ${sessionId ? 'AND session_id = ?' : ''}
          GROUP BY substr(remote_jid, 1, instr(remote_jid, '@') - 1)
        ) latest ON substr(m.remote_jid, 1, instr(m.remote_jid, '@') - 1) = latest.group_id AND m.timestamp = latest.max_time
        LEFT JOIN contacts c ON c.session_id = m.session_id AND (c.jid = m.remote_jid OR substr(c.jid, 1, instr(c.jid, '@') - 1) = substr(m.remote_jid, 1, instr(m.remote_jid, '@') - 1))
        WHERE m.user_id = ? 
          AND m.remote_jid NOT LIKE '%@broadcast' 
          AND m.remote_jid NOT LIKE '%newsletter%'
          ${sessionId ? 'AND m.session_id = ?' : ''}
        GROUP BY substr(m.remote_jid, 1, instr(m.remote_jid, '@') - 1)
        ORDER BY m.timestamp DESC
        LIMIT 100
      `;
            const params = sessionId
                ? [req.user.id, sessionId, req.user.id, sessionId]
                : [req.user.id, req.user.id];
            const chats = db_1.db.prepare(query).all(...params);
            // Enhance with human-readable phone number & display names
            const formattedChats = chats.map((c) => {
                const jid = c.remote_jid || '';
                const baseId = c.base_id || (jid.includes('@') ? jid.split('@')[0] : jid);
                const rawPhone = c.phone_number || '';
                const name = c.name || '';
                let displayPhone = '';
                if (rawPhone && rawPhone.length <= 13) {
                    displayPhone = rawPhone.startsWith('+') ? rawPhone : `+${rawPhone}`;
                }
                else if (rawPhone && rawPhone.length > 13) {
                    displayPhone = `ID: ${rawPhone}`;
                }
                const displayName = name || displayPhone || baseId;
                return {
                    ...c,
                    name,
                    phone_number: displayPhone || rawPhone,
                    display_name: displayName,
                };
            });
            return res.json({ success: true, chats: formattedChats });
        }
        catch (error) {
            return res.status(500).json({ success: false, error: error.message });
        }
    }
    static async getAvatar(req, res) {
        try {
            const { sessionId, jid } = req.query;
            if (!sessionId || !jid) {
                return res.status(400).json({ success: false, error: 'sessionId and jid are required' });
            }
            const avatarUrl = await whatsapp_service_1.WhatsAppService.getProfilePicture(sessionId, jid);
            const base = jid.split('@')[0];
            const contact = db_1.db.prepare('SELECT name, phone_number, avatar_url FROM contacts WHERE session_id = ? AND (jid = ? OR jid LIKE ? OR phone_number = ?)').get(sessionId, jid, `${base}@%`, base);
            return res.json({
                success: true,
                avatarUrl: avatarUrl || contact?.avatar_url || null,
                name: contact?.name || '',
                phone: contact?.phone_number || ''
            });
        }
        catch (error) {
            return res.json({ success: false, avatarUrl: null });
        }
    }
    static async updateContact(req, res) {
        try {
            const { sessionId, jid, name, phoneNumber, avatarUrl } = req.body;
            if (!sessionId || !jid) {
                return res.status(400).json({ success: false, error: 'sessionId and jid are required' });
            }
            let finalAvatarUrl = avatarUrl || null;
            if (req.file) {
                const ext = path_1.default.extname(req.file.originalname) || '.jpg';
                const fname = `avatar_${(0, uuid_1.v4)()}${ext}`;
                const fpath = path_1.default.join(config_1.config.mediaDir, fname);
                fs_1.default.writeFileSync(fpath, req.file.buffer);
                finalAvatarUrl = `/media/${fname}`;
            }
            const contactId = `${sessionId}_${jid}`;
            db_1.db.prepare(`
        INSERT INTO contacts (id, user_id, session_id, jid, name, phone_number, avatar_url, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
        ON CONFLICT(session_id, jid) DO UPDATE SET
          name = COALESCE(NULLIF(excluded.name, ''), contacts.name),
          phone_number = COALESCE(NULLIF(excluded.phone_number, ''), contacts.phone_number),
          avatar_url = COALESCE(NULLIF(excluded.avatar_url, ''), contacts.avatar_url),
          updated_at = CURRENT_TIMESTAMP
      `).run(contactId, req.user.id, sessionId, jid, name || '', phoneNumber || '', finalAvatarUrl);
            return res.json({ success: true, message: 'Contact updated successfully', avatarUrl: finalAvatarUrl });
        }
        catch (err) {
            return res.status(500).json({ success: false, error: err.message });
        }
    }
}
exports.MessageController = MessageController;
