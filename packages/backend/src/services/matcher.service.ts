import { randomUUID } from 'node:crypto';
import { and, eq, inArray, sql } from 'drizzle-orm';
import type { MarketDb } from '../db/index.js';
import { markets, orders, trades } from '../db/schema.js';
import { marketMutex } from './utxo-queue.service.js';

const BCH_DUST_LIMIT_SATS = 546;

export type RegisteredOrder = typeof orders.$inferInsert;
export type MatchType = 'DIRECT' | 'MINT' | 'MERGE';
export type BookOrder = typeof orders.$inferSelect;
export interface MatchExecutor {
  execute(marketId: string, kind: MatchType, shares: number, matchedOrders: [BookOrder, BookOrder]): Promise<string>;
  isOrderLive?(order: BookOrder): Promise<boolean>;
}
export class MockMatchExecutor implements MatchExecutor {
  async execute(_marketId: string, _kind: MatchType, _shares: number, _matchedOrders: [BookOrder, BookOrder]) { return randomUUID().replaceAll('-', ''); }
}

/** YES-side execution price under price-time priority. */
export function yesExecutionPrice(kind: MatchType, a: BookOrder, b: BookOrder) {
  if (kind === 'MINT') {
    const yes = a.outcome === 'YES' ? a : b;
    const no = a.outcome === 'NO' ? a : b;
    const maker = a.createdAt <= b.createdAt ? a : b;
    return maker.outcome === 'YES' ? yes.priceSats : 1000 - no.priceSats;
  }
  if (kind === 'MERGE') {
    const maker = a.createdAt <= b.createdAt ? a : b;
    return maker.outcome === 'YES' ? maker.priceSats : 1000 - maker.priceSats;
  }
  const maker = a.createdAt <= b.createdAt ? a : b;
  return maker.outcome === 'YES' ? maker.priceSats : 1000 - maker.priceSats;
}

export function continuationVout(type: MatchType, order: BookOrder) {
  if (type === 'DIRECT') return order.side === 'BUY' ? 2 : 3;
  if (type === 'MINT') return order.outcome === 'YES' ? 5 : 6;
  return order.outcome === 'YES' ? 3 : 4;
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
    return marketMutex.runExclusive(marketId, async () => {
      const result = [] as Array<{ type: MatchType; shares: number; txid: string }>;
      while (true) {
        const open = this.db.select().from(orders).where(and(eq(orders.marketId, marketId), inArray(orders.status, ['OPEN', 'PARTIAL']))).all();
        const next = this.findMatch(open);
        if (!next) break;
        let txid: string;
        try {
          txid = await this.executor.execute(marketId, next.type, next.shares, [next.a, next.b]);
        } catch (error) {
          if (!this.executor.isOrderLive) throw error;
          let live: boolean[];
          try {
            live = await Promise.all([next.a, next.b].map((order) => this.executor.isOrderLive!(order)));
          } catch {
            throw error;
          }
          const staleOrders = [next.a, next.b].filter((_order, index) => !live[index]);
          if (staleOrders.length === 0) throw error;
          for (const stale of staleOrders) {
            this.db.update(orders).set({ status: 'CANCELLED' })
              .where(and(eq(orders.id, stale.id), inArray(orders.status, ['OPEN', 'PARTIAL']))).run();
          }
          continue;
        }
        const yesPrice = yesExecutionPrice(next.type, next.a, next.b);
        const noPrice = 1000 - yesPrice;
        this.db.transaction(() => {
          for (const order of [next.a, next.b]) {
            const left = order.remainingShares - next.shares;
            const continuationOutput = left === 0 ? undefined : continuationVout(next.type, order);
            const remainingSatoshis = order.side === 'BUY'
              ? order.utxoSatoshis - next.shares * order.priceSats
              : Math.max(1000, order.utxoSatoshis);
            this.db.update(orders).set({ remainingShares: left, status: left === 0 ? 'FILLED' : 'PARTIAL',
              ...(continuationOutput === undefined ? {} : { utxoTxid: txid, utxoVout: continuationOutput, utxoSatoshis: remainingSatoshis }) })
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
      }
      return result;
    });
  }

  private findMatch(rows: Array<typeof orders.$inferSelect>) {
    const candidates = rows.filter((row) => row.remainingShares > 0);
    const buys = candidates.filter((x) => x.side === 'BUY').sort((a, b) => b.priceSats - a.priceSats || a.createdAt - b.createdAt);
    const sells = candidates.filter((x) => x.side === 'SELL').sort((a, b) => a.priceSats - b.priceSats || a.createdAt - b.createdAt);
    for (const bid of buys) {
      for (const ask of sells) if (bid.outcome === ask.outcome && bid.priceSats >= ask.priceSats)
        // Direct settlement pays the seller in native BCH; only reject matches
        // whose seller payout would be below the BCH P2PKH dust limit.
        if (Math.min(bid.remainingShares, ask.remainingShares) * ask.priceSats >= BCH_DUST_LIMIT_SATS)
          return { type: 'DIRECT' as const, a: bid, b: ask, shares: Math.min(bid.remainingShares, ask.remainingShares) };
    }
    for (const yes of buys.filter((x) => x.outcome === 'YES')) for (const no of buys.filter((x) => x.outcome === 'NO')) {
      if (yes.priceSats + no.priceSats >= 1000) return { type: 'MINT' as const, a: yes, b: no, shares: Math.min(yes.remainingShares, no.remainingShares) };
    }
    const yesAsks = sells.filter((x) => x.outcome === 'YES'); const noAsks = sells.filter((x) => x.outcome === 'NO');
    for (const yes of yesAsks) for (const no of noAsks) {
      const shares = Math.min(yes.remainingShares, no.remainingShares);
      if (yes.priceSats + no.priceSats <= 1000 && shares * yes.priceSats >= 1000 && shares * no.priceSats >= 1000)
        return { type: 'MERGE' as const, a: yes, b: no, shares };
    }
    return undefined;
  }

}
