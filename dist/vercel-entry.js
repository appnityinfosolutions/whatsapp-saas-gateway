"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = __importDefault(require("express"));
const cors_1 = __importDefault(require("cors"));
const path_1 = __importDefault(require("path"));
const fs_1 = __importDefault(require("fs"));
const config_1 = require("./config");
const db_pg_1 = require("./database/db.pg");
const api_routes_1 = __importDefault(require("./routes/api.routes"));
// Initialize database on cold start
let dbInitialized = false;
async function ensureDb() {
    if (!dbInitialized) {
        await (0, db_pg_1.initDatabase)();
        dbInitialized = true;
    }
}
const app = (0, express_1.default)();
// Middlewares
app.use((0, cors_1.default)({
    origin: '*',
    credentials: true,
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization', 'X-API-Key']
}));
app.use(express_1.default.json({ limit: '50mb' }));
app.use(express_1.default.urlencoded({ extended: true, limit: '50mb' }));
// Serve Public Dashboard UI & Media files
const publicDir = fs_1.default.existsSync(path_1.default.join(__dirname, 'public'))
    ? path_1.default.join(__dirname, 'public')
    : path_1.default.join(__dirname, '..', 'src', 'public');
app.use(express_1.default.static(publicDir));
app.use('/media', express_1.default.static(config_1.config.mediaDir));
// Health Check Endpoint - MUST come before catch-all
app.get('/api/health', async (req, res) => {
    await ensureDb();
    res.json({
        status: 'healthy',
        name: 'WhatsApp SaaS API Gateway',
        version: '1.0.0',
        timestamp: new Date().toISOString(),
    });
});
// API Routes
app.use('/api/v1', api_routes_1.default);
// Fallback SPA routing for Dashboard
app.get('*', async (req, res) => {
    if (!req.path.startsWith('/api')) {
        await ensureDb();
        res.sendFile(path_1.default.join(publicDir, 'index.html'));
    }
});
// Export for Vercel serverless
exports.default = app;
