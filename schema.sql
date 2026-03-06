-- Prism D1 Database Schema

CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  username TEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,
  salt TEXT NOT NULL,
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS trades (
  id TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL,
  date TEXT NOT NULL,
  market TEXT NOT NULL DEFAULT 'tw',
  type TEXT NOT NULL DEFAULT 'stock',
  symbol TEXT NOT NULL DEFAULT '',
  name TEXT NOT NULL DEFAULT '',
  direction TEXT NOT NULL DEFAULT 'long',
  status TEXT NOT NULL DEFAULT 'open',
  entry_price REAL,
  exit_price REAL,
  quantity REAL,
  contract_mul REAL,
  stop_loss REAL,
  take_profit REAL,
  fee REAL DEFAULT 0,
  tax REAL DEFAULT 0,
  tags TEXT DEFAULT '[]',
  notes TEXT DEFAULT '',
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now')),
  FOREIGN KEY (user_id) REFERENCES users(id)
);

CREATE INDEX IF NOT EXISTS idx_trades_user ON trades(user_id);
CREATE INDEX IF NOT EXISTS idx_trades_date ON trades(user_id, date);
