# Native BCH Prediction Market

Zero-Docker pnpm workspace for a Bitcoin Cash binary market. Runtime persistence uses local SQLite.

## Packages

- `packages/contracts`: four CashScript 0.13 covenants, compiler, and generated JSON artifacts.
- `packages/backend`: Fastify API, Drizzle/better-sqlite3 schema, in-process CLOB matcher, per-market UTXO mutex, and WebSocket ticker.
- `packages/frontend`: Next.js App Router UI for markets and order placement.

## Commands

Use Node.js 22+ and pnpm 10. Install dependencies, compile artifacts, then run:

```sh
pnpm install
pnpm contracts:compile
pnpm build
pnpm test
```

Run the API with `pnpm --filter @bch-market/backend dev`. It listens on `127.0.0.1:3001` by default and creates `packages/backend/data/market.db` with WAL enabled. Set `DATABASE_PATH=:memory:` for ephemeral use. `ADMIN_API_KEY` protects market creation and resolution when configured; `ORACLE_PRIVATE_KEY` must contain a BCH WIF for resolution signing.

## Chipnet funding and market creation

The default network is mocknet. Copy `.env.example` to `.env`. To create a dedicated Chipnet key locally, run `pnpm chipnet:wallet:create` in your terminal. It prints a `bchtest:` funding address and its WIF; back up the WIF offline and never share or commit it. Put the WIF in `.env` as `MARKET_WALLET_PRIVATE_KEY`, then fund the address with at least 6,000 sats of native BCH. Set `BCH_NETWORK=chipnet` in `.env`, start the backend, then call `POST /api/markets`. The backend broadcasts three category-seeding transactions followed by the atomic vault/YES-baton/NO-baton genesis bundle and returns the market's Chipnet vault address and transaction ID. The `.env` file is git-ignored.

Chipnet mode supports market genesis, Electrum-backed order verification, CLOB matching, and resolution broadcast. The backend uses wallet 1 for market operations, matching fees, and resolution.

### Second Chipnet test wallet

Wallet 1 (`MARKET_WALLET_PRIVATE_KEY`) remains the operational market and settlement wallet. To create a separate maker/test wallet, run `pnpm --filter @bch-market/backend chipnet:wallet:create -- --wallet2`, then add its WIF to the repository-root `.env` as `MARKET_WALLET_PRIVATE_KEY_2`. The WIF is secret; do not commit it or put it in the frontend.

Use `pnpm --filter @bch-market/backend chipnet:address -- --wallet2` and `pnpm --filter @bch-market/backend chipnet:pubkey -- --wallet2` to get wallet 2's address and public key. The funding scripts accept `--wallet2` to spend from that key. This selection only applies to the CLI helpers; market genesis, matching fees, and resolution continue to use wallet 1. Fund wallet 2 with Chipnet BCH before using the order funding scripts.

Check CashToken balances with `pnpm --filter @bch-market/backend chipnet:balance -- --wallet2 --category <64-character-category-id>`.
