# Outcome frontend

Next.js App Router UI for the BCH prediction market workspace.

## Development

Run from the repository root:

```cmd
pnpm --filter @bch-market/frontend dev
```

The UI reads the Fastify API from `NEXT_PUBLIC_API_URL` (default `http://127.0.0.1:3001`). Copy `.env.example` to `.env.local` if the API runs elsewhere. Keep wallet and oracle WIFs in the backend environment only.

Market pages support order book viewing, order preparation, funding handoff, and registration of the funded BCH output. The wallet payment itself is made in the user's Chipnet wallet.
