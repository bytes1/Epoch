import { integer, sqliteTable, text } from 'drizzle-orm/sqlite-core';

export const markets = sqliteTable('markets', {
  id: text('id').primaryKey(), marketIdHex: text('market_id_hex').notNull().unique(),
  title: text('title').notNull(), description: text('description').notNull().default(''),
  status: text('status', { enum: ['OPEN', 'RESOLVED_YES', 'RESOLVED_NO'] }).notNull().default('OPEN'),
  yesCategoryId: text('yes_category_id').notNull(), noCategoryId: text('no_category_id').notNull(),
  vaultCategoryId: text('vault_category_id').notNull(), vaultContractAddress: text('vault_contract_address').notNull(),
  lastYesPriceSats: integer('last_yes_price_sats').notNull().default(500),
  lastNoPriceSats: integer('last_no_price_sats').notNull().default(500), volumeSats: integer('volume_sats').notNull().default(0),
  createdAt: integer('created_at').notNull(), resolvedAt: integer('resolved_at'),
});

export const vaultUtxos = sqliteTable('vault_utxos', {
  id: text('id').primaryKey(), marketId: text('market_id').notNull().references(() => markets.id),
  utxoRole: text('utxo_role', { enum: ['VAULT_MASTER', 'YES_BATON', 'NO_BATON'] }).notNull(),
  txid: text('txid').notNull(), vout: integer('vout').notNull(), satoshis: integer('satoshis').notNull(),
  tokenCategory: text('token_category').notNull(), tokenAmount: integer('token_amount').notNull().default(0),
  nftCapability: text('nft_capability'), nftCommitment: text('nft_commitment'), updatedAt: integer('updated_at').notNull(),
});

export const orders = sqliteTable('orders', {
  id: text('id').primaryKey(), marketId: text('market_id').notNull().references(() => markets.id),
  makerAddress: text('maker_address').notNull(), makerPubkey: text('maker_pubkey').notNull(),
  side: text('side', { enum: ['BUY', 'SELL'] }).notNull(), outcome: text('outcome', { enum: ['YES', 'NO'] }).notNull(),
  priceSats: integer('price_sats').notNull(), totalShares: integer('total_shares').notNull(), remainingShares: integer('remaining_shares').notNull(),
  utxoTxid: text('utxo_txid').notNull(), utxoVout: integer('utxo_vout').notNull(), utxoSatoshis: integer('utxo_satoshis').notNull(),
  status: text('status', { enum: ['OPEN', 'PARTIAL', 'FILLED', 'CANCELLED'] }).notNull().default('OPEN'), createdAt: integer('created_at').notNull(),
});

export const trades = sqliteTable('trades', {
  id: text('id').primaryKey(), marketId: text('market_id').notNull().references(() => markets.id),
  matchType: text('match_type', { enum: ['DIRECT', 'MINT', 'MERGE'] }).notNull(),
  yesPriceSats: integer('yes_price_sats').notNull(), noPriceSats: integer('no_price_sats').notNull(),
  sharesTraded: integer('shares_traded').notNull(), bchTxid: text('bch_txid').notNull(), executedAt: integer('executed_at').notNull(),
});

export const schema = { markets, vaultUtxos, orders, trades };
