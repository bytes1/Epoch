# Native BCH Prediction Market

Zero-Docker pnpm workspace for a Bitcoin Cash binary market. Runtime persistence uses local SQLite; the frontend package is intentionally only a placeholder.

## Packages

- `packages/contracts`: four CashScript 0.13 covenants, compiler, and generated JSON artifacts.
- `packages/backend`: Fastify API, Drizzle/better-sqlite3 schema, in-process CLOB matcher, per-market UTXO mutex, and WebSocket ticker.
- `packages/frontend`: reserved for the later UI phase.

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

The Chipnet genesis adapter is live, but Chipnet CLOB settlement and resolution broadcast adapters are not yet implemented. Order registration in Chipnet mode cannot settle matched orders, and resolution returns unavailable until those adapters are added. Order registration also validates request fields without proving the supplied outpoint against Electrum. Local tests continue to use mock adapters. CashScript 0.13 has opt-in change-output methods rather than `.withoutChange()` / `.withoutTokenChange()`; covenant builders leave change disabled and require explicit fee/change outputs.
