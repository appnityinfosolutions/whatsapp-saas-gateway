import { Response } from 'express';
import path from 'path';
import fs from 'fs';
import { v4 as uuidv4 } from 'uuid';
import { WhatsAppService } from '../services/whatsapp.service';
import { AuthRequest } from '../middleware/jwtAuth';
import { db } from '../database/db';
import { config } from '../config';

export class MessageController {
  static async sendText(req: AuthRequest, res: Response) {
    try {
      const { sessionId, to, text } = req.body;
      if (!sessionId || !to || !text) {
        return res.status(400).json({ success: false, error: 'sessionId, to, and text are required' });
      }

      // Verify session belongs to user
      const session: any = WhatsAppService.getSessionById(sessionId);
      if (!session || session.user_id !== req.user.id) {
        return res.status(404).json({ success: false, error: 'WhatsApp session not found' });
      }

      const result = await WhatsAppService.sendTextMessage(req.user.id, sessionId, to, text);
      return res.json({ success: true, ...result });
    } catch (error: any) {
      return res.status(400).json({ success: false, error: error.message });
    }
  }

  static async sendMedia(req: AuthRequest, res: Response) {
    try {
      const { sessionId, to, mediaUrl, mediaType, caption, fileName } = req.body;
      if (!sessionId || !to || (!mediaUrl && !req.file) || !mediaType) {
        return res.status(400).json({ success: false, error: 'sessionId, to, media file/url, and mediaType are required' });
      }

      const session: any = WhatsAppService.getSessionById(sessionId);
      if (!session || session.user_id !== req.user.id) {
        return res.status(404).json({ success: false, error: 'WhatsApp session not found' });
      }

      const mediaSource = req.file ? req.file.buffer : mediaUrl;
      const originalName = req.file ? req.file.originalname : fileName;

      const result = await WhatsAppService.sendMediaMessage(
        req.user.id,
        sessionId,
        to,
        mediaSource,
        mediaType,
        caption,
        originalName
      );

      return res.json({ success: true, ...result });
    } catch (error: any) {
      return res.status(400).json({ success: false, error: error.message });
    }
  }

  static async sendBulk(req: AuthRequest, res: Response) {
    try {
      const { sessionId, numbers, message, delaySeconds = 3 } = req.body;
      if (!sessionId || !Array.isArray(numbers) || numbers.length === 0 || !message) {
        return res.status(400).json({ success: false, error: 'sessionId, numbers array, and message are required' });
      }

      const session: any = WhatsAppService.getSessionById(sessionId);
      if (!session || session.user_id !== req.user.id) {
        return res.status(404).json({ success: false, error: 'WhatsApp session not found' });
      }

      // Process in background asynchronously so API returns immediate campaign tracking ID
      const results: any[] = [];
      const delayMs = Math.max(delaySeconds * 1000, 1500); // minimum 1.5s delay to prevent bans

      // Start asynchronous sending loop
      (async () => {
        for (const num of numbers) {
          try {
            const sent = await WhatsAppService.sendTextMessage(req.user.id, sessionId, num, message);
            results.push({ number: num, status: 'SENT', messageId: sent.messageId });
          } catch (err: any) {
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
    } catch (error: any) {
      return res.status(400).json({ success: false, error: error.message });
    }
  }

  static async getMessages(req: AuthRequest, res: Response) {
    try {
      const { sessionId, jid } = req.query;
      let query = 'SELECT * FROM messages WHERE user_id = ?';
      const params: any[] = [req.user.id];

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

      const messages = db.prepare(query).all(...params);
      return res.json({ success: true, messages });
    } catch (error: any) {
      return res.status(500).json({ success: false, error: error.message });
    }
  }

  static async getChats(req: AuthRequest, res: Response) {
    try {
      const { sessionId } = req.query;
      
      // Live Inbox = 1:1 chats only. Excludes status broadcast, newsletters
      // AND group chats (@g.us). Dedupes by canonical chat identity so the
      // same person never appears twice (e.g. @lid + @s.whatsapp.net forms).
      //
      // @lid JIDs carry an opaque internal ID DIFFERENT from the phone number
      // in the @s.whatsapp.net JID, so grouping by base_id alone double-lists
      // them. The canonical key resolves each base_id to the real phone
      // number (from contacts) when known — both JID forms of the same
      // person share it => one row. Name/avatar use the same resolution.
      const query = `
        WITH chat_groups AS (
          SELECT
            substr(remote_jid, 1, instr(remote_jid, '@') - 1) AS base_id,
            session_id,
            MAX(timestamp) AS max_time
          FROM messages
          WHERE user_id = ?
            AND remote_jid NOT LIKE '%@broadcast'
            AND remote_jid NOT LIKE '%newsletter%'
            AND remote_jid NOT LIKE '%@g.us'
            ${sessionId ? 'AND session_id = ?' : ''}
          GROUP BY substr(remote_jid, 1, instr(remote_jid, '@') - 1), session_id
        ),
        resolved AS (
          SELECT
            g.base_id, g.session_id, g.max_time,
            m.remote_jid, m.body AS last_message, m.from_me,
            m.media_type, m.media_url,
            COALESCE(
              NULLIF((SELECT phone_number FROM contacts cp
                      WHERE cp.session_id = g.session_id
                        AND substr(cp.jid, 1, instr(cp.jid, '@') - 1) = g.base_id
                        AND cp.phone_number IS NOT NULL AND cp.phone_number != ''
                        AND length(cp.phone_number) BETWEEN 7 AND 13
                      ORDER BY cp.updated_at DESC LIMIT 1), ''),
              g.base_id
            ) AS chat_key,
            COALESCE(
              NULLIF((SELECT name FROM contacts cn
                      WHERE cn.session_id = g.session_id
                        AND substr(cn.jid, 1, instr(cn.jid, '@') - 1) = g.base_id
                        AND cn.name IS NOT NULL AND cn.name != ''
                      ORDER BY cn.updated_at DESC LIMIT 1), ''),
              NULLIF((SELECT push_name FROM messages mn
                      WHERE mn.session_id = g.session_id
                        AND substr(mn.remote_jid, 1, instr(mn.remote_jid, '@') - 1) = g.base_id
                        AND mn.push_name IS NOT NULL AND mn.push_name != ''
                        AND mn.push_name != 'You'
                      ORDER BY mn.timestamp DESC LIMIT 1), ''),
              ''
            ) AS name,
            COALESCE(
              NULLIF((SELECT phone_number FROM contacts cph
                      WHERE cph.session_id = g.session_id
                        AND substr(cph.jid, 1, instr(cph.jid, '@') - 1) = g.base_id
                        AND cph.phone_number IS NOT NULL AND cph.phone_number != ''
                        AND length(cph.phone_number) BETWEEN 7 AND 13
                      ORDER BY cph.updated_at DESC LIMIT 1), ''),
              (CASE WHEN m.remote_jid LIKE '%@s.whatsapp.net' THEN g.base_id ELSE '' END)
            ) AS phone_digits,
            COALESCE((SELECT avatar_url FROM contacts cav
                      WHERE cav.session_id = g.session_id
                        AND substr(cav.jid, 1, instr(cav.jid, '@') - 1) = g.base_id
                        AND cav.avatar_url IS NOT NULL AND cav.avatar_url != ''
                      ORDER BY cav.updated_at DESC LIMIT 1), '') AS avatar_url
          FROM chat_groups g
          JOIN messages m
            ON m.session_id = g.session_id
           AND substr(m.remote_jid, 1, instr(m.remote_jid, '@') - 1) = g.base_id
           AND m.timestamp = g.max_time
          WHERE m.user_id = ?
            AND m.remote_jid NOT LIKE '%@broadcast'
            AND m.remote_jid NOT LIKE '%newsletter%'
            AND m.remote_jid NOT LIKE '%@g.us'
        )
        SELECT
          remote_jid, session_id, last_message, max_time AS last_timestamp,
          from_me, media_type, media_url, name, phone_digits, avatar_url,
          chat_key, base_id
        FROM resolved
        GROUP BY chat_key, session_id
        ORDER BY last_timestamp DESC
        LIMIT 500
      `;

      // Placeholder order in the query:
      //   1. chat_groups WHERE user_id = ?
      //   2. chat_groups AND session_id = ?   (only when sessionId given)
      //   3. resolved JOIN WHERE m.user_id = ?
      const params = sessionId
        ? [req.user.id, sessionId, req.user.id]
        : [req.user.id, req.user.id];

      const chats = db.prepare(query).all(...params);

      // Format: never show the internal @lid ID — show a clean phone number
      // when we know one, otherwise fall back to the contact name.
      const formattedChats = chats.map((c: any) => {
        const digits = String(c.phone_digits || '').replace(/\D/g, '');
        const hasPhone = digits.length >= 7 && digits.length <= 13;
        const displayPhone = hasPhone ? `+${digits}` : '';
        const name = c.name || '';
        const displayName = name || displayPhone || c.remote_jid;

        return {
          ...c,
          name,
          // phone_number = digits only (API consumers); display_phone =
          // human form. Never concatenate phone + id.
          phone_number: hasPhone ? digits : '',
          display_phone: displayPhone,
          display_name: displayName,
        };
      });

      return res.json({ success: true, chats: formattedChats });
    } catch (error: any) {
      return res.status(500).json({ success: false, error: error.message });
    }
  }

  static async getAvatar(req: AuthRequest, res: Response) {
    try {
      const { sessionId, jid } = req.query;
      if (!sessionId || !jid) {
        return res.status(400).json({ success: false, error: 'sessionId and jid are required' });
      }

      const avatarUrl = await WhatsAppService.getProfilePicture(sessionId as string, jid as string);
      
      const base = (jid as string).split('@')[0];
      const contact: any = db.prepare('SELECT name, phone_number, avatar_url FROM contacts WHERE session_id = ? AND (jid = ? OR jid LIKE ? OR phone_number = ?)').get(sessionId, jid, `${base}@%`, base);

      return res.json({
        success: true,
        avatarUrl: avatarUrl || contact?.avatar_url || null,
        name: contact?.name || '',
        phone: contact?.phone_number || ''
      });
    } catch (error: any) {
      return res.json({ success: false, avatarUrl: null });
    }
  }

  static async updateContact(req: AuthRequest, res: Response) {
    try {
      const { sessionId, jid, name, phoneNumber, avatarUrl } = req.body;
      if (!sessionId || !jid) {
        return res.status(400).json({ success: false, error: 'sessionId and jid are required' });
      }

      let finalAvatarUrl = avatarUrl || null;
      if (req.file) {
        const ext = path.extname(req.file.originalname) || '.jpg';
        const fname = `avatar_${uuidv4()}${ext}`;
        const fpath = path.join(config.mediaDir, fname);
        fs.writeFileSync(fpath, req.file.buffer);
        finalAvatarUrl = `/media/${fname}`;
      }

      const contactId = `${sessionId}_${jid}`;
      db.prepare(`
        INSERT INTO contacts (id, user_id, session_id, jid, name, phone_number, avatar_url, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
        ON CONFLICT(session_id, jid) DO UPDATE SET
          name = COALESCE(NULLIF(excluded.name, ''), contacts.name),
          phone_number = COALESCE(NULLIF(excluded.phone_number, ''), contacts.phone_number),
          avatar_url = COALESCE(NULLIF(excluded.avatar_url, ''), contacts.avatar_url),
          updated_at = CURRENT_TIMESTAMP
      `).run(contactId, req.user.id, sessionId, jid, name || '', phoneNumber || '', finalAvatarUrl);

      return res.json({ success: true, message: 'Contact updated successfully', avatarUrl: finalAvatarUrl });
    } catch (err: any) {
      return res.status(500).json({ success: false, error: err.message });
    }
  }
}
