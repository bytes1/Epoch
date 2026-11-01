import Database from 'better-sqlite3';
import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { drizzle, type BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import { schema } from './schema.js';

export type MarketDb = BetterSQLite3Database<typeof schema>;

const createTables = (sqlite: Database.Database) => sqlite.exec(`
  CREATE TABLE IF NOT EXISTS markets (
    id TEXT PRIMARY KEY, market_id_hex TEXT NOT NULL UNIQUE, title TEXT NOT NULL, description TEXT NOT NULL DEFAULT '',
    status TEXT NOT NULL DEFAULT 'OPEN' CHECK(status IN ('OPEN','RESOLVED_YES','RESOLVED_NO')),
    yes_category_id TEXT NOT NULL, no_category_id TEXT NOT NULL, vault_category_id TEXT NOT NULL, vault_contract_address TEXT NOT NULL,
    last_yes_price_sats INTEGER NOT NULL DEFAULT 500, last_no_price_sats INTEGER NOT NULL DEFAULT 500,
    volume_sats INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL, resolved_at INTEGER
  );
  CREATE TABLE IF NOT EXISTS vault_utxos (
    id TEXT PRIMARY KEY, market_id TEXT NOT NULL REFERENCES markets(id), utxo_role TEXT NOT NULL CHECK(utxo_role IN ('VAULT_MASTER','YES_BATON','NO_BATON')),
    txid TEXT NOT NULL, vout INTEGER NOT NULL, satoshis INTEGER NOT NULL, token_category TEXT NOT NULL, token_amount INTEGER NOT NULL DEFAULT 0,
    nft_capability TEXT, nft_commitment TEXT, updated_at INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS orders (
    id TEXT PRIMARY KEY, market_id TEXT NOT NULL REFERENCES markets(id), maker_address TEXT NOT NULL, maker_pubkey TEXT NOT NULL,
    side TEXT NOT NULL CHECK(side IN ('BUY','SELL')), outcome TEXT NOT NULL CHECK(outcome IN ('YES','NO')),
    price_sats INTEGER NOT NULL CHECK(price_sats BETWEEN 1 AND 999), total_shares INTEGER NOT NULL CHECK(total_shares > 0),
    remaining_shares INTEGER NOT NULL CHECK(remaining_shares >= 0), utxo_txid TEXT NOT NULL, utxo_vout INTEGER NOT NULL,
    utxo_satoshis INTEGER NOT NULL, status TEXT NOT NULL DEFAULT 'OPEN' CHECK(status IN ('OPEN','PARTIAL','FILLED','CANCELLED')), created_at INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS orders_book_idx ON orders(market_id, outcome, side, status, price_sats, created_at);
  CREATE UNIQUE INDEX IF NOT EXISTS orders_outpoint_idx ON orders(utxo_txid, utxo_vout);
  CREATE TABLE IF NOT EXISTS trades (
    id TEXT PRIMARY KEY, market_id TEXT NOT NULL REFERENCES markets(id), match_type TEXT NOT NULL CHECK(match_type IN ('DIRECT','MINT','MERGE')),
    yes_price_sats INTEGER NOT NULL, no_price_sats INTEGER NOT NULL, shares_traded INTEGER NOT NULL, bch_txid TEXT NOT NULL, executed_at INTEGER NOT NULL
  );
`);

export function createDatabase(path = process.env.DATABASE_PATH ?? './data/market.db') {
  if (path !== ':memory:') {
    mkdirSync(dirname(resolve(path)), { recursive: true });
  }
  const sqlite = new Database(path);
  if (path !== ':memory:') sqlite.pragma('journal_mode = WAL');
  sqlite.pragma('foreign_keys = ON');
  createTables(sqlite);
  return { sqlite, db: drizzle(sqlite, { schema }), close: () => sqlite.close() };
}
