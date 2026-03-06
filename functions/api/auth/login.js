import { verifyPassword, signJWT } from '../_auth.js';

export async function onRequestPost(context) {
  const { request, env } = context;
  const { jsonRes, jsonErr } = context;

  let body;
  try { body = await request.json(); } catch { return jsonErr(400, '無效的請求格式'); }

  const { username, password } = body;
  if (!username || !password) return jsonErr(400, '請提供使用者名稱和密碼');

  const db = env.DB;
  const user = await db.prepare('SELECT id, username, password_hash, salt FROM users WHERE username = ?')
    .bind(username).first();

  if (!user) return jsonErr(401, '使用者名稱或密碼錯誤');

  const valid = await verifyPassword(password, user.password_hash, user.salt);
  if (!valid) return jsonErr(401, '使用者名稱或密碼錯誤');

  const secret = env.JWT_SECRET || 'prism-default-secret-change-me';
  const token = await signJWT({ sub: user.id, username: user.username }, secret);

  return jsonRes({ token, user: { id: user.id, username: user.username } });
}
