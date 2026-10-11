import dotenv from 'dotenv';
import path from 'path';
import fs from 'fs';

dotenv.config();

const isVercel = !!process.env.VERCEL;
const isRender = !!process.env.RENDER;

export const config = {
  port: parseInt(process.env.PORT || '3000', 10),
  jwtSecret: process.env.JWT_SECRET || 'whatsapp_saas_default_super_secret_key_2026',
  dataDir: path.resolve(process.env.DATA_DIR || (isVercel ? '/tmp/data' : isRender ? '/opt/render/project/src/data' : './data')),
  sessionsDir: path.resolve(process.env.SESSIONS_DIR || (isVercel ? '/tmp/data/sessions' : isRender ? '/opt/render/project/src/data/sessions' : './data/sessions')),
  mediaDir: path.resolve(process.env.MEDIA_DIR || (isVercel ? '/tmp/data/media' : isRender ? '/opt/render/project/src/data/media' : './data/media')),
  dbPath: path.resolve(process.env.DB_PATH || (isVercel ? '/tmp/data/gateway.sqlite' : isRender ? '/opt/render/project/src/data/gateway.sqlite' : './data/gateway.sqlite')),
  defaultMaxSessions: parseInt(process.env.DEFAULT_MAX_SESSIONS || '3', 10),
  defaultDailyMsgLimit: parseInt(process.env.DEFAULT_DAILY_MSG_LIMIT || '1000', 10),
};

// Ensure critical directories exist (skip on Vercel/Render - handled at runtime)
if (!isVercel && !isRender) {
  for (const dir of [config.dataDir, config.sessionsDir, config.mediaDir]) {
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
  }
}
