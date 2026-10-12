import { Response } from 'express';
import { WhatsAppService } from '../services/whatsapp.service';
import { AuthRequest } from '../middleware/jwtAuth';

export class SessionController {
  static async list(req: AuthRequest, res: Response) {
    try {
      const sessions = WhatsAppService.getSessionsByUser(req.user.id);
      return res.json({ success: true, sessions });
    } catch (error: any) {
      return res.status(500).json({ success: false, error: error.message });
    }
  }

  static async create(req: AuthRequest, res: Response) {
    try {
      const { sessionName, webhookUrl } = req.body;
      if (!sessionName) {
        return res.status(400).json({ success: false, error: 'sessionName is required' });
      }

      const session = await WhatsAppService.createSession(req.user.id, sessionName.trim(), webhookUrl);
      return res.status(201).json({ success: true, session });
    } catch (error: any) {
      return res.status(400).json({ success: false, error: error.message });
    }
  }

  static async start(req: AuthRequest, res: Response) {
    try {
      const { sessionId } = req.params;
      const result = await WhatsAppService.startSession(req.user.id, sessionId);
      return res.json({ success: true, ...result });
    } catch (error: any) {
      return res.status(400).json({ success: false, error: error.message });
    }
  }

  static async stop(req: AuthRequest, res: Response) {
    try {
      const { sessionId } = req.params;
      const result = await WhatsAppService.stopSession(req.user.id, sessionId);
      return res.json({ success: true, ...result });
    } catch (error: any) {
      return res.status(400).json({ success: false, error: error.message });
    }
  }

  static async delete(req: AuthRequest, res: Response) {
    try {
      const { sessionId } = req.params;
      const result = await WhatsAppService.deleteSession(req.user.id, sessionId);
      return res.json({ success: true, ...result });
    } catch (error: any) {
      return res.status(400).json({ success: false, error: error.message });
    }
  }

  static async getQr(req: AuthRequest, res: Response) {
    try {
      const { sessionId } = req.params;
      const session: any = WhatsAppService.getSessionById(sessionId);
      if (!session || session.user_id !== req.user.id) {
        return res.status(404).json({ success: false, error: 'Session not found' });
      }
      return res.json({
        success: true,
        status: session.status,
        qr: session.qr_code,
      });
    } catch (error: any) {
      return res.status(500).json({ success: false, error: error.message });
    }
  }

  static async requestPairingCode(req: AuthRequest, res: Response) {
    try {
      const { sessionId } = req.params;
      const { phoneNumber } = req.body;
      if (!phoneNumber) {
        return res.status(400).json({ success: false, error: 'phoneNumber is required' });
      }

      const result = await WhatsAppService.requestPairingCode(req.user.id, sessionId, phoneNumber);
      return res.json({ success: true, ...result });
    } catch (error: any) {
      return res.status(400).json({ success: false, error: error.message });
    }
  }

  // Force a brand-new QR code (relink) for a session
  static async restart(req: AuthRequest, res: Response) {
    try {
      const { sessionId } = req.params;
      const result = await WhatsAppService.restartSession(req.user.id, sessionId);
      return res.json({ success: true, ...result });
    } catch (error: any) {
      return res.status(400).json({ success: false, error: error.message });
    }
  }
}
