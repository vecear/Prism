import { requireAuth } from '../_auth.js';

// PUT /api/trades/:id — Update a trade
export async function onRequestPut(context) {
  const { request, env, params } = context;
  const { jsonRes, jsonErr } = context;

  const user = await requireAuth(context);
  if (!user) return jsonErr(401, '未登入');

  const tradeId = params.id;
  const db = env.DB;

  // Verify ownership
  const existing = await db.prepare('SELECT id FROM trades WHERE id = ? AND user_id = ?')
    .bind(tradeId, user.sub).first();
  if (!existing) return jsonErr(404, '找不到此交易紀錄');

  let body;
  try { body = await request.json(); } catch { return jsonErr(400, '無效的請求格式'); }

  const now = new Date().toISOString();
  await db.prepare(`
    UPDATE trades SET date = ?, market = ?, type = ?, symbol = ?, name = ?, direction = ?, status = ?,
      entry_price = ?, exit_price = ?, quantity = ?, contract_mul = ?, stop_loss = ?, take_profit = ?,
      fee = ?, tax = ?, tags = ?, notes = ?, updated_at = ?
    WHERE id = ? AND user_id = ?
  `).bind(
    body.date, body.market || 'tw', body.type || 'stock',
    body.symbol || '', body.name || '', body.direction || 'long', body.status || 'open',
    body.entryPrice || null, body.exitPrice || null, body.quantity || null,
    body.contractMul || null, body.stopLoss || null, body.takeProfit || null,
    body.fee || 0, body.tax || 0,
    JSON.stringify(body.tags || []), body.notes || '', now,
    tradeId, user.sub
  ).run();

  return jsonRes({ ok: true });
}

// DELETE /api/trades/:id — Delete a trade
export async function onRequestDelete(context) {
  const { env, params } = context;
  const { jsonRes, jsonErr } = context;

  const user = await requireAuth(context);
  if (!user) return jsonErr(401, '未登入');

  const tradeId = params.id;
  const db = env.DB;

  const result = await db.prepare('DELETE FROM trades WHERE id = ? AND user_id = ?')
    .bind(tradeId, user.sub).run();

  if (result.meta.changes === 0) return jsonErr(404, '找不到此交易紀錄');

  return jsonRes({ ok: true });
}
