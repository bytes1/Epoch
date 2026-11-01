import './config/load-env.js';
import Fastify from 'fastify';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import cors from '@fastify/cors';
import { createDatabase } from './db/index.js';
import { GenesisService, MockGenesisAdapter } from './services/genesis.service.js';
import { MatcherService, MockMatchExecutor } from './services/matcher.service.js';
import { registerMarketRoutes } from './routes/markets.routes.js';
import { registerOrderRoutes } from './routes/orders.routes.js';
import { TickerHub } from './ws/ticker.ws.js';
import { UnconfiguredMatchExecutor, UnconfiguredResolutionExecutor, type ResolutionExecutor } from './services/resolution.service.js';
import { ChipnetGenesisAdapter } from './services/chipnet.service.js';
import { ChipnetMatchExecutor, ChipnetOrderVerifier, ChipnetResolutionExecutor } from './services/chipnet-live.service.js';

export async function createApp(options: { db?: ReturnType<typeof createDatabase>; genesis?: GenesisService; resolver?: ResolutionExecutor } = {}) {
  const owned = options.db ?? createDatabase();
  const app = Fastify({ logger: true });
  const ticker = new TickerHub();
  await app.register(cors, { origin: process.env.CORS_ORIGIN ?? true });
  const chipnet = process.env.BCH_NETWORK === 'chipnet';
  const genesisService = options.genesis ?? new GenesisService(owned.db, chipnet
    ? (process.env.MARKET_WALLET_PRIVATE_KEY ? new ChipnetGenesisAdapter() : { async createMarket() { throw new Error('Set MARKET_WALLET_PRIVATE_KEY to enable Chipnet market genesis.'); } })
    : new MockGenesisAdapter());
  const chipnetReady = Boolean(process.env.MARKET_WALLET_PRIVATE_KEY && (process.env.ORACLE_PRIVATE_KEY || process.env.MARKET_WALLET_PRIVATE_KEY));
  const matcherExecutor = chipnet ? (chipnetReady ? new ChipnetMatchExecutor(owned.db) : new UnconfiguredMatchExecutor()) : new MockMatchExecutor();
  const matcher = new MatcherService(owned.db, matcherExecutor, (marketId, update) => ticker.publish(marketId, update));
  await ticker.register(app);
  const resolver = options.resolver ?? (chipnet && chipnetReady ? new ChipnetResolutionExecutor(owned.db) : new UnconfiguredResolutionExecutor());
  await registerMarketRoutes(app, owned.db, genesisService, resolver);
  await registerOrderRoutes(app, owned.db, matcher, chipnet ? new ChipnetOrderVerifier() : undefined);
  app.addHook('onClose', async () => { if (!options.db) owned.close(); });
  return app;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const app = await createApp();
  const port = Number(process.env.PORT ?? 3001);
  await app.listen({ port, host: process.env.HOST ?? '127.0.0.1' });
}
