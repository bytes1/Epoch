import { randomBytes, randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import type { MarketDb } from '../db/index.js';
import { markets, vaultUtxos } from '../db/schema.js';

export type GenesisResult = {
  marketIdHex: string; yesCategoryId: string; noCategoryId: string; vaultCategoryId: string;
  vaultContractAddress: string; txid: string;
};

export interface GenesisAdapter { createMarket(title: string, description: string): Promise<GenesisResult> }

export class MockGenesisAdapter implements GenesisAdapter {
  async createMarket(_title: string, _description: string): Promise<GenesisResult> {
    return {
      marketIdHex: randomBytes(4).toString('hex'), yesCategoryId: randomBytes(32).toString('hex'),
      noCategoryId: randomBytes(32).toString('hex'), vaultCategoryId: randomBytes(32).toString('hex'),
      vaultContractAddress: 'mock:' + randomBytes(20).toString('hex'), txid: randomBytes(32).toString('hex'),
    };
  }
}

export class GenesisService {
  constructor(private readonly db: MarketDb, private readonly adapter: GenesisAdapter = new MockGenesisAdapter()) {}
  async create(title: string, description = '') {
    const result = await this.adapter.createMarket(title, description);
    const id = randomUUID(); const now = Date.now();
    this.db.insert(markets).values({ id, marketIdHex: result.marketIdHex, title, description,
      yesCategoryId: result.yesCategoryId, noCategoryId: result.noCategoryId, vaultCategoryId: result.vaultCategoryId,
      vaultContractAddress: result.vaultContractAddress, createdAt: now }).run();
    const roles = [
      { role: 'VAULT_MASTER' as const, category: result.vaultCategoryId, satoshis: 1000, commitment: '00' },
      { role: 'YES_BATON' as const, category: result.yesCategoryId, satoshis: 1000, commitment: null },
      { role: 'NO_BATON' as const, category: result.noCategoryId, satoshis: 1000, commitment: null },
    ];
    for (const [vout, item] of roles.entries()) this.db.insert(vaultUtxos).values({
      id: randomUUID(), marketId: id, utxoRole: item.role, txid: result.txid, vout, satoshis: item.satoshis,
      tokenCategory: item.category, tokenAmount: 0, nftCapability: item.role === 'VAULT_MASTER' ? 'mutable' : 'minting',
      nftCommitment: item.commitment, updatedAt: now,
    }).run();
    return this.db.select().from(markets).where(eq(markets.id, id)).get()!;
  }
}
