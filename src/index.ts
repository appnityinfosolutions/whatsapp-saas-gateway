import express from 'express';
import http from 'http';
import { Server } from 'socket.io';
import cors from 'cors';
import path from 'path';
import fs from 'fs';
import { config } from './config';
import { initDatabase } from './database/db';
import { WhatsAppService } from './services/whatsapp.service';
import { AuthService } from './services/auth.service';
import apiRoutes from './routes/api.routes';

// Keep the process alive on unexpected errors. Node kills the whole process on an
// unhandled rejection by default, which took every user's WhatsApp session offline
// and made the host return 502 Bad Gateway until it finished restarting.
process.on('unhandledRejection', (reason) => {
  console.error('⚠️  Unhandled promise rejection:', reason);
});
process.on('uncaughtException', (err) => {
  console.error('⚠️  Uncaught exception:', err);
});

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: {
    origin: '*',
    methods: ['GET', 'POST'],
  },
});

// Pass Socket.IO instance to WhatsApp Service for real-time events
WhatsAppService.setSocketIO(io);

// Middlewares
app.use(cors());
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true, limit: '50mb' }));

// Serve Public Dashboard UI & Media files
const publicDir = fs.existsSync(path.join(__dirname, 'public')) 
  ? path.join(__dirname, 'public') 
  : path.join(__dirname, '..', 'src', 'public');
app.use(express.static(publicDir));
app.use('/media', express.static(config.mediaDir));

// API Routes
app.use('/api/v1', apiRoutes);

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
    const decoded = AuthService.verifyToken(token as string);
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

// Unknown API routes must return a JSON 404. Previously they fell through to the SPA
// handler below, which sent no response at all, so the request hung until the host
// timed out with 502 Bad Gateway.
app.use('/api', (req, res) => {
  res.status(404).json({ success: false, error: `Not found: ${req.method} ${req.originalUrl}` });
});

// Fallback SPA routing for Dashboard
app.get('*', (req, res) => {
  if (!req.path.startsWith('/api')) {
    res.sendFile(path.join(publicDir, 'index.html'));
  }
});

// Central error handler: always answer with JSON so clients never receive an empty
// body (which the dashboard reported as "Unexpected end of JSON input").
app.use((err: any, req: express.Request, res: express.Response, next: express.NextFunction) => {
  console.error('Unhandled request error:', err);
  if (res.headersSent) return next(err);
  res.status(500).json({ success: false, error: 'Internal server error' });
});

// Initialize Database and Start Server
async function startServer() {
  await initDatabase();

  server.listen(config.port, async () => {
    console.log(`
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
🚀 WhatsApp Multi-Tenant SaaS Gateway is LIVE!
🌐 Dashboard UI:      http://localhost:${config.port}
📚 REST API Base:     http://localhost:${config.port}/api/v1
💚 Health Endpoint:   http://localhost:${config.port}/api/health
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
    `);

    // Auto-reconnect saved WhatsApp sessions
    await WhatsAppService.autoStartSavedSessions();
  });
}

startServer().catch((err) => {
  console.error('Fatal Server Boot Error:', err);
});
