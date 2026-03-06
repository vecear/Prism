import { requireAuth } from '../_auth.js';

export async function onRequestGet(context) {
  const { jsonRes, jsonErr } = context;

  const user = await requireAuth(context);
  if (!user) return jsonErr(401, '未登入或 token 已過期');

  return jsonRes({ user: { id: user.sub, username: user.username } });
}
