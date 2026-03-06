import { requireAuth } from './_auth.js';

// GET /api/trades — List all trades for the logged-in user
export async function onRequestGet(context) {
  const { env } = context;
  const { jsonRes, jsonErr } = context;

  const user = await requireAuth(context);
  if (!user) return jsonErr(401, '未登入');

  const db = env.DB;
  const { results } = await db.prepare(
    'SELECT * FROM trades WHERE user_id = ? ORDER BY date DESC'
  ).bind(user.sub).all();

  // Parse tags JSON string back to array
  const trades = results.map(row => ({
    id: row.id,
    date: row.date,
    market: row.market,
    type: row.type,
    symbol: row.symbol,
    name: row.name,
    direction: row.direction,
    status: row.status,
    entryPrice: row.entry_price,
    exitPrice: row.exit_price,
    quantity: row.quantity,
    contractMul: row.contract_mul,
    stopLoss: row.stop_loss,
    takeProfit: row.take_profit,
    fee: row.fee,
    tax: row.tax,
    tags: JSON.parse(row.tags || '[]'),
    notes: row.notes,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }));

  return jsonRes({ trades });
}

// POST /api/trades — Create a new trade
export async function onRequestPost(context) {
  const { request, env } = context;
  const { jsonRes, jsonErr } = context;

  const user = await requireAuth(context);
  if (!user) return jsonErr(401, '未登入');

  let body;
  try { body = await request.json(); } catch { return jsonErr(400, '無效的請求格式'); }

  const id = body.id || (Date.now().toString(36) + Math.random().toString(36).slice(2, 7));
  const now = new Date().toISOString();

  const db = env.DB;
  await db.prepare(`
    INSERT INTO trades (id, user_id, date, market, type, symbol, name, direction, status,
      entry_price, exit_price, quantity, contract_mul, stop_loss, take_profit, fee, tax, tags, notes, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).bind(
    id, user.sub, body.date || now, body.market || 'tw', body.type || 'stock',
    body.symbol || '', body.name || '', body.direction || 'long', body.status || 'open',
    body.entryPrice || null, body.exitPrice || null, body.quantity || null,
    body.contractMul || null, body.stopLoss || null, body.takeProfit || null,
    body.fee || 0, body.tax || 0,
    JSON.stringify(body.tags || []), body.notes || '', now, now
  ).run();

  return jsonRes({ id }, 201);
}
