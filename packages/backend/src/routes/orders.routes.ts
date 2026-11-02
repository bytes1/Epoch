import { createHash, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { Contract, MockNetworkProvider } from 'cashscript';
import { and, eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { MarketDb } from '../db/index.js';
import { markets, orders } from '../db/schema.js';
import { MatcherService } from '../services/matcher.service.js';
import { categoryIdVmBytes } from '../utils/cashtokens.js';

export interface OrderVerifier {
  verify(input: { market: typeof markets.$inferSelect; side: 'BUY' | 'SELL'; outcome: 'YES' | 'NO'; makerPubKey: string; utxoTxid: string;
    utxoVout: number; utxoSatoshis: number; tokenCategory?: string; tokenAmount?: number; priceSats: number; shares: number }): Promise<void>;
}

const MAX_SAFE_SHARES = Math.floor(Number.MAX_SAFE_INTEGER / 1000);
const prepareSchema = z.object({ marketId: z.string(), side: z.enum(['BUY', 'SELL']), outcome: z.enum(['YES', 'NO']),
  priceSats: z.number().int().min(1).max(999), shares: z.number().int().positive().max(MAX_SAFE_SHARES), makerPubKey: z.string().regex(/^(02|03)[0-9a-f]{64}$/i) });
const registerSchema = prepareSchema.extend({ makerAddress: z.string().min(2), utxoTxid: z.string().regex(/^[0-9a-f]{64}$/i),
  utxoVout: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER), utxoSatoshis: z.number().int().positive().max(Number.MAX_SAFE_INTEGER), tokenCategory: z.string().optional(), tokenAmount: z.number().int().nonnegative().max(MAX_SAFE_SHARES).optional() });

export async function registerOrderRoutes(app: FastifyInstance, db: MarketDb, matcher: MatcherService, verifier?: OrderVerifier) {
  app.post('/api/orders/prepare', async (request, reply) => {
    const parsed = prepareSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.flatten() });
    const input = parsed.data;
    const market = db.select().from(markets).where(eq(markets.id, input.marketId)).get();
    if (!market) return reply.code(404).send({ error: 'Market not found' });
    if (market.status !== 'OPEN') return reply.code(409).send({ error: 'Market is closed' });
    const requiredSatoshis = input.side === 'BUY' ? input.priceSats * input.shares + 1000 : 1000;
    const pubkeyHash = createHash('ripemd160').update(createHash('sha256').update(Buffer.from(input.makerPubKey, 'hex')).digest()).digest('hex');
    const p2pkhBytecode = '76a914' + pubkeyHash + '88ac';
    const makerLockingBytecodeHash = createHash('ripemd160').update(createHash('sha256').update(Buffer.from(p2pkhBytecode, 'hex')).digest()).digest('hex');
    const contractName = input.side === 'BUY' ? 'BuyOrder' : 'SellOrder';
    const artifact = JSON.parse(readFileSync(new URL('../../../contracts/artifacts/' + contractName + '.json', import.meta.url), 'utf8'));
    const contract = new Contract(artifact, [input.makerPubKey, makerLockingBytecodeHash,
      categoryIdVmBytes(input.outcome === 'YES' ? market.yesCategoryId : market.noCategoryId), BigInt(input.priceSats)], { provider: new MockNetworkProvider() });
    return { contract: contractName, address: input.side === 'SELL' ? contract.tokenAddress : contract.address,
      requiredSatoshis, requiredTokenCategory: input.side === 'SELL' ? (input.outcome === 'YES' ? market.yesCategoryId : market.noCategoryId) : null,
      requiredTokenAmount: input.side === 'SELL' ? input.shares : 0,
      makerLockingBytecodeHash, constructorArgs: [input.makerPubKey, makerLockingBytecodeHash,
        input.outcome === 'YES' ? market.yesCategoryId : market.noCategoryId, input.priceSats] };
  });

  app.post('/api/orders/register', async (request, reply) => {
    const parsed = registerSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.flatten() });
    const input = parsed.data;
    const market = db.select().from(markets).where(eq(markets.id, input.marketId)).get();
    if (!market) return reply.code(404).send({ error: 'Market not found' });
    if (market.status !== 'OPEN') return reply.code(409).send({ error: 'Market is closed' });
    const alreadyRegistered = db.select().from(orders).where(and(eq(orders.utxoTxid, input.utxoTxid), eq(orders.utxoVout, input.utxoVout))).get();
    if (alreadyRegistered) return reply.code(409).send({ error: 'This UTXO is already registered as an order.' });
    const expectedCategory = input.outcome === 'YES' ? market.yesCategoryId : market.noCategoryId;
    const expectedSats = input.side === 'BUY' ? input.shares * input.priceSats + 1000 : 1000;
    if (input.side === 'BUY' && input.utxoSatoshis !== expectedSats) return reply.code(400).send({ error: 'Buy order UTXO must contain exactly bid × shares plus 1,000 sats.' });
    if (input.side === 'SELL' && input.utxoSatoshis !== 1000) return reply.code(400).send({ error: 'Sell order UTXO must contain exactly 1,000 sats.' });
    if (input.side === 'SELL' && (input.tokenCategory !== expectedCategory || input.tokenAmount !== input.shares))
      return reply.code(400).send({ error: 'Order UTXO does not contain the required outcome tokens' });
    if (verifier) {
      try { await verifier.verify({ market, side: input.side, outcome: input.outcome, makerPubKey: input.makerPubKey, utxoTxid: input.utxoTxid,
        utxoVout: input.utxoVout, utxoSatoshis: input.utxoSatoshis, tokenCategory: input.tokenCategory, tokenAmount: input.tokenAmount,
        priceSats: input.priceSats, shares: input.shares }); }
      catch (error) { return reply.code(400).send({ error: error instanceof Error ? error.message : 'Order UTXO verification failed' }); }
    }
    const id = randomUUID();
    const matches = await matcher.register({ id, marketId: input.marketId, makerAddress: input.makerAddress, makerPubkey: input.makerPubKey,
      side: input.side, outcome: input.outcome, priceSats: input.priceSats, totalShares: input.shares, remainingShares: input.shares,
      utxoTxid: input.utxoTxid, utxoVout: input.utxoVout, utxoSatoshis: input.utxoSatoshis, status: 'OPEN', createdAt: Date.now() });
    return reply.code(201).send({ orderId: id, matches });
  });
}
