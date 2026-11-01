import { randomUUID } from 'node:crypto';
import { and, eq, inArray, sql } from 'drizzle-orm';
import type { MarketDb } from '../db/index.js';
import { markets, orders, trades } from '../db/schema.js';
import { marketMutex } from './utxo-queue.service.js';

export type RegisteredOrder = typeof orders.$inferInsert;
export type MatchType = 'DIRECT' | 'MINT' | 'MERGE';
export type BookOrder = typeof orders.$inferSelect;
export interface MatchExecutor { execute(marketId: string, kind: MatchType, shares: number, matchedOrders: [BookOrder, BookOrder]): Promise<string> }
export class MockMatchExecutor implements MatchExecutor {
  async execute(_marketId: string, _kind: MatchType, _shares: number, _matchedOrders: [BookOrder, BookOrder]) { return randomUUID().replaceAll('-', ''); }
}

/** Price-time matching with serialized vault-backed mint/merge execution. */
export class MatcherService {
  constructor(private readonly db: MarketDb, private readonly executor: MatchExecutor = new MockMatchExecutor(),
    private readonly publish: (marketId: string, update: unknown) => void = () => {}) {}

  async register(order: RegisteredOrder) {
    this.db.insert(orders).values(order).run();
    return this.match(order.marketId);
  }

  async match(marketId: string) {
    const result = [] as Array<{ type: MatchType; shares: number; txid: string }>;
    while (true) {
      const open = this.db.select().from(orders).where(and(eq(orders.marketId, marketId), inArray(orders.status, ['OPEN', 'PARTIAL']))).all();
      const next = this.findMatch(open);
      if (!next) break;
      const run = async () => {
        const txid = await this.executor.execute(marketId, next.type, next.shares, [next.a, next.b]);
        const yesPrice = next.a.outcome === 'YES' ? this.tradePrice(next.a, next.b) : 1000 - this.tradePrice(next.a, next.b);
        const noPrice = 1000 - yesPrice;
        this.db.transaction(() => {
          for (const order of [next.a, next.b]) {
            const left = order.remainingShares - next.shares;
            const continuationVout = left === 0 ? undefined : this.continuationVout(next.type, order);
            const remainingSatoshis = order.side === 'BUY'
              ? order.utxoSatoshis - next.shares * order.priceSats
              : Math.max(1000, order.utxoSatoshis);
            this.db.update(orders).set({ remainingShares: left, status: left === 0 ? 'FILLED' : 'PARTIAL',
              ...(continuationVout === undefined ? {} : { utxoTxid: txid, utxoVout: continuationVout, utxoSatoshis: remainingSatoshis }) })
              .where(eq(orders.id, order.id)).run();
          }
          this.db.insert(trades).values({ id: randomUUID(), marketId, matchType: next.type, yesPriceSats: yesPrice,
            noPriceSats: noPrice, sharesTraded: next.shares, bchTxid: txid, executedAt: Date.now() }).run();
          this.db.update(markets).set({ lastYesPriceSats: yesPrice, lastNoPriceSats: noPrice,
            volumeSats: sql`${markets.volumeSats} + ${next.shares * 1000}` }).where(eq(markets.id, marketId)).run();
        });
        const update = { type: next.type, shares: next.shares, yesPriceSats: yesPrice, noPriceSats: noPrice, txid };
        this.publish(marketId, update);
        result.push({ type: next.type, shares: next.shares, txid });
      };
      if (next.type === 'DIRECT') await run();
      else await marketMutex.runExclusive(marketId, run);
    }
    return result;
  }

  private continuationVout(type: MatchType, order: BookOrder) {
    if (type === 'DIRECT') return order.side === 'BUY' ? 2 : 3;
    if (type === 'MINT') return order.outcome === 'YES' ? 5 : 6;
    return order.outcome === 'YES' ? 3 : 4;
  }

  private findMatch(rows: Array<typeof orders.$inferSelect>) {
    const candidates = rows.filter((row) => row.remainingShares > 0);
    const buys = candidates.filter((x) => x.side === 'BUY').sort((a, b) => b.priceSats - a.priceSats || a.createdAt - b.createdAt);
    const sells = candidates.filter((x) => x.side === 'SELL').sort((a, b) => a.priceSats - b.priceSats || a.createdAt - b.createdAt);
    for (const bid of buys) {
      for (const ask of sells) if (bid.outcome === ask.outcome && bid.priceSats >= ask.priceSats)
        return { type: 'DIRECT' as const, a: bid, b: ask, shares: Math.min(bid.remainingShares, ask.remainingShares) };
    }
    for (const yes of buys.filter((x) => x.outcome === 'YES')) for (const no of buys.filter((x) => x.outcome === 'NO'))
      if (yes.priceSats + no.priceSats >= 1000) return { type: 'MINT' as const, a: yes, b: no, shares: Math.min(yes.remainingShares, no.remainingShares) };
    const yesAsks = sells.filter((x) => x.outcome === 'YES'); const noAsks = sells.filter((x) => x.outcome === 'NO');
    for (const yes of yesAsks) for (const no of noAsks)
      if (yes.priceSats + no.priceSats <= 1000) return { type: 'MERGE' as const, a: yes, b: no, shares: Math.min(yes.remainingShares, no.remainingShares) };
    return undefined;
  }

  private tradePrice(a: typeof orders.$inferSelect, b: typeof orders.$inferSelect) {
    if (a.outcome === 'YES' && b.outcome === 'NO') return a.priceSats;
    if (a.outcome === 'NO' && b.outcome === 'YES') return 1000 - a.priceSats;
    if (a.outcome === 'YES') return a.side === 'BUY' ? b.priceSats : a.priceSats;
    return 1000 - (a.side === 'BUY' ? b.priceSats : a.priceSats);
  }
}
