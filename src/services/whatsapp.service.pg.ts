import makeWASocket, {
  DisconnectReason,
  useMultiFileAuthState,
  fetchLatestBaileysVersion,
  makeCacheableSignalKeyStore,
  WASocket,
  proto,
  downloadMediaMessage,
  AuthenticationState,
  AuthenticationCreds,
  SignalDataTypeMap,
} from '@whiskeysockets/baileys';
import pino from 'pino';
import path from 'path';
import fs from 'fs';
import QRCode from 'qrcode';
import { v4 as uuidv4 } from 'uuid';
import { pgDb, redisAuthStore, initDatabase, closeDatabase } from '../database/db.pg';
import { config } from '../config';
import { WebhookService } from './webhook.service';

const logger: any = pino({ level: 'silent' });

// Redis-based auth state for Baileys (replaces file-based)
async function useRedisAuthState(sessionId: string): Promise<{ state: AuthenticationState; saveCreds: () => Promise<void> }> {
  const credsKey = `baileys:creds:${sessionId}`;
  const keysPrefix = `baileys:keys:${sessionId}:`;

  // Load creds from Redis
  let creds: AuthenticationCreds | null = await redisAuthStore.get(credsKey);
  
  if (!creds) {
    // Initialize new creds
    const { initAuthCreds } = await import('@whiskeysockets/baileys');
    creds = initAuthCreds();
  }

  // Load keys from Redis
  const keys: Map<string, { data: any; type: keyof SignalDataTypeMap }> = new Map();
  const keysData = await redisAuthStore.keys(`${keysPrefix}*`);
  for (const key of keysData) {
    const type = key.replace(keysPrefix, '') as keyof SignalDataTypeMap;
    const data = await redisAuthStore.get(key);
    if (data) keys.set(type, { data, type });
  }

  const saveCreds = async () => {
    await redisAuthStore.set(credsKey, creds);
    // Save keys
    for (const [type, { data }] of keys.entries()) {
      await redisAuthStore.set(`${keysPrefix}${type}`, data);
    }
  };

  return {
    state: {
      creds,
      keys: {
        get: async (type: keyof SignalDataTypeMap, ids: string[]) => {
          const results: { [id: string]: any } = {};
          for (const id of ids) {
            const key = `${keysPrefix}${type}:${id}`;
            const data = await redisAuthStore.get(key);
            if (data) results[id] = data;
          }
          return results;
        },
        set: async (data: Record<string, any>) => {
          for (const [id, value] of Object.entries(data)) {
            await redisAuthStore.set(`${keysPrefix}${Object.keys(data)[0]}:${id}`, value);
          }
        },
      },
    },
    saveCreds,
  };
}

export class WhatsAppService {
  private static sockets: Map<string, WASocket> = new Map();
  private static io: any = null;

  static setSocketIO(ioInstance: any) {
    this.io = ioInstance;
  }

  static getSessionPath(sessionId: string): string {
    // Not used with Redis, but kept for compatibility
    const sessionDir = path.join(config.sessionsDir, sessionId);
    if (!fs.existsSync(sessionDir)) {
      fs.mkdirSync(sessionDir, { recursive: true });
    }
    return sessionDir;
  }

  static async createSession(userId: string, sessionName: string, webhookUrl?: string) {
    // Check plan quota
    const user: any = await pgDb.prepare('SELECT max_sessions FROM users WHERE id = ?').get(userId);
    const count: any = await pgDb.prepare('SELECT COUNT(*) as count FROM sessions WHERE user_id = ?').get(userId);

    if (count.count >= user.max_sessions) {
      throw new Error(`Session limit reached (${count.count}/${user.max_sessions}). Upgrade your plan to add more sessions.`);
    }

    const sessionId = uuidv4();
    await pgDb.exec(`
      INSERT INTO sessions (id, user_id, session_name, status, webhook_url)
      VALUES (?, ?, ?, 'STOPPED', ?)
    `, [sessionId, userId, sessionName, webhookUrl || null]);

    return this.getSessionById(sessionId);
  }

  static async startSession(userId: string, sessionId: string) {
    const session: any = await pgDb.prepare('SELECT * FROM sessions WHERE id = ? AND user_id = ?').get(sessionId, userId);
    if (!session) {
      throw new Error('Session not found');
    }

    if (this.sockets.has(sessionId)) {
      return { message: 'Session is already running', status: session.status };
    }

    const sessionDir = this.getSessionPath(sessionId);
    const { state, saveCreds } = await useRedisAuthState(sessionId);
    const { version, isLatest } = await fetchLatestBaileysVersion();

    await pgDb.exec("UPDATE sessions SET status = 'STARTING', qr_code = NULL, updated_at = CURRENT_TIMESTAMP WHERE id = ?", [sessionId]);
    this.emitToUser(userId, 'session_status', { sessionId, status: 'STARTING' });

    const sock = makeWASocket({
      version,
      logger,
      printQRInTerminal: false,
      auth: {
        creds: state.creds,
        keys: makeCacheableSignalKeyStore(state.keys, logger),
      },
      browser: ['WhatsApp SaaS Gateway', 'Chrome', '124.0.0'],
      generateHighQualityLinkPreview: true,
      syncFullHistory: true,
    });

    this.sockets.set(sessionId, sock);

    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('connection.update', async (update) => {
      const { connection, lastDisconnect, qr } = update;

      if (qr) {
        try {
          const qrDataUrl = await QRCode.toDataURL(qr, { width: 300, margin: 2 });
          await pgDb.exec("UPDATE sessions SET status = 'SCAN_QR', qr_code = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?", [qrDataUrl, sessionId]);
          this.emitToUser(userId, 'session_qr', { sessionId, qr: qrDataUrl });
        } catch (e) {
          console.error('Error generating QR Code data URL:', e);
        }
      }

      if (connection === 'close') {
        const statusCode = (lastDisconnect?.error as any)?.output?.statusCode;
        const shouldReconnect = statusCode !== DisconnectReason.loggedOut;

        this.sockets.delete(sessionId);

        if (statusCode === DisconnectReason.loggedOut) {
          await pgDb.exec("UPDATE sessions SET status = 'LOGGED_OUT', qr_code = NULL, updated_at = CURRENT_TIMESTAMP WHERE id = ?", [sessionId]);
          this.emitToUser(userId, 'session_status', { sessionId, status: 'LOGGED_OUT' });
          // Clean up Redis keys
          await this.cleanupRedisKeys(sessionId);
        } else {
          await pgDb.exec("UPDATE sessions SET status = 'DISCONNECTED', qr_code = NULL, updated_at = CURRENT_TIMESTAMP WHERE id = ?", [sessionId]);
          this.emitToUser(userId, 'session_status', { sessionId, status: 'DISCONNECTED' });

          if (shouldReconnect && session.is_auto_reconnect) {
            console.log(`[Session ${sessionId}] Connection closed, reconnecting in 5s...`);
            setTimeout(() => {
              this.startSession(userId, sessionId).catch(console.error);
            }, 5000);
          }
        }

        WebhookService.sendWebhook(userId, sessionId, 'session.status', { status: 'DISCONNECTED', statusCode });
      } else if (connection === 'open') {
        const phone = sock.user?.id ? sock.user.id.split(':')[0].split('@')[0] : '';
        const pushName = sock.user?.name || '';
        const meLid = (sock.user as any)?.lid ? (sock.user as any).lid.split(':')[0].split('@')[0] : '';

        await pgDb.exec(`
          UPDATE sessions 
          SET status = 'CONNECTED', qr_code = NULL, phone_number = ?, push_name = ?, updated_at = CURRENT_TIMESTAMP 
          WHERE id = ?
        `, [phone, pushName, sessionId]);

        if (meLid) {
          try {
            await pgDb.exec(`
              INSERT INTO contacts (id, user_id, session_id, jid, name, phone_number, updated_at)
              VALUES (?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
              ON CONFLICT(session_id, jid) DO UPDATE SET
                name = excluded.name,
                phone_number = excluded.phone_number,
                updated_at = CURRENT_TIMESTAMP
            `, [`${sessionId}_${meLid}@lid`, userId, sessionId, `${meLid}@lid`, `You (${session.session_name || 'My Number'})`, phone]);
          } catch {}
        }

        this.emitToUser(userId, 'session_status', { sessionId, status: 'CONNECTED', phone, pushName });
        console.log(`✅ [Session ${session.session_name}] WhatsApp Connected: +${phone} (${pushName})`);

        WebhookService.sendWebhook(userId, sessionId, 'session.status', { status: 'CONNECTED', phone, pushName });
      }
    });

    // ... rest of event handlers (same as before, but using pgDb)
    sock.ev.on('messaging-history.set', async ({ contacts }: any) => {
      if (contacts && Array.isArray(contacts)) {
        for (const c of contacts) {
          if (!c.id) continue;
          const name = c.name || c.notify || c.verifiedName || '';
          const phone = c.id.includes('@s.whatsapp.net') ? c.id.split('@')[0] : (c.phoneNumber || '');
          const contactId = `${sessionId}_${c.id}`;
          try {
            await pgDb.exec(`
              INSERT INTO contacts (id, user_id, session_id, jid, name, phone_number, updated_at)
              VALUES (?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
              ON CONFLICT(session_id, jid) DO UPDATE SET
                name = COALESCE(NULLIF(excluded.name, ''), contacts.name),
                phone_number = COALESCE(NULLIF(excluded.phone_number, ''), contacts.phone_number),
                updated_at = CURRENT_TIMESTAMP
            `, [contactId, userId, sessionId, c.id, name, phone]);
          } catch {}
        }
      }
    });

    sock.ev.on('contacts.upsert', async (newContacts: any[]) => {
      for (const c of newContacts) {
        if (!c.id) continue;
        const name = c.name || c.notify || c.verifiedName || '';
        const phone = c.id.includes('@s.whatsapp.net') ? c.id.split('@')[0] : '';
        const contactId = `${sessionId}_${c.id}`;
        try {
          await pgDb.exec(`
            INSERT INTO contacts (id, user_id, session_id, jid, name, phone_number, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
            ON CONFLICT(session_id, jid) DO UPDATE SET
              name = COALESCE(NULLIF(excluded.name, ''), contacts.name),
              phone_number = COALESCE(NULLIF(excluded.phone_number, ''), contacts.phone_number),
              updated_at = CURRENT_TIMESTAMP
          `, [contactId, userId, sessionId, c.id, name, phone]);
        } catch {}
      }
    });

    // Inbound Messages
    sock.ev.on('messages.upsert', async ({ messages, type }) => {
      if (type !== 'notify') return;

      for (const msg of messages) {
        if (!msg.message) continue;

        const remoteJid = msg.key.remoteJid || '';
        const fromMe = msg.key.fromMe ? 1 : 0;
        const messageId = msg.key.id || '';
        const timestamp = typeof msg.messageTimestamp === 'number' ? msg.messageTimestamp : Number(msg.messageTimestamp || Date.now() / 1000);
        const pushName = msg.pushName || '';

        let body = '';
        let mediaType = 'text';
        let mediaCaption = '';
        let mediaUrl: string | null = null;

        if (msg.message.conversation) {
          body = msg.message.conversation;
        } else if (msg.message.extendedTextMessage?.text) {
          body = msg.message.extendedTextMessage.text;
        } else if (msg.message.imageMessage) {
          mediaType = 'image';
          mediaCaption = msg.message.imageMessage.caption || '';
          body = mediaCaption || '[Image]';
        } else if (msg.message.videoMessage) {
          mediaType = 'video';
          mediaCaption = msg.message.videoMessage.caption || '';
          body = mediaCaption || '[Video]';
        } else if (msg.message.audioMessage) {
          mediaType = 'audio';
          body = '[Audio Voice Message]';
        } else if (msg.message.documentMessage) {
          mediaType = 'document';
          mediaCaption = msg.message.documentMessage.fileName || 'document.pdf';
          body = mediaCaption;
        } else if (msg.message.stickerMessage) {
          mediaType = 'sticker';
          body = '[Sticker]';
        }

        const msgRecordId = uuidv4();

        // Download incoming media if present
        if (mediaType !== 'text') {
          try {
            const buffer = await downloadMediaMessage(
              msg,
              'buffer',
              {},
              {
                logger,
                reuploadRequest: sock.updateMediaMessage,
              }
            );

            if (buffer) {
              let ext = 'bin';
              if (mediaType === 'image') ext = 'jpg';
              else if (mediaType === 'video') ext = 'mp4';
              else if (mediaType === 'audio') ext = 'ogg';
              else if (mediaType === 'sticker') ext = 'webp';
              else if (mediaType === 'document') {
                const fn = msg.message.documentMessage?.fileName;
                ext = fn ? path.extname(fn).replace('.', '') || 'pdf' : 'pdf';
              }

              const fileName = `${msgRecordId}.${ext}`;
              const filePath = path.join(config.mediaDir, fileName);
              fs.writeFileSync(filePath, buffer);
              mediaUrl = `/media/${fileName}`;
            }
          } catch (downloadErr) {
            console.error('Failed to download incoming media message:', downloadErr);
          }
        }

        await pgDb.exec(`
          INSERT INTO messages (id, user_id, session_id, remote_jid, from_me, push_name, message_id, body, media_type, media_url, media_caption, status, timestamp)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'DELIVERED', ?)
        `, [msgRecordId, userId, sessionId, remoteJid, fromMe, pushName, messageId, body, mediaType, mediaUrl, mediaCaption, timestamp]);

        // Update contacts cache
        if (remoteJid) {
          const contactId = `${sessionId}_${remoteJid}`;
          const phone = remoteJid.includes('@s.whatsapp.net') ? remoteJid.split('@')[0] : '';
          try {
            await pgDb.exec(`
              INSERT INTO contacts (id, user_id, session_id, jid, name, phone_number, updated_at)
              VALUES (?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
              ON CONFLICT(session_id, jid) DO UPDATE SET 
                name = COALESCE(NULLIF(excluded.name, ''), contacts.name),
                phone_number = COALESCE(NULLIF(excluded.phone_number, ''), contacts.phone_number),
                updated_at = CURRENT_TIMESTAMP
            `, [contactId, userId, sessionId, remoteJid, pushName, phone]);
          } catch {}
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
        WebhookService.sendWebhook(userId, sessionId, 'message.received', payload);
      }
    });

    return { message: 'Session started', status: 'STARTING' };
  }

  static async requestPairingCode(userId: string, sessionId: string, phoneNumber: string) {
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

    await pgDb.exec('UPDATE sessions SET pairing_code = ? WHERE id = ?', [code, sessionId]);
    this.emitToUser(userId, 'session_pairing_code', { sessionId, pairingCode: code });

    return { pairingCode: code };
  }

  static async stopSession(userId: string, sessionId: string) {
    const sock = this.sockets.get(sessionId);
    if (sock) {
      await sock.logout().catch(() => sock.end(undefined));
      this.sockets.delete(sessionId);
    }

    await pgDb.exec("UPDATE sessions SET status = 'STOPPED', qr_code = NULL, updated_at = CURRENT_TIMESTAMP WHERE id = ? AND user_id = ?", [sessionId, userId]);
    this.emitToUser(userId, 'session_status', { sessionId, status: 'STOPPED' });
    await this.cleanupRedisKeys(sessionId);

    return { message: 'Session stopped' };
  }

  static async deleteSession(userId: string, sessionId: string) {
    await this.stopSession(userId, sessionId).catch(() => {});
    await pgDb.exec('DELETE FROM sessions WHERE id = ? AND user_id = ?', [sessionId, userId]);
    await this.cleanupRedisKeys(sessionId);
    return { message: 'Session deleted successfully' };
  }

  static async cleanupRedisKeys(sessionId: string) {
    try {
      const credsKey = `baileys:creds:${sessionId}`;
      await redisAuthStore.del(credsKey);
      const keys = await redisAuthStore.keys(`baileys:keys:${sessionId}:*`);
      for (const key of keys) {
        await redisAuthStore.del(key);
      }
    } catch (e) {
      console.error('Error cleaning up Redis keys:', e);
    }
  }

  static formatJid(to: string): string {
    if (!to) return '';
    const trimmed = to.trim();
    if (trimmed.includes('@')) {
      return trimmed;
    }
    const clean = trimmed.replace(/\D/g, '');
    return `${clean}@s.whatsapp.net`;
  }

  static async getProfilePicture(sessionId: string, jid: string): Promise<string | null> {
    const base = jid.includes('@') ? jid.split('@')[0] : jid;

    try {
      const row: any = await pgDb.prepare('SELECT avatar_url FROM contacts WHERE session_id = ? AND (jid = ? OR jid LIKE ? OR phone_number = ?) AND avatar_url IS NOT NULL').get(sessionId, jid, `${base}@%`, base);
      if (row?.avatar_url) {
        return row.avatar_url;
      }
    } catch {}

    const sock = this.sockets.get(sessionId);
    if (!sock) return null;

    const candidates: string[] = [jid];
    if (jid.includes('@lid')) {
      candidates.push(`${base}@s.whatsapp.net`);
    } else if (jid.includes('@s.whatsapp.net')) {
      candidates.push(`${base}@lid`);
    } else {
      candidates.push(`${base}@s.whatsapp.net`);
      candidates.push(`${base}@lid`);
    }

    try {
      const cRow: any = await pgDb.prepare('SELECT phone_number FROM contacts WHERE session_id = ? AND (jid = ? OR jid LIKE ?) AND phone_number IS NOT NULL AND phone_number != ""').get(sessionId, jid, `${base}@%`);
      if (cRow?.phone_number) {
        const cleanPhone = cRow.phone_number.replace(/\D/g, '');
        if (cleanPhone && cleanPhone !== base) {
          candidates.push(`${cleanPhone}@s.whatsapp.net`);
        }
      }
    } catch {}

    for (const cand of candidates) {
      try {
        const url = await sock.profilePictureUrl(cand, 'image');
        if (url) {
          try {
            await pgDb.exec('UPDATE contacts SET avatar_url = ?, updated_at = CURRENT_TIMESTAMP WHERE session_id = ? AND (jid = ? OR jid LIKE ?)', [url, sessionId, jid, `${base}@%`]);
          } catch {}
          return url;
        }
      } catch {
        try {
          const urlPreview = await sock.profilePictureUrl(cand, 'preview');
          if (urlPreview) {
            try {
              await pgDb.exec('UPDATE contacts SET avatar_url = ?, updated_at = CURRENT_TIMESTAMP WHERE session_id = ? AND (jid = ? OR jid LIKE ?)', [urlPreview, sessionId, jid, `${base}@%`]);
            } catch {}
            return urlPreview;
          }
        } catch {}
      }
    }
    return null;
  }

  static async sendTextMessage(userId: string, sessionId: string, to: string, text: string) {
    const sock = this.sockets.get(sessionId);
    if (!sock) {
      throw new Error('WhatsApp session is not connected or active');
    }

    const jid = this.formatJid(to);
    const sent = await sock.sendMessage(jid, { text });

    const msgId = uuidv4();
    const timestamp = Math.floor(Date.now() / 1000);

    await pgDb.exec(`
      INSERT INTO messages (id, user_id, session_id, remote_jid, from_me, push_name, message_id, body, media_type, status, timestamp)
      VALUES (?, ?, ?, ?, 1, 'You', ?, ?, 'text', 'SENT', ?)
    `, [msgId, userId, sessionId, jid, sent?.key?.id || '', text, timestamp]);

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
    WebhookService.sendWebhook(userId, sessionId, 'message.sent', result);

    return result;
  }

  static async sendMediaMessage(
    userId: string,
    sessionId: string,
    to: string,
    mediaUrlOrBuffer: string | Buffer,
    mediaType: 'image' | 'video' | 'audio' | 'document' | 'sticker',
    caption?: string,
    fileName?: string
  ) {
    const sock = this.sockets.get(sessionId);
    if (!sock) {
      throw new Error('WhatsApp session is not connected or active');
    }

    const jid = this.formatJid(to);
    let messageContent: any = {};
    let savedMediaUrl = '';

    const msgId = uuidv4();

    if (Buffer.isBuffer(mediaUrlOrBuffer)) {
      let ext = 'bin';
      if (mediaType === 'image') ext = 'jpg';
      else if (mediaType === 'video') ext = 'mp4';
      else if (mediaType === 'audio') ext = 'ogg';
      else if (mediaType === 'sticker') ext = 'webp';
      else if (mediaType === 'document') ext = fileName ? path.extname(fileName).replace('.', '') || 'pdf' : 'pdf';

      const fname = `${msgId}.${ext}`;
      const fpath = path.join(config.mediaDir, fname);
      fs.writeFileSync(fpath, mediaUrlOrBuffer);
      savedMediaUrl = `/media/${fname}`;
    } else if (typeof mediaUrlOrBuffer === 'string') {
      savedMediaUrl = mediaUrlOrBuffer;
    }

    const mediaObj = typeof mediaUrlOrBuffer === 'string' ? { url: mediaUrlOrBuffer } : mediaUrlOrBuffer;

    if (mediaType === 'image') {
      messageContent = { image: mediaObj, caption: caption || '' };
    } else if (mediaType === 'video') {
      messageContent = { video: mediaObj, caption: caption || '' };
    } else if (mediaType === 'audio') {
      messageContent = { audio: mediaObj, mimetype: 'audio/mp4', ptt: true };
    } else if (mediaType === 'document') {
      messageContent = { document: mediaObj, mimetype: 'application/octet-stream', fileName: fileName || 'document.pdf', caption: caption || '' };
    } else if (mediaType === 'sticker') {
      messageContent = { sticker: mediaObj };
    }

    const sent = await sock.sendMessage(jid, messageContent);
    const timestamp = Math.floor(Date.now() / 1000);

    const bodyText = caption || (mediaType === 'document' ? fileName || '[Document]' : `[${mediaType.charAt(0).toUpperCase() + mediaType.slice(1)}]`);

    await pgDb.exec(`
      INSERT INTO messages (id, user_id, session_id, remote_jid, from_me, push_name, message_id, body, media_type, media_url, media_caption, status, timestamp)
      VALUES (?, ?, ?, ?, 1, 'You', ?, ?, ?, ?, ?, 'SENT', ?)
    `, [msgId, userId, sessionId, jid, sent?.key?.id || '', bodyText, mediaType, savedMediaUrl || null, caption || '', timestamp]);

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
    WebhookService.sendWebhook(userId, sessionId, 'message.sent', result);

    return result;
  }

  static async autoStartSavedSessions() {
    const sessions = await pgDb.prepare("SELECT * FROM sessions WHERE status = 'CONNECTED' AND is_auto_reconnect = 1").all() as any[];
    console.log(`🔄 Auto-starting ${sessions.length} saved WhatsApp sessions...`);
    for (const session of sessions) {
      try {
        await this.startSession(session.user_id, session.id);
      } catch (err: any) {
        console.error(`Failed to autostart session ${session.session_name}:`, err.message);
      }
    }
  }

  static getSessionsByUser(userId: string) {
    return pgDb.prepare('SELECT * FROM sessions WHERE user_id = ? ORDER BY created_at DESC').all(userId);
  }

  static getSessionById(sessionId: string) {
    return pgDb.prepare('SELECT * FROM sessions WHERE id = ?').get(sessionId);
  }

  private static emitToUser(userId: string, event: string, data: any) {
    if (this.io) {
      this.io.to(`user_${userId}`).emit(event, data);
    }
  }
}