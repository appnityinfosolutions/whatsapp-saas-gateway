import { Router } from 'express';
import { AuthController } from '../controllers/auth.controller';
import { SessionController } from '../controllers/session.controller';
import { MessageController } from '../controllers/message.controller';
import { StatsController } from '../controllers/stats.controller';
import { jwtAuth } from '../middleware/jwtAuth';
import { apiKeyOrJwtAuth } from '../middleware/apiKeyAuth';

import multer from 'multer';

const router = Router();
const upload = multer({ limits: { fileSize: 50 * 1024 * 1024 } }); // 50MB max

// ==========================================
// 1. Auth & Profile Routes (Dashboard User)
// ==========================================
router.post('/auth/register', AuthController.register);
router.post('/auth/login', AuthController.login);
router.get('/auth/me', jwtAuth, AuthController.me);
router.put('/auth/profile', jwtAuth, AuthController.updateProfile);

// API Keys Management
router.get('/auth/api-keys', jwtAuth, AuthController.getApiKeys);
router.post('/auth/api-keys', jwtAuth, AuthController.createApiKey);
router.delete('/auth/api-keys/:keyId', jwtAuth, AuthController.deleteApiKey);

// Stats & Dashboard
router.get('/stats/overview', jwtAuth, StatsController.getOverview);

// ==========================================
// 2. WhatsApp Session Management (API & UI)
// ==========================================
router.get('/sessions', apiKeyOrJwtAuth, SessionController.list);
router.post('/sessions', apiKeyOrJwtAuth, SessionController.create);
router.post('/sessions/:sessionId/start', apiKeyOrJwtAuth, SessionController.start);
router.post('/sessions/:sessionId/stop', apiKeyOrJwtAuth, SessionController.stop);
router.delete('/sessions/:sessionId', apiKeyOrJwtAuth, SessionController.delete);
router.get('/sessions/:sessionId/qr', apiKeyOrJwtAuth, SessionController.getQr);
router.post('/sessions/:sessionId/pairing-code', apiKeyOrJwtAuth, SessionController.requestPairingCode);
router.post('/sessions/:sessionId/restart', apiKeyOrJwtAuth, SessionController.restart);

// ==========================================
// 3. WhatsApp Messaging Endpoints (API & UI)
// ==========================================
router.post('/messages/send-text', apiKeyOrJwtAuth, MessageController.sendText);
router.post('/messages/send-media', apiKeyOrJwtAuth, upload.single('file'), MessageController.sendMedia);
router.post('/messages/send-bulk', apiKeyOrJwtAuth, MessageController.sendBulk);
router.get('/messages', apiKeyOrJwtAuth, MessageController.getMessages);
router.get('/chats', apiKeyOrJwtAuth, MessageController.getChats);
router.get('/chats/avatar', apiKeyOrJwtAuth, MessageController.getAvatar);
router.post('/chats/contact', apiKeyOrJwtAuth, upload.single('avatarFile'), MessageController.updateContact);

export default router;
