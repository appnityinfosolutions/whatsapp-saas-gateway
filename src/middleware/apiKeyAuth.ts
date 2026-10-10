import { Request, Response, NextFunction } from 'express';
import { AuthService } from '../services/auth.service';
import { AuthRequest } from './jwtAuth';

export function apiKeyOrJwtAuth(req: AuthRequest, res: Response, next: NextFunction) {
  // 1. Check API Key in headers or query
  const apiKey = (req.headers['x-api-key'] as string) || (req.query.api_key as string);
  
  if (apiKey) {
    const user = AuthService.validateApiKey(apiKey);
    if (!user) {
      return res.status(401).json({ success: false, error: 'Unauthorized: Invalid or inactive API Key' });
    }
    req.user = user;
    return next();
  }

  // 2. Check Authorization Bearer header (could be API Key or JWT)
  const authHeader = req.headers.authorization;
  if (authHeader && authHeader.startsWith('Bearer ')) {
    const token = authHeader.split(' ')[1];
    
    if (token.startsWith('ak_live_')) {
      const user = AuthService.validateApiKey(token);
      if (!user) {
        return res.status(401).json({ success: false, error: 'Unauthorized: Invalid or inactive API Key' });
      }
      req.user = user;
      return next();
    }

    const decoded = AuthService.verifyToken(token);
    if (decoded) {
      const user = AuthService.getUserById(decoded.id);
      if (user && user.is_active) {
        req.user = user;
        return next();
      }
    }
  }

  return res.status(401).json({
    success: false,
    error: 'Unauthorized: Provide an API Key via X-API-Key header or Bearer token',
  });
}
