"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.config = void 0;
const dotenv_1 = __importDefault(require("dotenv"));
const path_1 = __importDefault(require("path"));
const fs_1 = __importDefault(require("fs"));
dotenv_1.default.config();
const isVercel = !!process.env.VERCEL;
const isRender = !!process.env.RENDER;
exports.config = {
    port: parseInt(process.env.PORT || '3000', 10),
    jwtSecret: process.env.JWT_SECRET || 'whatsapp_saas_default_super_secret_key_2026',
    dataDir: path_1.default.resolve(process.env.DATA_DIR || (isVercel ? '/tmp/data' : isRender ? '/opt/render/project/src/data' : './data')),
    sessionsDir: path_1.default.resolve(process.env.SESSIONS_DIR || (isVercel ? '/tmp/data/sessions' : isRender ? '/opt/render/project/src/data/sessions' : './data/sessions')),
    mediaDir: path_1.default.resolve(process.env.MEDIA_DIR || (isVercel ? '/tmp/data/media' : isRender ? '/opt/render/project/src/data/media' : './data/media')),
    dbPath: path_1.default.resolve(process.env.DB_PATH || (isVercel ? '/tmp/data/gateway.sqlite' : isRender ? '/opt/render/project/src/data/gateway.sqlite' : './data/gateway.sqlite')),
    defaultMaxSessions: parseInt(process.env.DEFAULT_MAX_SESSIONS || '3', 10),
    defaultDailyMsgLimit: parseInt(process.env.DEFAULT_DAILY_MSG_LIMIT || '1000', 10),
};
// Ensure critical directories exist (skip on Vercel/Render - handled at runtime)
if (!isVercel && !isRender) {
    for (const dir of [exports.config.dataDir, exports.config.sessionsDir, exports.config.mediaDir]) {
        if (!fs_1.default.existsSync(dir)) {
            fs_1.default.mkdirSync(dir, { recursive: true });
        }
    }
}
