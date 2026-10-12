"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = require("express");
const auth_controller_1 = require("../controllers/auth.controller");
const session_controller_1 = require("../controllers/session.controller");
const message_controller_1 = require("../controllers/message.controller");
const stats_controller_1 = require("../controllers/stats.controller");
const jwtAuth_1 = require("../middleware/jwtAuth");
const apiKeyAuth_1 = require("../middleware/apiKeyAuth");
const multer_1 = __importDefault(require("multer"));
const router = (0, express_1.Router)();
const upload = (0, multer_1.default)({ limits: { fileSize: 50 * 1024 * 1024 } }); // 50MB max
// ==========================================
// 1. Auth & Profile Routes (Dashboard User)
// ==========================================
router.post('/auth/register', auth_controller_1.AuthController.register);
router.post('/auth/login', auth_controller_1.AuthController.login);
router.get('/auth/me', jwtAuth_1.jwtAuth, auth_controller_1.AuthController.me);
router.put('/auth/profile', jwtAuth_1.jwtAuth, auth_controller_1.AuthController.updateProfile);
// API Keys Management
router.get('/auth/api-keys', jwtAuth_1.jwtAuth, auth_controller_1.AuthController.getApiKeys);
router.post('/auth/api-keys', jwtAuth_1.jwtAuth, auth_controller_1.AuthController.createApiKey);
router.delete('/auth/api-keys/:keyId', jwtAuth_1.jwtAuth, auth_controller_1.AuthController.deleteApiKey);
// Stats & Dashboard
router.get('/stats/overview', jwtAuth_1.jwtAuth, stats_controller_1.StatsController.getOverview);
// ==========================================
// 2. WhatsApp Session Management (API & UI)
// ==========================================
router.get('/sessions', apiKeyAuth_1.apiKeyOrJwtAuth, session_controller_1.SessionController.list);
router.post('/sessions', apiKeyAuth_1.apiKeyOrJwtAuth, session_controller_1.SessionController.create);
router.post('/sessions/:sessionId/start', apiKeyAuth_1.apiKeyOrJwtAuth, session_controller_1.SessionController.start);
router.post('/sessions/:sessionId/stop', apiKeyAuth_1.apiKeyOrJwtAuth, session_controller_1.SessionController.stop);
router.delete('/sessions/:sessionId', apiKeyAuth_1.apiKeyOrJwtAuth, session_controller_1.SessionController.delete);
router.get('/sessions/:sessionId/qr', apiKeyAuth_1.apiKeyOrJwtAuth, session_controller_1.SessionController.getQr);
router.post('/sessions/:sessionId/pairing-code', apiKeyAuth_1.apiKeyOrJwtAuth, session_controller_1.SessionController.requestPairingCode);
router.post('/sessions/:sessionId/restart', apiKeyAuth_1.apiKeyOrJwtAuth, session_controller_1.SessionController.restart);
// ==========================================
// 3. WhatsApp Messaging Endpoints (API & UI)
// ==========================================
router.post('/messages/send-text', apiKeyAuth_1.apiKeyOrJwtAuth, message_controller_1.MessageController.sendText);
router.post('/messages/send-media', apiKeyAuth_1.apiKeyOrJwtAuth, upload.single('file'), message_controller_1.MessageController.sendMedia);
router.post('/messages/send-bulk', apiKeyAuth_1.apiKeyOrJwtAuth, message_controller_1.MessageController.sendBulk);
router.get('/messages', apiKeyAuth_1.apiKeyOrJwtAuth, message_controller_1.MessageController.getMessages);
router.get('/chats', apiKeyAuth_1.apiKeyOrJwtAuth, message_controller_1.MessageController.getChats);
router.get('/chats/avatar', apiKeyAuth_1.apiKeyOrJwtAuth, message_controller_1.MessageController.getAvatar);
router.post('/chats/contact', apiKeyAuth_1.apiKeyOrJwtAuth, upload.single('avatarFile'), message_controller_1.MessageController.updateContact);
exports.default = router;
