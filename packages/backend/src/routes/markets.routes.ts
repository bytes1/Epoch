import { and, asc, eq, inArray } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { MarketDb } from '../db/index.js';
import { markets, orders, trades } from '../db/schema.js';
import { GenesisService } from '../services/genesis.service.js';
import { marketMutex } from '../services/utxo-queue.service.js';
import { signResolution } from '../services/oracle.service.js';
import { UnconfiguredResolutionExecutor, type ResolutionExecutor } from '../services/resolution.service.js';

const createMarket = z.object({ title: z.string().min(3).max(200), description: z.string().max(5000).optional() });

export async function registerMarketRoutes(app: FastifyInstance, db: MarketDb, genesis: GenesisService,
  resolver: ResolutionExecutor = new UnconfiguredResolutionExecutor()) {
  app.post('/api/markets', async (request, reply) => {
    if (process.env.ADMIN_API_KEY && request.headers['x-admin-key'] !== process.env.ADMIN_API_KEY) return reply.code(401).send({ error: 'Unauthorized' });
    const parsed = createMarket.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.flatten() });
    return reply.code(201).send(await genesis.create(parsed.data.title, parsed.data.description));
  });

  app.get('/api/markets', async () => db.select().from(markets).all().map((m) => ({
    ...m, yesProbabilityPercent: m.lastYesPriceSats / 10, noProbabilityPercent: m.lastNoPriceSats / 10,
  })));

  app.get('/api/markets/:id/orderbook', async (request, reply) => {
    const { id } = request.params as { id: string };
    const market = db.select().from(markets).where(eq(markets.id, id)).get();
    if (!market) return reply.code(404).send({ error: 'Market not found' });
    const rows = db.select().from(orders).where(and(eq(orders.marketId, id), inArray(orders.status, ['OPEN', 'PARTIAL']))).all();
    const group = (side: 'BUY' | 'SELL', outcome: 'YES' | 'NO') => {
      const grouped = new Map<number, number>();
      for (const order of rows.filter((x) => x.side === side && x.outcome === outcome))
        grouped.set(order.priceSats, (grouped.get(order.priceSats) ?? 0) + order.remainingShares);
      return [...grouped].map(([priceSats, shares]) => ({ priceSats, shares }))
        .sort((a, b) => side === 'BUY' ? b.priceSats - a.priceSats : a.priceSats - b.priceSats);
    };
    return { yes: { bids: group('BUY', 'YES'), asks: group('SELL', 'YES') }, no: { bids: group('BUY', 'NO'), asks: group('SELL', 'NO') },
      ticks: db.select().from(trades).where(eq(trades.marketId, id)).orderBy(asc(trades.executedAt)).all() };
  });

  app.post('/api/markets/:id/resolve', async (request, reply) => {
    if (process.env.ADMIN_API_KEY && request.headers['x-admin-key'] !== process.env.ADMIN_API_KEY) return reply.code(401).send({ error: 'Unauthorized' });
    const { id } = request.params as { id: string };
    const parsed = z.object({ outcome: z.enum(['YES', 'NO']) }).safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.flatten() });
    const market = db.select().from(markets).where(eq(markets.id, id)).get();
    if (!market) return reply.code(404).send({ error: 'Market not found' });
    if (market.status !== 'OPEN') return reply.code(409).send({ error: 'Market already resolved' });
    const oracleWif = process.env.ORACLE_PRIVATE_KEY || process.env.MARKET_WALLET_PRIVATE_KEY;
    if (!oracleWif) return reply.code(503).send({ error: 'Set ORACLE_PRIVATE_KEY or MARKET_WALLET_PRIVATE_KEY in .env to authorize resolution.' });
    const run = async () => {
      const status = parsed.data.outcome === 'YES' ? 'RESOLVED_YES' : 'RESOLVED_NO';
      let signature: string;
      try { signature = signResolution(market.marketIdHex, parsed.data.outcome, oracleWif); }
      catch (error) { return reply.code(400).send({ error: error instanceof Error ? error.message : 'Oracle signing failed' }); }
      let txid: string;
      try { txid = await resolver.resolve(market, parsed.data.outcome, signature); }
      catch (error) { return reply.code(503).send({ error: error instanceof Error ? error.message : 'Resolution transaction failed' }); }
      db.update(markets).set({ status, resolvedAt: Date.now() }).where(eq(markets.id, id)).run();
      return { marketId: market.marketIdHex, outcome: parsed.data.outcome, status, signature, txid };
    };
    return marketMutex.runExclusive(id, run);
  });
}
