"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.SessionController = void 0;
const whatsapp_service_1 = require("../services/whatsapp.service");
class SessionController {
    static async list(req, res) {
        try {
            const sessions = whatsapp_service_1.WhatsAppService.getSessionsByUser(req.user.id);
            return res.json({ success: true, sessions });
        }
        catch (error) {
            return res.status(500).json({ success: false, error: error.message });
        }
    }
    static async create(req, res) {
        try {
            const { sessionName, webhookUrl } = req.body;
            if (!sessionName) {
                return res.status(400).json({ success: false, error: 'sessionName is required' });
            }
            const session = await whatsapp_service_1.WhatsAppService.createSession(req.user.id, sessionName.trim(), webhookUrl);
            return res.status(201).json({ success: true, session });
        }
        catch (error) {
            return res.status(400).json({ success: false, error: error.message });
        }
    }
    static async start(req, res) {
        try {
            const { sessionId } = req.params;
            const result = await whatsapp_service_1.WhatsAppService.startSession(req.user.id, sessionId);
            return res.json({ success: true, ...result });
        }
        catch (error) {
            return res.status(400).json({ success: false, error: error.message });
        }
    }
    static async stop(req, res) {
        try {
            const { sessionId } = req.params;
            const result = await whatsapp_service_1.WhatsAppService.stopSession(req.user.id, sessionId);
            return res.json({ success: true, ...result });
        }
        catch (error) {
            return res.status(400).json({ success: false, error: error.message });
        }
    }
    static async delete(req, res) {
        try {
            const { sessionId } = req.params;
            const result = await whatsapp_service_1.WhatsAppService.deleteSession(req.user.id, sessionId);
            return res.json({ success: true, ...result });
        }
        catch (error) {
            return res.status(400).json({ success: false, error: error.message });
        }
    }
    static async getQr(req, res) {
        try {
            const { sessionId } = req.params;
            const session = whatsapp_service_1.WhatsAppService.getSessionById(sessionId);
            if (!session || session.user_id !== req.user.id) {
                return res.status(404).json({ success: false, error: 'Session not found' });
            }
            return res.json({
                success: true,
                status: session.status,
                qr: session.qr_code,
            });
        }
        catch (error) {
            return res.status(500).json({ success: false, error: error.message });
        }
    }
    static async requestPairingCode(req, res) {
        try {
            const { sessionId } = req.params;
            const { phoneNumber } = req.body;
            if (!phoneNumber) {
                return res.status(400).json({ success: false, error: 'phoneNumber is required' });
            }
            const result = await whatsapp_service_1.WhatsAppService.requestPairingCode(req.user.id, sessionId, phoneNumber);
            return res.json({ success: true, ...result });
        }
        catch (error) {
            return res.status(400).json({ success: false, error: error.message });
        }
    }
    // Force a brand-new QR code (relink) for a session
    static async restart(req, res) {
        try {
            const { sessionId } = req.params;
            const result = await whatsapp_service_1.WhatsAppService.restartSession(req.user.id, sessionId);
            return res.json({ success: true, ...result });
        }
        catch (error) {
            return res.status(400).json({ success: false, error: error.message });
        }
    }
}
exports.SessionController = SessionController;
