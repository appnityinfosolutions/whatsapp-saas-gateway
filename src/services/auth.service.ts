import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import crypto from 'crypto';
import { v4 as uuidv4 } from 'uuid';
import { db } from '../database/db';
import { config } from '../config';

export interface User {
  id: string;
  name: string;
  email: string;
  role: string;
  plan: string;
  max_sessions: number;
  daily_msg_limit: number;
  webhook_url?: string;
  is_active: number;
  created_at: string;
}

export class AuthService {
  static async register(name: string, email: string, password: string, plan: string = 'starter') {
    const existing = db.prepare('SELECT id FROM users WHERE email = ?').get(email);
    if (existing) {
      throw new Error('Email is already registered');
    }

    const salt = await bcrypt.genSalt(10);
    const passwordHash = await bcrypt.hash(password, salt);
    const userId = uuidv4();

    let maxSessions = config.defaultMaxSessions;
    let dailyMsgLimit = config.defaultDailyMsgLimit;

    if (plan === 'pro') {
      maxSessions = 10;
      dailyMsgLimit = 10000;
    } else if (plan === 'enterprise') {
      maxSessions = 50;
      dailyMsgLimit = 100000;
    }

    db.prepare(`
      INSERT INTO users (id, name, email, password_hash, role, plan, max_sessions, daily_msg_limit)
      VALUES (?, ?, ?, ?, 'user', ?, ?, ?)
    `).run(userId, name, email, passwordHash, plan, maxSessions, dailyMsgLimit);

    // Auto generate default API key for the new user
    const apiKey = await this.generateApiKey(userId, 'Default Key');

    const user = this.getUserById(userId);
    const token = this.generateToken(user!);

    return { user, token, apiKey };
  }

  static async login(email: string, password: string) {
    const userRow: any = db.prepare('SELECT * FROM users WHERE email = ?').get(email);
    if (!userRow) {
      throw new Error('Invalid email or password');
    }

    if (!userRow.is_active) {
      throw new Error('Account is suspended. Please contact support.');
    }

    const isMatch = await bcrypt.compare(password, userRow.password_hash);
    if (!isMatch) {
      throw new Error('Invalid email or password');
    }

    const { password_hash, ...user } = userRow;
    const token = this.generateToken(user);

    return { user, token };
  }

  static generateToken(user: any): string {
    return jwt.sign(
      { id: user.id, email: user.email, role: user.role, plan: user.plan },
      config.jwtSecret,
      { expiresIn: '7d' }
    );
  }

  static verifyToken(token: string): any {
    try {
      return jwt.verify(token, config.jwtSecret);
    } catch {
      return null;
    }
  }

  static getUserById(id: string): User | null {
    const row: any = db.prepare(`
      SELECT id, name, email, role, plan, max_sessions, daily_msg_limit, webhook_url, is_active, created_at 
      FROM users WHERE id = ?
    `).get(id);
    return row || null;
  }

  static async generateApiKey(userId: string, name: string = 'API Key') {
    const keyId = uuidv4();
    const rawKey = 'ak_live_' + crypto.randomBytes(24).toString('hex');
    const keyPrefix = rawKey.substring(0, 15) + '...';
    const keyHash = crypto.createHash('sha256').update(rawKey).digest('hex');

    db.prepare(`
      INSERT INTO api_keys (id, user_id, name, key_hash, key_prefix)
      VALUES (?, ?, ?, ?, ?)
    `).run(keyId, userId, name, keyHash, keyPrefix);

    return {
      id: keyId,
      name,
      apiKey: rawKey,
      keyPrefix,
    };
  }

  static validateApiKey(apiKey: string): User | null {
    if (!apiKey || !apiKey.startsWith('ak_live_')) return null;

    const keyHash = crypto.createHash('sha256').update(apiKey).digest('hex');
    const keyRow: any = db.prepare(`
      SELECT k.id as key_id, k.user_id, k.is_active as key_active, u.*
      FROM api_keys k
      JOIN users u ON k.user_id = u.id
      WHERE k.key_hash = ? AND k.is_active = 1 AND u.is_active = 1
    `).get(keyHash);

    if (!keyRow) return null;

    // Update last_used_at timestamp
    db.prepare('UPDATE api_keys SET last_used_at = CURRENT_TIMESTAMP WHERE id = ?').run(keyRow.key_id);

    const { password_hash, key_id, key_active, user_id, ...user } = keyRow;
    return user;
  }

  static getApiKeys(userId: string) {
    return db.prepare(`
      SELECT id, name, key_prefix, is_active, last_used_at, created_at
      FROM api_keys WHERE user_id = ? ORDER BY created_at DESC
    `).all(userId);
  }

  static deleteApiKey(userId: string, keyId: string) {
    return db.prepare('DELETE FROM api_keys WHERE id = ? AND user_id = ?').run(keyId, userId);
  }
}
