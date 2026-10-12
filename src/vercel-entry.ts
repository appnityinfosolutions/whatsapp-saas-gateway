import express from 'express';
import cors from 'cors';
import path from 'path';
import fs from 'fs';
import { config } from './config';
import { initDatabase } from './database/db';
import { WhatsAppService } from './services/whatsapp.service';
import { AuthService } from './services/auth.service';
import apiRoutes from './routes/api.routes';

// Initialize database on cold start
let dbInitialized = false;
async function ensureDb() {
  if (!dbInitialized) {
    await initDatabase();
    dbInitialized = true;
  }
}

const app = express();

// Middlewares
app.use(cors({
  origin: '*',
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'X-API-Key']
}));
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true, limit: '50mb' }));

// Serve Public Dashboard UI & Media files
const publicDir = fs.existsSync(path.join(__dirname, 'public'))
  ? path.join(__dirname, 'public')
  : path.join(__dirname, '..', 'src', 'public');
app.use(express.static(publicDir));
app.use('/media', express.static(config.mediaDir));

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
app.use('/api/v1', apiRoutes);

// Unknown API routes must return a JSON 404 instead of hanging.
app.use('/api', (req, res) => {
  res.status(404).json({ success: false, error: `Not found: ${req.method} ${req.originalUrl}` });
});

// Fallback SPA routing for Dashboard
app.get('*', async (req, res) => {
  if (!req.path.startsWith('/api')) {
    await ensureDb();
    res.sendFile(path.join(publicDir, 'index.html'));
  }
});

// Central error handler: always answer with JSON, never an empty body.
app.use((err: any, req: express.Request, res: express.Response, next: express.NextFunction) => {
  console.error('Unhandled request error:', err);
  if (res.headersSent) return next(err);
  res.status(500).json({ success: false, error: 'Internal server error' });
});

// Export for Vercel serverless
export default app;