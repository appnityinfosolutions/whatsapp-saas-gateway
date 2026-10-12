"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.WhatsAppService = void 0;
const baileys_1 = __importStar(require("@whiskeysockets/baileys"));
const pino_1 = __importDefault(require("pino"));
const path_1 = __importDefault(require("path"));
const fs_1 = __importDefault(require("fs"));
const qrcode_1 = __importDefault(require("qrcode"));
const uuid_1 = require("uuid");
const db_1 = require("../database/db");
const config_1 = require("../config");
const webhook_service_1 = require("./webhook.service");
const logger = (0, pino_1.default)({ level: 'silent' });
class WhatsAppService {
    static sockets = new Map();
    static io = null;
    static setSocketIO(ioInstance) {
        this.io = ioInstance;
    }
    static getSessionPath(sessionId) {
        const sessionDir = path_1.default.join(config_1.config.sessionsDir, sessionId);
        if (!fs_1.default.existsSync(sessionDir)) {
            fs_1.default.mkdirSync(sessionDir, { recursive: true });
        }
        return sessionDir;
    }
    static async createSession(userId, sessionName, webhookUrl) {
        // Check plan quota
        const user = db_1.db.prepare('SELECT max_sessions FROM users WHERE id = ?').get(userId);
        const count = db_1.db.prepare('SELECT COUNT(*) as count FROM sessions WHERE user_id = ?').get(userId);
        if (count.count >= user.max_sessions) {
            throw new Error(`Session limit reached (${count.count}/${user.max_sessions}). Upgrade your plan to add more sessions.`);
        }
        const sessionId = (0, uuid_1.v4)();
        db_1.db.prepare(`
      INSERT INTO sessions (id, user_id, session_name, status, webhook_url)
      VALUES (?, ?, ?, 'STOPPED', ?)
    `).run(sessionId, userId, sessionName, webhookUrl || null);
        return this.getSessionById(sessionId);
    }
    static async startSession(userId, sessionId) {
        const session = db_1.db.prepare('SELECT * FROM sessions WHERE id = ? AND user_id = ?').get(sessionId, userId);
        if (!session) {
            throw new Error('Session not found');
        }
        if (this.sockets.has(sessionId)) {
            return { message: 'Session is already running', status: session.status };
        }
        const sessionDir = this.getSessionPath(sessionId);
        // Always force fresh QR generation by clearing stale auth state if not connected
        if (session.status !== 'CONNECTED') {
            try {
                fs_1.default.rmSync(sessionDir, { recursive: true, force: true });
            }
            catch { }
        }
        const { state, saveCreds } = await (0, baileys_1.useMultiFileAuthState)(sessionDir);
        const { version, isLatest } = await (0, baileys_1.fetchLatestBaileysVersion)();
        // Always reset QR code and status to STARTING to force fresh QR generation
        db_1.db.prepare("UPDATE sessions SET status = 'STARTING', qr_code = NULL, updated_at = CURRENT_TIMESTAMP WHERE id = ?").run(sessionId);
        this.emitToUser(userId, 'session_status', { sessionId, status: 'STARTING' });
        const sock = (0, baileys_1.default)({
            version,
            logger,
            printQRInTerminal: false,
            auth: {
                creds: state.creds,
                keys: (0, baileys_1.makeCacheableSignalKeyStore)(state.keys, logger),
            },
            browser: ['WhatsApp SaaS Gateway', 'Chrome', '124.0.0'],
            generateHighQualityLinkPreview: true,
            syncFullHistory: true,
            // Connection stability improvements
            keepAliveIntervalMs: 30000, // Send ping every 30 seconds
            markOnlineOnConnect: true,
            // Reconnection settings
            retryRequestDelayMs: 500,
            maxMsgRetryCount: 5,
            // Link preview settings
            linkPreviewImageThumbnailWidth: 192,
        });
        this.sockets.set(sessionId, sock);
        sock.ev.on('creds.update', saveCreds);
        sock.ev.on('connection.update', async (update) => {
            const { connection, lastDisconnect, qr } = update;
            if (qr) {
                try {
                    const qrDataUrl = await qrcode_1.default.toDataURL(qr, { width: 300, margin: 2 });
                    db_1.db.prepare("UPDATE sessions SET status = 'SCAN_QR', qr_code = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?").run(qrDataUrl, sessionId);
                    this.emitToUser(userId, 'session_qr', { sessionId, qr: qrDataUrl });
                }
                catch (e) {
                    console.error('Error generating QR Code data URL:', e);
                }
            }
            if (connection === 'close') {
                const statusCode = lastDisconnect?.error?.output?.statusCode;
                const shouldReconnect = statusCode !== baileys_1.DisconnectReason.loggedOut;
                this.sockets.delete(sessionId);
                if (statusCode === baileys_1.DisconnectReason.loggedOut) {
                    db_1.db.prepare("UPDATE sessions SET status = 'LOGGED_OUT', qr_code = NULL, updated_at = CURRENT_TIMESTAMP WHERE id = ?").run(sessionId);
                    this.emitToUser(userId, 'session_status', { sessionId, status: 'LOGGED_OUT' });
                    // Clear session auth state folder
                    try {
                        fs_1.default.rmSync(sessionDir, { recursive: true, force: true });
                    }
                    catch { }
                }
                else {
                    db_1.db.prepare("UPDATE sessions SET status = 'DISCONNECTED', qr_code = NULL, updated_at = CURRENT_TIMESTAMP WHERE id = ?").run(sessionId);
                    this.emitToUser(userId, 'session_status', { sessionId, status: 'DISCONNECTED' });
                    if (shouldReconnect && session.is_auto_reconnect) {
                        // Exponential backoff: 5s, 10s, 20s, 40s, max 60s
                        const attempt = (session.reconnectAttempt || 0) + 1;
                        const delayMs = Math.min(5000 * Math.pow(2, attempt - 1), 60000);
                        console.log(`[Session ${sessionId}] Connection closed (code: ${statusCode}), reconnecting in ${delayMs / 1000}s (attempt ${attempt})...`);
                        // Update attempt counter
                        db_1.db.prepare("UPDATE sessions SET reconnect_attempt = ? WHERE id = ?").run(attempt, sessionId);
                        setTimeout(() => {
                            this.startSession(userId, sessionId).catch(console.error);
                        }, delayMs);
                    }
                }
                webhook_service_1.WebhookService.sendWebhook(userId, sessionId, 'session.status', { status: 'DISCONNECTED', statusCode });
            }
            else if (connection === 'open') {
                const phone = sock.user?.id ? sock.user.id.split(':')[0].split('@')[0] : '';
                const pushName = sock.user?.name || '';
                const meLid = sock.user?.lid ? sock.user.lid.split(':')[0].split('@')[0] : '';
                db_1.db.prepare(`
          UPDATE sessions 
          SET status = 'CONNECTED', qr_code = NULL, phone_number = ?, push_name = ?, updated_at = CURRENT_TIMESTAMP 
          WHERE id = ?
        `).run(phone, pushName, sessionId);
                // Map self LID to user's phone number & name
                if (meLid) {
                    try {
                        db_1.db.prepare(`
              INSERT INTO contacts (id, user_id, session_id, jid, name, phone_number, updated_at)
              VALUES (?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
              ON CONFLICT(session_id, jid) DO UPDATE SET
                name = excluded.name,
                phone_number = excluded.phone_number,
                updated_at = CURRENT_TIMESTAMP
            `).run(`${sessionId}_${meLid}@lid`, userId, sessionId, `${meLid}@lid`, `You (${session.session_name || 'My Number'})`, phone);
                    }
                    catch { }
                }
                this.emitToUser(userId, 'session_status', { sessionId, status: 'CONNECTED', phone, pushName });
                console.log(`✅ [Session ${session.session_name}] WhatsApp Connected: +${phone} (${pushName})`);
                // Reset reconnect attempt on successful connection
                db_1.db.prepare("UPDATE sessions SET reconnect_attempt = 0 WHERE id = ?").run(sessionId);
                webhook_service_1.WebhookService.sendWebhook(userId, sessionId, 'session.status', { status: 'CONNECTED', phone, pushName });
            }
        });
        // History and Contacts sync listener
        sock.ev.on('messaging-history.set', ({ contacts }) => {
            if (contacts && Array.isArray(contacts)) {
                for (const c of contacts) {
                    if (!c.id)
                        continue;
                    const name = c.name || c.notify || c.verifiedName || '';
                    const phone = c.id.includes('@s.whatsapp.net') ? c.id.split('@')[0] : (c.phoneNumber || '');
                    const contactId = `${sessionId}_${c.id}`;
                    try {
                        db_1.db.prepare(`
              INSERT INTO contacts (id, user_id, session_id, jid, name, phone_number, updated_at)
              VALUES (?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
              ON CONFLICT(session_id, jid) DO UPDATE SET
                name = COALESCE(NULLIF(excluded.name, ''), contacts.name),
                phone_number = COALESCE(NULLIF(excluded.phone_number, ''), contacts.phone_number),
                updated_at = CURRENT_TIMESTAMP
            `).run(contactId, userId, sessionId, c.id, name, phone);
                    }
                    catch { }
                }
            }
        });
        // Contacts sync listener
        sock.ev.on('contacts.upsert', (newContacts) => {
            for (const c of newContacts) {
                if (!c.id)
                    continue;
                const name = c.name || c.notify || c.verifiedName || '';
                const phone = c.id.includes('@s.whatsapp.net') ? c.id.split('@')[0] : '';
                const contactId = `${sessionId}_${c.id}`;
                try {
                    db_1.db.prepare(`
            INSERT INTO contacts (id, user_id, session_id, jid, name, phone_number, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
            ON CONFLICT(session_id, jid) DO UPDATE SET
              name = COALESCE(NULLIF(excluded.name, ''), contacts.name),
              phone_number = COALESCE(NULLIF(excluded.phone_number, ''), contacts.phone_number),
              updated_at = CURRENT_TIMESTAMP
          `).run(contactId, userId, sessionId, c.id, name, phone);
                }
                catch { }
            }
        });
        sock.ev.on('contacts.update', (updatedContacts) => {
            for (const c of updatedContacts) {
                if (!c.id)
                    continue;
                const name = c.name || c.notify || c.verifiedName || '';
                const contactId = `${sessionId}_${c.id}`;
                try {
                    db_1.db.prepare(`
            INSERT INTO contacts (id, user_id, session_id, jid, name, phone_number, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
            ON CONFLICT(session_id, jid) DO UPDATE SET
              name = COALESCE(NULLIF(excluded.name, ''), contacts.name),
              updated_at = CURRENT_TIMESTAMP
          `).run(contactId, userId, sessionId, c.id, name, c.id.includes('@s.whatsapp.net') ? c.id.split('@')[0] : '');
                }
                catch { }
            }
        });
        // Inbound Messages Listener
        sock.ev.on('messages.upsert', async ({ messages, type }) => {
            if (type !== 'notify')
                return;
            for (const msg of messages) {
                if (!msg.message)
                    continue;
                const remoteJid = msg.key.remoteJid || '';
                const fromMe = msg.key.fromMe ? 1 : 0;
                const messageId = msg.key.id || '';
                const timestamp = typeof msg.messageTimestamp === 'number' ? msg.messageTimestamp : Number(msg.messageTimestamp || Date.now() / 1000);
                const pushName = msg.pushName || '';
                let body = '';
                let mediaType = 'text';
                let mediaCaption = '';
                let mediaUrl = null;
                if (msg.message.conversation) {
                    body = msg.message.conversation;
                }
                else if (msg.message.extendedTextMessage?.text) {
                    body = msg.message.extendedTextMessage.text;
                }
                else if (msg.message.imageMessage) {
                    mediaType = 'image';
                    mediaCaption = msg.message.imageMessage.caption || '';
                    body = mediaCaption || '[Image]';
                }
                else if (msg.message.videoMessage) {
                    mediaType = 'video';
                    mediaCaption = msg.message.videoMessage.caption || '';
                    body = mediaCaption || '[Video]';
                }
                else if (msg.message.audioMessage) {
                    mediaType = 'audio';
                    body = '[Audio Voice Message]';
                }
                else if (msg.message.documentMessage) {
                    mediaType = 'document';
                    mediaCaption = msg.message.documentMessage.fileName || 'document.pdf';
                    body = mediaCaption;
                }
                else if (msg.message.stickerMessage) {
                    mediaType = 'sticker';
                    body = '[Sticker]';
                }
                const msgRecordId = (0, uuid_1.v4)();
                // Download incoming media if present
                if (mediaType !== 'text') {
                    try {
                        const buffer = await (0, baileys_1.downloadMediaMessage)(msg, 'buffer', {}, {
                            logger,
                            reuploadRequest: sock.updateMediaMessage,
                        });
                        if (buffer) {
                            let ext = 'bin';
                            if (mediaType === 'image')
                                ext = 'jpg';
                            else if (mediaType === 'video')
                                ext = 'mp4';
                            else if (mediaType === 'audio')
                                ext = 'ogg';
                            else if (mediaType === 'sticker')
                                ext = 'webp';
                            else if (mediaType === 'document') {
                                const fn = msg.message.documentMessage?.fileName;
                                ext = fn ? path_1.default.extname(fn).replace('.', '') || 'pdf' : 'pdf';
                            }
                            const fileName = `${msgRecordId}.${ext}`;
                            const filePath = path_1.default.join(config_1.config.mediaDir, fileName);
                            fs_1.default.writeFileSync(filePath, buffer);
                            mediaUrl = `/media/${fileName}`;
                        }
                    }
                    catch (downloadErr) {
                        console.error('Failed to download incoming media message:', downloadErr);
                    }
                }
                db_1.db.prepare(`
          INSERT INTO messages (id, user_id, session_id, remote_jid, from_me, push_name, message_id, body, media_type, media_url, media_caption, status, timestamp)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'DELIVERED', ?)
        `).run(msgRecordId, userId, sessionId, remoteJid, fromMe, pushName, messageId, body, mediaType, mediaUrl, mediaCaption, timestamp);
                // Update contacts cache
                if (remoteJid) {
                    const contactId = `${sessionId}_${remoteJid}`;
                    const phone = remoteJid.includes('@s.whatsapp.net') ? remoteJid.split('@')[0] : '';
                    try {
                        db_1.db.prepare(`
              INSERT INTO contacts (id, user_id, session_id, jid, name, phone_number, updated_at)
              VALUES (?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
              ON CONFLICT(session_id, jid) DO UPDATE SET 
                name = COALESCE(NULLIF(excluded.name, ''), contacts.name),
                phone_number = COALESCE(NULLIF(excluded.phone_number, ''), contacts.phone_number),
                updated_at = CURRENT_TIMESTAMP
            `).run(contactId, userId, sessionId, remoteJid, pushName, phone);
                    }
                    catch { }
                }
                const payload = {
                    id: msgRecordId,
                    messageId,
                    sessionId,
                    remoteJid,
                    fromMe: Boolean(fromMe),
                    pushName,
                    body,
                    mediaType,
                    media_type: mediaType,
                    mediaUrl,
                    media_url: mediaUrl,
                    mediaCaption,
                    media_caption: mediaCaption,
                    timestamp,
                };
                this.emitToUser(userId, 'new_message', payload);
                webhook_service_1.WebhookService.sendWebhook(userId, sessionId, 'message.received', payload);
            }
        });
        return { message: 'Session started', status: 'STARTING' };
    }
    static async requestPairingCode(userId, sessionId, phoneNumber) {
        const sock = this.sockets.get(sessionId);
        if (!sock) {
            await this.startSession(userId, sessionId);
        }
        const activeSock = this.sockets.get(sessionId);
        if (!activeSock) {
            throw new Error('Could not initialize socket for pairing code');
        }
        const cleanNumber = phoneNumber.replace(/\D/g, '');
        const code = await activeSock.requestPairingCode(cleanNumber);
        db_1.db.prepare('UPDATE sessions SET pairing_code = ? WHERE id = ?').run(code, sessionId);
        this.emitToUser(userId, 'session_pairing_code', { sessionId, pairingCode: code });
        return { pairingCode: code };
    }
    static async stopSession(userId, sessionId) {
        const sock = this.sockets.get(sessionId);
        if (sock) {
            await sock.logout().catch(() => sock.end(undefined));
            this.sockets.delete(sessionId);
        }
        db_1.db.prepare("UPDATE sessions SET status = 'STOPPED', qr_code = NULL, updated_at = CURRENT_TIMESTAMP WHERE id = ? AND user_id = ?").run(sessionId, userId);
        this.emitToUser(userId, 'session_status', { sessionId, status: 'STOPPED' });
        return { message: 'Session stopped' };
    }
    static async deleteSession(userId, sessionId) {
        await this.stopSession(userId, sessionId).catch(() => { });
        // Remove session files
        const sessionDir = path_1.default.join(config_1.config.sessionsDir, sessionId);
        try {
            fs_1.default.rmSync(sessionDir, { recursive: true, force: true });
        }
        catch { }
        db_1.db.prepare('DELETE FROM sessions WHERE id = ? AND user_id = ?').run(sessionId, userId);
        return { message: 'Session deleted successfully' };
    }
    static formatJid(to) {
        if (!to)
            return '';
        const trimmed = to.trim();
        if (trimmed.includes('@')) {
            return trimmed;
        }
        const clean = trimmed.replace(/\D/g, '');
        return `${clean}@s.whatsapp.net`;
    }
    static async getProfilePicture(sessionId, jid) {
        const base = jid.includes('@') ? jid.split('@')[0] : jid;
        // Check DB contact cache first
        try {
            const row = db_1.db.prepare('SELECT avatar_url FROM contacts WHERE session_id = ? AND (jid = ? OR jid LIKE ? OR phone_number = ?) AND avatar_url IS NOT NULL').get(sessionId, jid, `${base}@%`, base);
            if (row?.avatar_url) {
                return row.avatar_url;
            }
        }
        catch { }
        const sock = this.sockets.get(sessionId);
        if (!sock)
            return null;
        const candidates = [jid];
        if (jid.includes('@lid')) {
            candidates.push(`${base}@s.whatsapp.net`);
        }
        else if (jid.includes('@s.whatsapp.net')) {
            candidates.push(`${base}@lid`);
        }
        else {
            candidates.push(`${base}@s.whatsapp.net`);
            candidates.push(`${base}@lid`);
        }
        // If phone number is stored in contacts for this base ID, add it as candidate too
        try {
            const cRow = db_1.db.prepare('SELECT phone_number FROM contacts WHERE session_id = ? AND (jid = ? OR jid LIKE ?) AND phone_number IS NOT NULL AND phone_number != ""').get(sessionId, jid, `${base}@%`);
            if (cRow?.phone_number) {
                const cleanPhone = cRow.phone_number.replace(/\D/g, '');
                if (cleanPhone && cleanPhone !== base) {
                    candidates.push(`${cleanPhone}@s.whatsapp.net`);
                }
            }
        }
        catch { }
        for (const cand of candidates) {
            try {
                const url = await sock.profilePictureUrl(cand, 'image');
                if (url) {
                    try {
                        db_1.db.prepare('UPDATE contacts SET avatar_url = ?, updated_at = CURRENT_TIMESTAMP WHERE session_id = ? AND (jid = ? OR jid LIKE ?)').run(url, sessionId, jid, `${base}@%`);
                    }
                    catch { }
                    return url;
                }
            }
            catch {
                try {
                    const urlPreview = await sock.profilePictureUrl(cand, 'preview');
                    if (urlPreview) {
                        try {
                            db_1.db.prepare('UPDATE contacts SET avatar_url = ?, updated_at = CURRENT_TIMESTAMP WHERE session_id = ? AND (jid = ? OR jid LIKE ?)').run(urlPreview, sessionId, jid, `${base}@%`);
                        }
                        catch { }
                        return urlPreview;
                    }
                }
                catch { }
            }
        }
        return null;
    }
    static async sendTextMessage(userId, sessionId, to, text) {
        const sock = this.sockets.get(sessionId);
        if (!sock) {
            throw new Error('WhatsApp session is not connected or active');
        }
        const jid = this.formatJid(to);
        const sent = await sock.sendMessage(jid, { text });
        const msgId = (0, uuid_1.v4)();
        const timestamp = Math.floor(Date.now() / 1000);
        db_1.db.prepare(`
      INSERT INTO messages (id, user_id, session_id, remote_jid, from_me, push_name, message_id, body, media_type, status, timestamp)
      VALUES (?, ?, ?, ?, 1, 'You', ?, ?, 'text', 'SENT', ?)
    `).run(msgId, userId, sessionId, jid, sent?.key?.id || '', text, timestamp);
        const result = {
            id: msgId,
            messageId: sent?.key?.id,
            sessionId,
            remoteJid: jid,
            remote_jid: jid,
            fromMe: true,
            from_me: 1,
            body: text,
            text,
            mediaType: 'text',
            media_type: 'text',
            status: 'SENT',
            timestamp,
        };
        this.emitToUser(userId, 'message_sent', result);
        webhook_service_1.WebhookService.sendWebhook(userId, sessionId, 'message.sent', result);
        return result;
    }
    static async sendMediaMessage(userId, sessionId, to, mediaUrlOrBuffer, mediaType, caption, fileName) {
        const sock = this.sockets.get(sessionId);
        if (!sock) {
            throw new Error('WhatsApp session is not connected or active');
        }
        const jid = this.formatJid(to);
        let messageContent = {};
        let savedMediaUrl = '';
        const msgId = (0, uuid_1.v4)();
        // If buffer passed, persist to media directory
        if (Buffer.isBuffer(mediaUrlOrBuffer)) {
            let ext = 'bin';
            if (mediaType === 'image')
                ext = 'jpg';
            else if (mediaType === 'video')
                ext = 'mp4';
            else if (mediaType === 'audio')
                ext = 'ogg';
            else if (mediaType === 'sticker')
                ext = 'webp';
            else if (mediaType === 'document')
                ext = fileName ? path_1.default.extname(fileName).replace('.', '') || 'pdf' : 'pdf';
            const fname = `${msgId}.${ext}`;
            const fpath = path_1.default.join(config_1.config.mediaDir, fname);
            fs_1.default.writeFileSync(fpath, mediaUrlOrBuffer);
            savedMediaUrl = `/media/${fname}`;
        }
        else if (typeof mediaUrlOrBuffer === 'string') {
            savedMediaUrl = mediaUrlOrBuffer;
        }
        const mediaObj = typeof mediaUrlOrBuffer === 'string' ? { url: mediaUrlOrBuffer } : mediaUrlOrBuffer;
        if (mediaType === 'image') {
            messageContent = { image: mediaObj, caption: caption || '' };
        }
        else if (mediaType === 'video') {
            messageContent = { video: mediaObj, caption: caption || '' };
        }
        else if (mediaType === 'audio') {
            messageContent = { audio: mediaObj, mimetype: 'audio/mp4', ptt: true };
        }
        else if (mediaType === 'document') {
            messageContent = { document: mediaObj, mimetype: 'application/octet-stream', fileName: fileName || 'document.pdf', caption: caption || '' };
        }
        else if (mediaType === 'sticker') {
            messageContent = { sticker: mediaObj };
        }
        const sent = await sock.sendMessage(jid, messageContent);
        const timestamp = Math.floor(Date.now() / 1000);
        const bodyText = caption || (mediaType === 'document' ? fileName || '[Document]' : `[${mediaType.charAt(0).toUpperCase() + mediaType.slice(1)}]`);
        db_1.db.prepare(`
      INSERT INTO messages (id, user_id, session_id, remote_jid, from_me, push_name, message_id, body, media_type, media_url, media_caption, status, timestamp)
      VALUES (?, ?, ?, ?, 1, 'You', ?, ?, ?, ?, ?, 'SENT', ?)
    `).run(msgId, userId, sessionId, jid, sent?.key?.id || '', bodyText, mediaType, savedMediaUrl || null, caption || '', timestamp);
        const result = {
            id: msgId,
            messageId: sent?.key?.id,
            sessionId,
            remoteJid: jid,
            remote_jid: jid,
            fromMe: true,
            from_me: 1,
            mediaType,
            media_type: mediaType,
            mediaUrl: savedMediaUrl,
            media_url: savedMediaUrl,
            mediaCaption: caption,
            media_caption: caption,
            body: bodyText,
            caption,
            status: 'SENT',
            timestamp,
        };
        this.emitToUser(userId, 'message_sent', result);
        webhook_service_1.WebhookService.sendWebhook(userId, sessionId, 'message.sent', result);
        return result;
    }
    static async autoStartSavedSessions() {
        const sessions = db_1.db.prepare("SELECT * FROM sessions WHERE status = 'CONNECTED' AND is_auto_reconnect = 1").all();
        console.log(`🔄 Auto-starting ${sessions.length} saved WhatsApp sessions...`);
        for (const session of sessions) {
            try {
                await this.startSession(session.user_id, session.id);
            }
            catch (err) {
                console.error(`Failed to autostart session ${session.session_name}:`, err.message);
            }
        }
    }
    static getSessionsByUser(userId) {
        return db_1.db.prepare('SELECT * FROM sessions WHERE user_id = ? ORDER BY created_at DESC').all(userId);
    }
    static getSessionById(sessionId) {
        return db_1.db.prepare('SELECT * FROM sessions WHERE id = ?').get(sessionId);
    }
    static emitToUser(userId, event, data) {
        if (this.io) {
            this.io.to(`user_${userId}`).emit(event, data);
        }
    }
}
exports.WhatsAppService = WhatsAppService;
