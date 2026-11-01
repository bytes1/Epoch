import { afterEach, describe, expect, it } from 'vitest';
import { createDatabase } from '../src/db/index.js';
import { GenesisService } from '../src/services/genesis.service.js';
import { MatcherService } from '../src/services/matcher.service.js';
import { orders, trades } from '../src/db/schema.js';

describe('three-path CLOB matcher', () => {
  const close: Array<() => void> = [];
  afterEach(() => close.splice(0).forEach((fn) => fn()));

  async function setup() {
    const database = createDatabase(':memory:'); close.push(database.close);
    const market = await new GenesisService(database.db).create('Test binary market');
    return { db: database.db, market, matcher: new MatcherService(database.db) };
  }
  const order = (marketId: string, id: string, side: 'BUY' | 'SELL', outcome: 'YES' | 'NO', priceSats: number, shares = 1, createdAt = 1) => ({
    id, marketId, makerAddress: 'mock:' + id, makerPubkey: '02aa', side, outcome, priceSats,
    totalShares: shares, remainingShares: shares, utxoTxid: id.padEnd(64, '0'), utxoVout: 0,
    utxoSatoshis: side === 'BUY' ? priceSats * shares : 1000, status: 'OPEN' as const, createdAt,
  });

  it('matches a same-outcome direct swap without spending the vault', async () => {
    const { db, market, matcher } = await setup();
    await matcher.register(order(market.id, 'bid', 'BUY', 'YES', 650));
    const matches = await matcher.register(order(market.id, 'ask', 'SELL', 'YES', 620, 1, 2));
    expect(matches[0]?.type).toBe('DIRECT');
    expect(db.select().from(trades).get()?.matchType).toBe('DIRECT');
  });

  it('matches complementary sellers through merge and preserves the unfilled remainder', async () => {
    const { db, market, matcher } = await setup();
    await matcher.register(order(market.id, 'yes-seller', 'SELL', 'YES', 440, 2));
    const matches = await matcher.register(order(market.id, 'no-seller', 'SELL', 'NO', 500, 1, 2));
    expect(matches[0]?.type).toBe('MERGE');
    expect(db.select().from(trades).get()?.yesPriceSats).toBe(440);
    expect(db.select().from(orders).all().find((x) => x.id === 'yes-seller')?.remainingShares).toBe(1);
  });
});
