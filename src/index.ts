import express from 'express';
import http from 'http';
import { Server } from 'socket.io';
import cors from 'cors';
import path from 'path';
import fs from 'fs';
import { config } from './config';
import { initDatabase, closeDatabase } from './database/db.pg';
import { WhatsAppService } from './services/whatsapp.service.pg';
import { AuthService } from './services/auth.service';
import apiRoutes from './routes/api.routes';

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

// Fallback SPA routing for Dashboard
app.get('*', (req, res) => {
  if (!req.path.startsWith('/api')) {
    res.sendFile(path.join(publicDir, 'index.html'));
  }
});

// Initialize Database and Start Server
async function startServer() {
  try {
    await initDatabase();

    server.listen(config.port, async () => {
      console.log(`
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
🚀 WhatsApp Multi-Tenant SaaS Gateway is LIVE!
🌐 Dashboard UI:      http://localhost:${config.port}
📚 REST API Base:     http://localhost:${config.port}/api/v1
💚 Health Endpoint:   http://localhost:${config.port}/api/health
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
      `);

      // Auto-reconnect saved WhatsApp sessions
      await WhatsAppService.autoStartSavedSessions();
    });
  } catch (err) {
    console.error('Fatal Server Boot Error:', err);
    process.exit(1);
  }
}

// Graceful shutdown
process.on('SIGTERM', async () => {
  console.log('SIGTERM received, shutting down gracefully...');
  server.close(async () => {
    await closeDatabase();
    console.log('Server closed');
    process.exit(0);
  });
});

process.on('SIGINT', async () => {
  console.log('SIGINT received, shutting down gracefully...');
  server.close(async () => {
    await closeDatabase();
    console.log('Server closed');
    process.exit(0);
  });
});

startServer();
