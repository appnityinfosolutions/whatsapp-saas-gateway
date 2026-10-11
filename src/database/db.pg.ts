import { Pool } from 'pg';
import Redis from 'ioredis';
import { config } from '../config';

let pgPool: Pool | null = null;
let redisClient: any = null;

export async function initDatabase() {
  // Initialize PostgreSQL pool if DATABASE_URL is set
  const pgUrl = process.env.DATABASE_URL || `postgresql://${process.env.PGUSER}:***@${process.env.PGHOST}:${process.env.PGPORT}/${process.env.PGDATABASE}`;
  
  if (process.env.DATABASE_URL || process.env.PGHOST) {
    console.log('🐘 Initializing PostgreSQL...');
    pgPool = new Pool({
      connectionString: process.env.DATABASE_URL || `postgresql://${process.env.PGUSER}:***@${process.env.PGHOST}:${process.env.PGPORT}/${process.env.PGDATABASE}`,
      ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false,
    });

    pgPool.on('error', (err: Error) => {
        console.error('❌ PostgreSQL pool error:', err);
      });

    console.log('✅ PostgreSQL pool initialized');
    await setUsePostgres(true);
  
    // Initialize tables
    await initPgTables();
  } else {
    console.warn('⚠️ No PostgreSQL config found, using SQLite fallback');
    await setUsePostgres(false);
    await initSQLite();
  }

  // Initialize Redis
  const redisUrl = process.env.REDIS_URL || `redis://${process.env.REDIS_HOST || 'localhost'}:${process.env.REDIS_PORT || 6379}`;
  
  if (process.env.REDIS_URL || process.env.REDIS_HOST) {
    console.log('🔴 Initializing Redis...');
    const Redis = (await import('ioredis')).default;
    redisClient = new Redis(process.env.REDIS_URL || `redis://${process.env.REDIS_HOST || 'localhost'}:${process.env.REDIS_PORT || 6379}`, {
      maxRetriesPerRequest: 3,
      retryStrategy: (times) => Math.min(times * 50, 2000),
    });

    redisClient.on('error', (err: Error) => {
        console.error('❌ Redis error:', err);
      });

    redisClient.on('connect', () => {
      console.log('✅ Redis connected');
    });

    console.log('✅ Redis client initialized');
  } else {
    console.warn('⚠️ No Redis config found, using in-memory fallback');
  }
}

async function initPgTables() {
  if (!pgPool) return;
  
  const client = await pgPool.connect();
  try {
    await client.query(`
      CREATE TABLE IF NOT EXISTS users (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        email TEXT UNIQUE NOT NULL,
        password_hash TEXT NOT NULL,
        role TEXT DEFAULT 'user',
        plan TEXT DEFAULT 'starter',
        max_sessions INTEGER DEFAULT 3,
        daily_msg_limit INTEGER DEFAULT 1000,
        webhook_url TEXT DEFAULT '',
        is_active INTEGER DEFAULT 1,
        created_at TIMESTAMPTZ DEFAULT NOW(),
        updated_at TIMESTAMPTZ DEFAULT NOW()
      );

      CREATE TABLE IF NOT EXISTS api_keys (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        name TEXT NOT NULL,
        key_hash TEXT NOT NULL,
        key_prefix TEXT NOT NULL,
        is_active INTEGER DEFAULT 1,
        last_used_at TIMESTAMPTZ,
        created_at TIMESTAMPTZ DEFAULT NOW()
      );

      CREATE TABLE IF NOT EXISTS sessions (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        session_name TEXT NOT NULL,
        phone_number TEXT,
        push_name TEXT,
        status TEXT DEFAULT 'STOPPED',
        qr_code TEXT,
        pairing_code TEXT,
        webhook_url TEXT,
        is_auto_reconnect INTEGER DEFAULT 1,
        created_at TIMESTAMPTZ DEFAULT NOW(),
        updated_at TIMESTAMPTZ DEFAULT NOW(),
        UNIQUE (user_id, session_name)
      );

      CREATE TABLE IF NOT EXISTS messages (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
        remote_jid TEXT NOT NULL,
        from_me INTEGER DEFAULT 0,
        push_name TEXT,
        message_id TEXT,
        body TEXT,
        media_type TEXT,
        media_url TEXT,
        media_caption TEXT,
        status TEXT DEFAULT 'PENDING',
        error_message TEXT,
        timestamp BIGINT NOT NULL,
        created_at TIMESTAMPTZ DEFAULT NOW()
      );

      CREATE TABLE IF NOT EXISTS contacts (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
        jid TEXT NOT NULL,
        name TEXT,
        phone_number TEXT,
        avatar_url TEXT,
        updated_at TIMESTAMPTZ DEFAULT NOW(),
        UNIQUE (session_id, jid)
      );

      CREATE TABLE IF NOT EXISTS webhook_logs (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        session_id TEXT,
        event TEXT NOT NULL,
        url TEXT NOT NULL,
        payload TEXT NOT NULL,
        response_status INTEGER,
        response_body TEXT,
        success INTEGER DEFAULT 0,
        created_at TIMESTAMPTZ DEFAULT NOW()
      );

      CREATE TABLE IF NOT EXISTS activity_logs (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        action TEXT NOT NULL,
        details TEXT,
        ip_address TEXT,
        created_at TIMESTAMPTZ DEFAULT NOW()
      );

      CREATE INDEX IF NOT EXISTS idx_messages_session_timestamp ON messages(session_id, timestamp DESC);
      CREATE INDEX IF NOT EXISTS idx_messages_user_timestamp ON messages(user_id, timestamp DESC);
      CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);
      CREATE INDEX IF NOT EXISTS idx_contacts_session ON contacts(session_id);
    `);

    console.log('✅ PostgreSQL tables initialized');
  } finally {
    client.release();
  }
}

function initSQLite() {
  console.log('📦 Using SQLite fallback (local development)');
  // Keep existing SQLite logic for local dev - return promise
  return import('./db').then(m => m.initDatabase());
}

function initInMemoryFallback() {
  console.log('📦 Using in-memory fallback for Redis');
  // Simple in-memory store for local dev
  return Promise.resolve();
}

// --- PostgreSQL wrapper (compatible with existing db API) ---
// Supports both PostgreSQL (Render) and SQLite (local/Vercel)
let usePostgres = false;

export async function setUsePostgres(value: boolean) {
  usePostgres = value;
}

export const pgDb = {
  async exec(sql: string, params?: any[]) {
    if (usePostgres) {
      if (!pgPool) throw new Error('PostgreSQL not initialized');
      if (params && params.length > 0) {
        await pgPool.query(sql, params);
      } else {
        await pgPool.query(sql);
      }
    } else {
      // Fallback to SQLite db
      const { db } = await import('./db');
      db.exec(sql);
    }
  },

  prepare(sql: string) {
    if (usePostgres) {
      if (!pgPool) throw new Error('PostgreSQL not initialized');
      return {
        async run(...params: any[]) {
          const result = await pgPool!.query(sql, params);
          return { changes: result.rowCount };
        },

        async get(...params: any[]) {
          const result = await pgPool!.query(sql, params);
          return result.rows[0] || null;
        },

        async all(...params: any[]) {
          const result = await pgPool!.query(sql, params);
          return result.rows;
        },
      };
    } else {
      // Fallback to SQLite db - sync version
      const { db } = require('./db');
      return db.prepare(sql);
    }
  },
};

// --- Redis wrapper for Baileys auth state ---
const memoryStore: Map<string, any> = new Map();

export const redisAuthStore = {
  async get(key: string) {
    if (redisClient) {
      const data = await redisClient.get(key);
      return data ? JSON.parse(data) : null;
    }
    return memoryStore.get(key) || null;
  },

  async set(key: string, value: any, ttlSeconds?: number) {
    const serialized = JSON.stringify(value);
    if (redisClient) {
      if (ttlSeconds) {
        await redisClient.setex(key, ttlSeconds, JSON.stringify(value));
      } else {
        await redisClient.set(key, JSON.stringify(value));
      }
    } else {
      memoryStore.set(key, value);
      if (ttlSeconds) {
        setTimeout(() => memoryStore.delete(key), ttlSeconds * 1000);
      }
    }
  },

  async del(key: string) {
    if (redisClient) {
      await redisClient.del(key);
    } else {
      memoryStore.delete(key);
    }
  },

  async keys(pattern: string) {
    if (redisClient) {
      return redisClient.keys(pattern);
    }
    const regex = new RegExp('^' + pattern.replace(/\*/g, '.*') + '$');
    return Array.from(memoryStore.keys()).filter(k => regex.test(k));
  },
};

export async function closeDatabase() {
  if (pgPool) await pgPool.end();
  if (redisClient) await redisClient.quit();
}

export { pgPool, redisClient };