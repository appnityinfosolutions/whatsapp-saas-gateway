import { Response } from 'express';
import { AuthService } from '../services/auth.service';
import { AuthRequest } from '../middleware/jwtAuth';
import { db } from '../database/db';

export class AuthController {
  static async register(req: AuthRequest, res: Response) {
    try {
      const { name, email, password, plan } = req.body;
      if (!name || !email || !password) {
        return res.status(400).json({ success: false, error: 'Name, email and password are required' });
      }

      const result = await AuthService.register(name, email, password, plan);
      return res.status(201).json({ success: true, ...result });
    } catch (error: any) {
      return res.status(400).json({ success: false, error: error.message });
    }
  }

  static async login(req: AuthRequest, res: Response) {
    try {
      const { email, password } = req.body;
      if (!email || !password) {
        return res.status(400).json({ success: false, error: 'Email and password are required' });
      }

      const result = await AuthService.login(email, password);
      return res.json({ success: true, ...result });
    } catch (error: any) {
      return res.status(400).json({ success: false, error: error.message });
    }
  }

  static async me(req: AuthRequest, res: Response) {
    return res.json({ success: true, user: req.user });
  }

  static async updateProfile(req: AuthRequest, res: Response) {
    try {
      const { name, webhook_url } = req.body;
      db.prepare(`
        UPDATE users SET name = COALESCE(?, name), webhook_url = COALESCE(?, webhook_url), updated_at = CURRENT_TIMESTAMP
        WHERE id = ?
      `).run(name, webhook_url, req.user.id);

      const updated = AuthService.getUserById(req.user.id);
      return res.json({ success: true, user: updated });
    } catch (error: any) {
      return res.status(400).json({ success: false, error: error.message });
    }
  }

  static async getApiKeys(req: AuthRequest, res: Response) {
    const keys = AuthService.getApiKeys(req.user.id);
    return res.json({ success: true, keys });
  }

  static async createApiKey(req: AuthRequest, res: Response) {
    try {
      const { name } = req.body;
      const key = await AuthService.generateApiKey(req.user.id, name || 'API Key');
      return res.status(201).json({ success: true, key });
    } catch (error: any) {
      return res.status(400).json({ success: false, error: error.message });
    }
  }

  static async deleteApiKey(req: AuthRequest, res: Response) {
    try {
      const { keyId } = req.params;
      AuthService.deleteApiKey(req.user.id, keyId);
      return res.json({ success: true, message: 'API Key deleted' });
    } catch (error: any) {
      return res.status(400).json({ success: false, error: error.message });
    }
  }
}
