"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = __importDefault(require("express"));
const http_1 = __importDefault(require("http"));
const socket_io_1 = require("socket.io");
const cors_1 = __importDefault(require("cors"));
const path_1 = __importDefault(require("path"));
const fs_1 = __importDefault(require("fs"));
const config_1 = require("./config");
const db_pg_1 = require("./database/db.pg");
const whatsapp_service_pg_1 = require("./services/whatsapp.service.pg");
const auth_service_1 = require("./services/auth.service");
const api_routes_1 = __importDefault(require("./routes/api.routes"));
const app = (0, express_1.default)();
const server = http_1.default.createServer(app);
const io = new socket_io_1.Server(server, {
    cors: {
        origin: '*',
        methods: ['GET', 'POST'],
    },
});
// Pass Socket.IO instance to WhatsApp Service for real-time events
whatsapp_service_pg_1.WhatsAppService.setSocketIO(io);
// Middlewares
app.use((0, cors_1.default)());
app.use(express_1.default.json({ limit: '50mb' }));
app.use(express_1.default.urlencoded({ extended: true, limit: '50mb' }));
// Serve Public Dashboard UI & Media files
const publicDir = fs_1.default.existsSync(path_1.default.join(__dirname, 'public'))
    ? path_1.default.join(__dirname, 'public')
    : path_1.default.join(__dirname, '..', 'src', 'public');
app.use(express_1.default.static(publicDir));
app.use('/media', express_1.default.static(config_1.config.mediaDir));
// API Routes
app.use('/api/v1', api_routes_1.default);
// Health Check Endpoint
app.get('/api/health', (req, res) => {
    res.json({
        status: 'healthy',
        name: 'WhatsApp SaaS API Gateway',
        version: '1.0.0',
        timestamp: new Date().toISOString(),
    });
});
// Socket.IO Real-Time Connection Handling
io.on('connection', (socket) => {
    const token = socket.handshake.auth.token || socket.handshake.query.token;
    if (token) {
        const decoded = auth_service_1.AuthService.verifyToken(token);
        if (decoded) {
            // Join user-specific room for targeted push events
            socket.join(`user_${decoded.id}`);
            console.log(`🔌 [Socket.IO] Client connected for User: ${decoded.email}`);
        }
    }
    socket.on('disconnect', () => {
        // disconnected
    });
});
// Fallback SPA routing for Dashboard
app.get('*', (req, res) => {
    if (!req.path.startsWith('/api')) {
        res.sendFile(path_1.default.join(publicDir, 'index.html'));
    }
});
// Initialize Database and Start Server
async function startServer() {
    try {
        await (0, db_pg_1.initDatabase)();
        server.listen(config_1.config.port, async () => {
            console.log(`
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
🚀 WhatsApp Multi-Tenant SaaS Gateway is LIVE!
🌐 Dashboard UI:      http://localhost:${config_1.config.port}
📚 REST API Base:     http://localhost:${config_1.config.port}/api/v1
💚 Health Endpoint:   http://localhost:${config_1.config.port}/api/health
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
      `);
            // Auto-reconnect saved WhatsApp sessions
            await whatsapp_service_pg_1.WhatsAppService.autoStartSavedSessions();
        });
    }
    catch (err) {
        console.error('Fatal Server Boot Error:', err);
        process.exit(1);
    }
}
// Graceful shutdown
process.on('SIGTERM', async () => {
    console.log('SIGTERM received, shutting down gracefully...');
    server.close(async () => {
        await (0, db_pg_1.closeDatabase)();
        console.log('Server closed');
        process.exit(0);
    });
});
process.on('SIGINT', async () => {
    console.log('SIGINT received, shutting down gracefully...');
    server.close(async () => {
        await (0, db_pg_1.closeDatabase)();
        console.log('Server closed');
        process.exit(0);
    });
});
startServer();
