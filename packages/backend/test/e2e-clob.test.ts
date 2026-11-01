import { afterEach, describe, expect, it } from 'vitest';
import { createDatabase } from '../src/db/index.js';
import { createApp } from '../src/index.js';
import { GenesisService } from '../src/services/genesis.service.js';
import { MatcherService } from '../src/services/matcher.service.js';
import { markets, trades } from '../src/db/schema.js';
import { MockResolutionExecutor } from '../src/services/resolution.service.js';
import { encodePrivateKeyWif } from '@bitauth/libauth';

describe('native BCH market API and CLOB persistence', () => {
  const resources: Array<{ close: () => void; app: Awaited<ReturnType<typeof createApp>> }> = [];
  afterEach(async () => { for (const item of resources.splice(0)) { await item.app.close(); item.close(); } });

  it('creates a market and records a complementary mint trade price tick', async () => {
    const handle = createDatabase(':memory:');
    const previousKey = process.env.ORACLE_PRIVATE_KEY;
    const privateKey = new Uint8Array(32); privateKey[31] = 1;
    process.env.ORACLE_PRIVATE_KEY = encodePrivateKeyWif(privateKey, 'testnet');
    const app = await createApp({ db: handle, genesis: new GenesisService(handle.db), resolver: new MockResolutionExecutor() });
    resources.push({ close: handle.close, app });
    const created = await app.inject({ method: 'POST', url: '/api/markets', payload: { title: 'Will BCH cross 1000?' } });
    expect(created.statusCode).toBe(201);
    const market = created.json() as typeof markets.$inferSelect;
    const matcher = new MatcherService(handle.db);
    await matcher.register({ id: 'yes-bid', marketId: market.id, makerAddress: 'addr-a', makerPubkey: '02aa', side: 'BUY', outcome: 'YES',
      priceSats: 600, totalShares: 1, remainingShares: 1, utxoTxid: 'a'.repeat(64), utxoVout: 0, utxoSatoshis: 600, status: 'OPEN', createdAt: 1 });
    await matcher.register({ id: 'no-bid', marketId: market.id, makerAddress: 'addr-b', makerPubkey: '02bb', side: 'BUY', outcome: 'NO',
      priceSats: 400, totalShares: 1, remainingShares: 1, utxoTxid: 'b'.repeat(64), utxoVout: 0, utxoSatoshis: 400, status: 'OPEN', createdAt: 2 });
    const trade = handle.db.select().from(trades).get();
    expect(trade?.matchType).toBe('MINT');
    expect(trade?.yesPriceSats).toBe(600);
    expect(handle.db.select().from(markets).get()?.lastYesPriceSats).toBe(600);
    const resolved = await app.inject({ method: 'POST', url: `/api/markets/${market.id}/resolve`, payload: { outcome: 'YES' } });
    expect(resolved.statusCode, resolved.body).toBe(200);
    expect(resolved.json().signature).toMatch(/^[0-9a-f]+$/i);
    expect(handle.db.select().from(markets).get()?.status).toBe('RESOLVED_YES');
    if (previousKey === undefined) delete process.env.ORACLE_PRIVATE_KEY;
    else process.env.ORACLE_PRIVATE_KEY = previousKey;
  });
});
