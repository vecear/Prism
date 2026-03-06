import { hashPassword, signJWT } from '../_auth.js';

export async function onRequestPost(context) {
  const { request, env } = context;
  const { jsonRes, jsonErr } = context;

  let body;
  try { body = await request.json(); } catch { return jsonErr(400, '無效的請求格式'); }

  const { username, password } = body;
  if (!username || !password) return jsonErr(400, '請提供使用者名稱和密碼');
  if (username.length < 2 || username.length > 20) return jsonErr(400, '使用者名稱需 2-20 字元');
  if (password.length < 4) return jsonErr(400, '密碼至少需要 4 個字元');
  if (!/^[a-zA-Z0-9_\u4e00-\u9fff]+$/.test(username)) return jsonErr(400, '使用者名稱只能包含英文、數字、底線或中文');

  const db = env.DB;

  // Check if username exists
  const existing = await db.prepare('SELECT id FROM users WHERE username = ?').bind(username).first();
  if (existing) return jsonErr(409, '此使用者名稱已被註冊');

  // Hash password
  const { hash, salt } = await hashPassword(password);

  // Insert user
  const result = await db.prepare('INSERT INTO users (username, password_hash, salt) VALUES (?, ?, ?)')
    .bind(username, hash, salt).run();

  const userId = result.meta.last_row_id;
  const secret = env.JWT_SECRET || 'prism-default-secret-change-me';
  const token = await signJWT({ sub: userId, username }, secret);

  return jsonRes({ token, user: { id: userId, username } }, 201);
}
