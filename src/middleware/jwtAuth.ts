import { Request, Response, NextFunction } from 'express';
import { AuthService } from '../services/auth.service';

export interface AuthRequest extends Request {
  user?: any;
}

export function jwtAuth(req: AuthRequest, res: Response, next: NextFunction) {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ success: false, error: 'Unauthorized: Missing or invalid token' });
  }

  const token = authHeader.split(' ')[1];
  const decoded = AuthService.verifyToken(token);

  if (!decoded) {
    return res.status(401).json({ success: false, error: 'Unauthorized: Token expired or invalid' });
  }

  const user = AuthService.getUserById(decoded.id);
  if (!user || !user.is_active) {
    return res.status(401).json({ success: false, error: 'Unauthorized: User not found or suspended' });
  }

  req.user = user;
  next();
}
