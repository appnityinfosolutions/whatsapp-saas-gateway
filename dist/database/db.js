"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.db = void 0;
exports.initDatabase = initDatabase;
const sql_js_1 = __importDefault(require("sql.js"));
const fs_1 = __importDefault(require("fs"));
const path_1 = __importDefault(require("path"));
const config_1 = require("../config");
let sqlDb;
let SQL;
// Ensure /tmp/data exists on Vercel
function ensureTmpDataDir() {
    const isVercel = !!process.env.VERCEL;
    if (isVercel) {
        const dirs = [config_1.config.dataDir, config_1.config.sessionsDir, config_1.config.mediaDir];
        for (const dir of dirs) {
            if (!fs_1.default.existsSync(dir)) {
                fs_1.default.mkdirSync(dir, { recursive: true });
            }
        }
    }
}
// Save database buffer to disk synchronously or debounced
function persistDb() {
    try {
        const data = sqlDb.export();
        const buffer = Buffer.from(data);
        fs_1.default.writeFileSync(config_1.config.dbPath, buffer);
    }
    catch (err) {
        console.error('Failed to persist SQLite DB:', err);
    }
}
// Wrapper to provide identical clean API (db.prepare().run(), .get(), .all(), .exec())
exports.db = {
    exec(sql) {
        sqlDb.run(sql);
        persistDb();
    },
    prepare(sql) {
        return {
            run(...params) {
                const stmt = sqlDb.prepare(sql);
                // Flatten array params if passed as single array
                const bindParams = params.length === 1 && Array.isArray(params[0]) ? params[0] : params;
                stmt.run(bindParams);
                stmt.free();
                persistDb();
                return { changes: 1 };
            },
            get(...params) {
                const stmt = sqlDb.prepare(sql);
                const bindParams = params.length === 1 && Array.isArray(params[0]) ? params[0] : params;
                stmt.bind(bindParams);
                let result = null;
                if (stmt.step()) {
                    result = stmt.getAsObject();
                }
                stmt.free();
                return result;
            },
            all(...params) {
                const stmt = sqlDb.prepare(sql);
                const bindParams = params.length === 1 && Array.isArray(params[0]) ? params[0] : params;
                stmt.bind(bindParams);
                const results = [];
                while (stmt.step()) {
                    results.push(stmt.getAsObject());
                }
                stmt.free();
                return results;
            },
        };
    },
};
async function initDatabase() {
    // Ensure /tmp/data exists first
    ensureTmpDataDir();
    // Locate WASM file - Vercel bundles to /var/task/dist/
    const isVercel = !!process.env.VERCEL;
    const wasmLocations = isVercel
        ? [
            path_1.default.join(__dirname, 'sql-wasm.wasm'),
            path_1.default.join(process.cwd(), 'dist', 'sql-wasm.wasm'),
            path_1.default.join(process.cwd(), 'sql-wasm.wasm'),
        ]
        : [
            path_1.default.join(__dirname, '..', 'node_modules', 'sql.js', 'dist', 'sql-wasm.wasm'),
        ];
    let wasmPath = '';
    for (const loc of wasmLocations) {
        if (fs_1.default.existsSync(loc)) {
            wasmPath = loc;
            break;
        }
    }
    const SQLModule = await (0, sql_js_1.default)({
        locateFile: () => wasmPath || 'sql-wasm.wasm',
    });
    SQL = SQLModule;
    // Load existing database file if present
    if (fs_1.default.existsSync(config_1.config.dbPath)) {
        const fileBuffer = fs_1.default.readFileSync(config_1.config.dbPath);
        sqlDb = new SQL.Database(fileBuffer);
    }
    else {
        sqlDb = new SQL.Database();
    }
    // 1. Users table
    exports.db.exec(`
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
    exports.db.exec(`
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
    exports.db.exec(`
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
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
      UNIQUE (user_id, session_name)
    );
  `);
    // 4. Messages History table
    exports.db.exec(`
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
        exports.db.exec('ALTER TABLE messages ADD COLUMN push_name TEXT;');
    }
    catch { }
    try {
        exports.db.exec('ALTER TABLE messages ADD COLUMN media_caption TEXT;');
    }
    catch { }
    // Contacts / Chats cache table
    exports.db.exec(`
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
    exports.db.exec(`
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
    exports.db.exec(`
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
    console.log('✅ SQLite (WebAssembly Zero-Native Engine) initialized at:', config_1.config.dbPath);
}
