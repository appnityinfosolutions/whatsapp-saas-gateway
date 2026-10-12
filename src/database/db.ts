import initSqlJs, { Database as SqlDatabase } from 'sql.js';
import fs from 'fs';
import path from 'path';
import { config } from '../config';

let sqlDb: SqlDatabase;
let SQL: any;

// Ensure /tmp/data exists on Vercel
function ensureTmpDataDir() {
  const isVercel = !!process.env.VERCEL;
  if (isVercel) {
    const dirs = [config.dataDir, config.sessionsDir, config.mediaDir];
    for (const dir of dirs) {
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }
    }
  }
}

// Save database buffer to disk synchronously or debounced
function persistDb() {
  try {
    const data = sqlDb.export();
    const buffer = Buffer.from(data);
    fs.writeFileSync(config.dbPath, buffer);
  } catch (err) {
    console.error('Failed to persist SQLite DB:', err);
  }
}

// Wrapper to provide identical clean API (db.prepare().run(), .get(), .all(), .exec())
export const db = {
  exec(sql: string) {
    sqlDb.run(sql);
    persistDb();
  },

  prepare(sql: string) {
    return {
      run(...params: any[]) {
        const stmt = sqlDb.prepare(sql);
        // Flatten array params if passed as single array
        const bindParams = params.length === 1 && Array.isArray(params[0]) ? params[0] : params;
        stmt.run(bindParams);
        stmt.free();
        persistDb();
        return { changes: 1 };
      },

      get(...params: any[]) {
        const stmt = sqlDb.prepare(sql);
        const bindParams = params.length === 1 && Array.isArray(params[0]) ? params[0] : params;
        stmt.bind(bindParams);
        let result: any = null;
        if (stmt.step()) {
          result = stmt.getAsObject();
        }
        stmt.free();
        return result;
      },

      all(...params: any[]) {
        const stmt = sqlDb.prepare(sql);
        const bindParams = params.length === 1 && Array.isArray(params[0]) ? params[0] : params;
        stmt.bind(bindParams);
        const results: any[] = [];
        while (stmt.step()) {
          results.push(stmt.getAsObject());
        }
        stmt.free();
        return results;
      },
    };
  },
};

export async function initDatabase() {
  // Ensure /tmp/data exists first
  ensureTmpDataDir();

  // Locate WASM file - Vercel bundles to /var/task/dist/, Render copies to dist/
  const isVercel = !!process.env.VERCEL;
  const isRender = !!process.env.RENDER;
  const wasmLocations = isVercel
    ? [
        path.join(__dirname, 'sql-wasm.wasm'),
        path.join(process.cwd(), 'dist', 'sql-wasm.wasm'),
        path.join(process.cwd(), 'sql-wasm.wasm'),
      ]
    : isRender
    ? [
        path.join(__dirname, 'sql-wasm.wasm'),
        path.join(process.cwd(), 'dist', 'sql-wasm.wasm'),
        path.join(process.cwd(), 'sql-wasm.wasm'),
      ]
    : [
        path.join(__dirname, '..', 'node_modules', 'sql.js', 'dist', 'sql-wasm.wasm'),
      ];

  let wasmPath = '';
  for (const loc of wasmLocations) {
    if (fs.existsSync(loc)) {
      wasmPath = loc;
      break;
    }
  }

  if (!wasmPath) {
    console.error('❌ sql-wasm.wasm not found in any location:', wasmLocations);
    throw new Error('sql-wasm.wasm not found');
  }

  console.log('📦 Loading sql-wasm.wasm from:', wasmPath);

  const SQLModule = await initSqlJs({
    locateFile: () => wasmPath,
  });

  SQL = SQLModule;

  // Load existing database file if present
  if (fs.existsSync(config.dbPath)) {
    const fileBuffer = fs.readFileSync(config.dbPath);
    sqlDb = new SQL.Database(fileBuffer);
  } else {
    sqlDb = new SQL.Database();
  }

  // 1. Users table
  db.exec(`
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
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
  `);

  // 2. API Keys table
  db.exec(`
    CREATE TABLE IF NOT EXISTS api_keys (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      name TEXT NOT NULL,
      key_hash TEXT NOT NULL,
      key_prefix TEXT NOT NULL,
      is_active INTEGER DEFAULT 1,
      last_used_at DATETIME,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    );
  `);

  // 3. WhatsApp Sessions table
  db.exec(`
    CREATE TABLE IF NOT EXISTS sessions (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      session_name TEXT NOT NULL,
      phone_number TEXT,
      push_name TEXT,
      status TEXT DEFAULT 'STOPPED',
      qr_code TEXT,
      pairing_code TEXT,
      webhook_url TEXT,
      is_auto_reconnect INTEGER DEFAULT 1,
      reconnect_attempt INTEGER DEFAULT 0,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
      UNIQUE (user_id, session_name)
    );
  `);

  // 4. Messages History table
  db.exec(`
    CREATE TABLE IF NOT EXISTS messages (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      session_id TEXT NOT NULL,
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
      timestamp INTEGER NOT NULL,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
      FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE
    );
  `);

  // Migrate existing messages table if columns are missing
  try {
    db.exec('ALTER TABLE messages ADD COLUMN push_name TEXT;');
  } catch {}
  try {
    db.exec('ALTER TABLE messages ADD COLUMN media_caption TEXT;');
  } catch {}

  // Contacts / Chats cache table
  db.exec(`
    CREATE TABLE IF NOT EXISTS contacts (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      session_id TEXT NOT NULL,
      jid TEXT NOT NULL,
      name TEXT,
      phone_number TEXT,
      avatar_url TEXT,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
      FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE,
      UNIQUE (session_id, jid)
    );
  `);

  // 5. Webhook Delivery Logs
  db.exec(`
    CREATE TABLE IF NOT EXISTS webhook_logs (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      session_id TEXT,
      event TEXT NOT NULL,
      url TEXT NOT NULL,
      payload TEXT NOT NULL,
      response_status INTEGER,
      response_body TEXT,
      success INTEGER DEFAULT 0,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    );
  `);

  // 6. Activity Logs
  db.exec(`
    CREATE TABLE IF NOT EXISTS activity_logs (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      action TEXT NOT NULL,
      details TEXT,
      ip_address TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    );
  `);

  console.log('✅ SQLite (WebAssembly Zero-Native Engine) initialized at:', config.dbPath);
}