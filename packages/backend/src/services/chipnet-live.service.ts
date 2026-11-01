import { createHash, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { and, eq } from 'drizzle-orm';
import { Contract, ElectrumNetworkProvider, SignatureTemplate, TransactionBuilder, type Utxo } from 'cashscript';
import { decodePrivateKeyWif, publicKeyToP2pkhCashAddress, secp256k1 } from '@bitauth/libauth';
import type { MarketDb } from '../db/index.js';
import { markets, orders, vaultUtxos } from '../db/schema.js';
import type { BookOrder, MatchExecutor, MatchType } from './matcher.service.js';
import type { ResolutionExecutor } from './resolution.service.js';
import type { OrderVerifier } from '../routes/orders.routes.js';
import { decodeChipnetWallet, chipnetFundingAddress } from './chipnet.service.js';

const artifact = (name: string) => JSON.parse(readFileSync(new URL('../../../contracts/artifacts/' + name + '.json', import.meta.url), 'utf8'));
const hash160 = (bytes: Uint8Array) => createHash('ripemd160').update(createHash('sha256').update(bytes).digest()).digest('hex');
const toHex = (value: string | Uint8Array) => typeof value === 'string' ? value : Buffer.from(value).toString('hex');

export function makerTokenAddress(pubkeyHex: string) {
  const result = publicKeyToP2pkhCashAddress({ publicKey: Buffer.from(pubkeyHex, 'hex'), prefix: 'bchtest', tokenSupport: true });
  if (typeof result === 'string') throw new Error('Could not derive maker address: ' + result);
  return result.address;
}

function orderContract(order: BookOrder, market: typeof markets.$inferSelect, provider: ElectrumNetworkProvider) {
  const contractName = order.side === 'BUY' ? 'BuyOrder' : 'SellOrder';
  const pubkey = Buffer.from(order.makerPubkey, 'hex');
  const p2pkh = Buffer.from('76a914' + hash160(pubkey) + '88ac', 'hex');
  const args = [order.makerPubkey, hash160(p2pkh), order.outcome === 'YES' ? market.yesCategoryId : market.noCategoryId, BigInt(order.priceSats)];
  return new Contract(artifact(contractName), args, { provider });
}

export class ChipnetOrderVerifier implements OrderVerifier {
  private readonly provider = new ElectrumNetworkProvider('chipnet');
  async verify(input: { market: typeof markets.$inferSelect; side: 'BUY' | 'SELL'; outcome: 'YES' | 'NO'; makerPubKey: string; utxoTxid: string; utxoVout: number; utxoSatoshis: number; tokenCategory?: string; tokenAmount?: number; priceSats: number; shares: number }) {
    const token = input.outcome === 'YES' ? input.market.yesCategoryId : input.market.noCategoryId;
    const order = { makerPubkey: input.makerPubKey, side: input.side, outcome: input.outcome, priceSats: input.priceSats } as BookOrder;
    const contract = orderContract(order, input.market, this.provider);
    const address = input.side === 'SELL' ? contract.tokenAddress : contract.address;
    const utxo = (await this.provider.getUtxos(address)).find((x) => x.txid.toLowerCase() === input.utxoTxid.toLowerCase() && x.vout === input.utxoVout);
    if (!utxo) throw new Error('The submitted order outpoint is not an unspent output of its order contract.');
    if (Number(utxo.satoshis) !== input.utxoSatoshis) throw new Error('Submitted BCH amount does not match the on-chain order UTXO.');
    if (input.side === 'BUY') {
      if (utxo.token || utxo.satoshis !== BigInt(input.priceSats * input.shares + 1000)) throw new Error('Buy order UTXO must contain exactly bid × shares plus 1,000 sats.');
    } else if (!utxo.token || utxo.token.category.toLowerCase() !== token.toLowerCase() || utxo.token.amount !== BigInt(input.shares)) {
      throw new Error('Sell order UTXO must contain the exact outcome category and share amount.');
    }
  }
}

export class ChipnetMatchExecutor implements MatchExecutor {
  private readonly provider = new ElectrumNetworkProvider('chipnet');
  private readonly privateKey = decodeChipnetWallet();
  private readonly signer = new SignatureTemplate(this.privateKey);
  private readonly walletAddress = chipnetFundingAddress(this.privateKey);
  private readonly oraclePubkey: Uint8Array;

  constructor(private readonly db: MarketDb) {
    const decoded = decodePrivateKeyWif(process.env.ORACLE_PRIVATE_KEY || process.env.MARKET_WALLET_PRIVATE_KEY!);
    if (typeof decoded === 'string') throw new Error('Invalid oracle WIF: ' + decoded);
    const pubkey = secp256k1.derivePublicKeyCompressed(decoded.privateKey);
    if (typeof pubkey === 'string') throw new Error('Could not derive oracle public key: ' + pubkey);
    this.oraclePubkey = pubkey;
  }

  async execute(marketId: string, kind: MatchType, shares: number, matched: [BookOrder, BookOrder]) {
    const market = this.db.select().from(markets).where(eq(markets.id, marketId)).get();
    if (!market) throw new Error('Market not found');
    const a = matched[0]; const b = matched[1];
    if (kind === 'DIRECT') return this.direct(market, shares, a, b);
    if (kind === 'MINT') return this.mint(market, shares, a, b);
    return this.merge(market, shares, a, b);
  }

  private async liveOrder(order: BookOrder, market: typeof markets.$inferSelect) {
    const contract = orderContract(order, market, this.provider);
    const address = order.side === 'SELL' ? contract.tokenAddress : contract.address;
    const utxo = (await this.provider.getUtxos(address)).find((x) => x.txid.toLowerCase() === order.utxoTxid.toLowerCase() && x.vout === order.utxoVout);
    if (!utxo) throw new Error(`Order ${order.id} UTXO is no longer unspent; refresh or cancel the order.`);
    const tokenCategory = order.outcome === 'YES' ? market.yesCategoryId : market.noCategoryId;
    if (order.side === 'BUY' && (utxo.token || utxo.satoshis !== BigInt(order.remainingShares * order.priceSats + 1000)))
      throw new Error(`Buy order ${order.id} does not have the exact remaining BCH collateral.`);
    if (order.side === 'SELL' && (!utxo.token || utxo.token.category.toLowerCase() !== tokenCategory.toLowerCase() || utxo.token.amount !== BigInt(order.remainingShares)))
      throw new Error(`Order ${order.id} token UTXO no longer contains its remaining shares.`);
    return { contract, utxo };
  }

  private async feeInput() {
    const candidates = (await this.provider.getUtxos(this.walletAddress)).filter((u) => !u.token && u.satoshis >= 5000n)
      .sort((x, y) => Number(y.satoshis - x.satoshis));
    if (!candidates[0]) throw new Error('Chipnet match requires a native BCH wallet UTXO of at least 5,000 sats to pay the transaction fee.');
    return candidates[0];
  }

  private payout(order: BookOrder) { return makerTokenAddress(order.makerPubkey); }
  private async direct(market: typeof markets.$inferSelect, shares: number, a: BookOrder, b: BookOrder) {
    const buy = a.side === 'BUY' ? a : b; const sell = a.side === 'SELL' ? a : b;
    const [{ contract: buyContract, utxo: buyUtxo }, { contract: sellContract, utxo: sellUtxo }, fee] = await Promise.all([
      this.liveOrder(buy, market), this.liveOrder(sell, market), this.feeInput(),
    ]);
    const category = buy.outcome === 'YES' ? market.yesCategoryId : market.noCategoryId;
    const tx = new TransactionBuilder({ provider: this.provider, maximumFeeSatoshis: 20_000n });
    tx.addInput(buyUtxo, (buyContract.unlock as any).fill(BigInt(shares)));
    tx.addInput(sellUtxo, (sellContract.unlock as any).fill(BigInt(shares)));
    tx.addInput(fee, this.signer.unlockP2PKH());
    tx.addOutput({ to: this.payout(buy), amount: 1000n, token: { category, amount: BigInt(shares) } });
    tx.addOutput({ to: this.payout(sell), amount: BigInt(shares * sell.priceSats) });
    const buyLeft = buy.remainingShares - shares;
    if (buyLeft > 0) tx.addOutput({ to: buyContract.address, amount: buyUtxo.satoshis - BigInt(shares * buy.priceSats) });
    const sellLeft = sell.remainingShares - shares;
    if (sellLeft > 0 && buyLeft === 0) tx.addOutput({ to: this.walletAddress, amount: 1000n });
    if (sellLeft > 0) tx.addOutput({ to: sellContract.tokenAddress, amount: 1000n, token: { category, amount: BigInt(sellLeft) } });
    tx.addBchChangeOutputIfNeeded({ to: this.walletAddress, feeRate: 1 });
    return (await tx.send()).txid;
  }

  private async vaultState(marketId: string, roles: Array<'VAULT_MASTER' | 'YES_BATON' | 'NO_BATON'>) {
    const rows = this.db.select().from(vaultUtxos).where(eq(vaultUtxos.marketId, marketId)).all();
    const byRole = new Map(rows.map((row) => [row.utxoRole, row]));
    const selected = roles.map((role) => { const row = byRole.get(role); if (!row) throw new Error(`Missing ${role} UTXO state.`); return row; });
    const utxos: Utxo[] = [];
    for (const row of selected) {
      // Querying by the transaction outpoint avoids relying on stale DB state; the covenant address is checked by CashScript.
      const contract = this.db.select().from(markets).where(eq(markets.id, marketId)).get()!;
      const vaultContract = this.vaultContract(contract);
      const baton = new Contract(artifact('MintingBaton'), [hash160(Buffer.from(vaultContract.lockingBytecode, 'hex'))], { provider: this.provider });
      const address = row.utxoRole === 'VAULT_MASTER' ? vaultContract.tokenAddress : baton.tokenAddress;
      const found = (await this.provider.getUtxos(address)).find((u) => u.txid.toLowerCase() === row.txid.toLowerCase() && u.vout === row.vout);
      if (!found) throw new Error(`${row.utxoRole} UTXO is no longer unspent; settlement cannot proceed.`);
      utxos.push(found);
    }
    return { rows: selected, utxos };
  }

  private vaultContract(market: typeof markets.$inferSelect) {
    return new Contract(artifact('MarketVault'), [market.yesCategoryId, market.noCategoryId, this.oraclePubkey, market.marketIdHex], { provider: this.provider });
  }
  private batonContract(market: typeof markets.$inferSelect) { return new Contract(artifact('MintingBaton'), [hash160(Buffer.from(this.vaultContract(market).lockingBytecode, 'hex'))], { provider: this.provider }); }
  private async mint(market: typeof markets.$inferSelect, shares: number, a: BookOrder, b: BookOrder) {
    const yes = a.outcome === 'YES' ? a : b; const no = a.outcome === 'NO' ? a : b;
    const [{ rows, utxos }, yesLive, noLive, fee] = await Promise.all([
      this.vaultState(market.id, ['VAULT_MASTER', 'YES_BATON', 'NO_BATON']), this.liveOrder(yes, market), this.liveOrder(no, market), this.feeInput(),
    ]);
    const vault = this.vaultContract(market); const baton = this.batonContract(market);
    const tx = new TransactionBuilder({ provider: this.provider, maximumFeeSatoshis: 30_000n });
    tx.addInput(utxos[0]!, (vault.unlock as any).mintCompleteSet(BigInt(shares)));
    tx.addInput(utxos[1]!, (baton.unlock as any).preserve()); tx.addInput(utxos[2]!, (baton.unlock as any).preserve());
    tx.addInput(yesLive.utxo, (yesLive.contract.unlock as any).fill(BigInt(shares)));
    tx.addInput(noLive.utxo, (noLive.contract.unlock as any).fill(BigInt(shares)));
    tx.addInput(fee, this.signer.unlockP2PKH());
    tx.addOutputs([
      { to: vault.tokenAddress, amount: utxos[0]!.satoshis + BigInt(shares * 1000), token: { category: market.vaultCategoryId, amount: 0n, nft: { capability: 'mutable', commitment: '00' } } },
      { to: baton.tokenAddress, amount: utxos[1]!.satoshis, token: { category: market.yesCategoryId, amount: 0n, nft: { capability: 'minting', commitment: '' } } },
      { to: baton.tokenAddress, amount: utxos[2]!.satoshis, token: { category: market.noCategoryId, amount: 0n, nft: { capability: 'minting', commitment: '' } } },
      { to: this.payout(yes), amount: 1000n, token: { category: market.yesCategoryId, amount: BigInt(shares) } },
      { to: this.payout(no), amount: 1000n, token: { category: market.noCategoryId, amount: BigInt(shares) } },
    ]);
    const yesLeft = yes.remainingShares > shares;
    const noLeft = no.remainingShares > shares;
    if (yesLeft) tx.addOutput({ to: yesLive.contract.address, amount: yesLive.utxo.satoshis - BigInt(shares * yes.priceSats) });
    if (noLeft && !yesLeft) tx.addOutput({ to: this.walletAddress, amount: 1000n });
    if (noLeft) tx.addOutput({ to: noLive.contract.address, amount: noLive.utxo.satoshis - BigInt(shares * no.priceSats) });
    tx.addBchChangeOutputIfNeeded({ to: this.walletAddress, feeRate: 1 });
    const sent = await tx.send();
    this.updateVault(rows, sent.txid, sent.outputs.slice(0, 3).map((output, index) => ({ vout: index, satoshis: Number(output.valueSatoshis) })));
    return sent.txid;
  }

  private async merge(market: typeof markets.$inferSelect, shares: number, a: BookOrder, b: BookOrder) {
    const yes = a.outcome === 'YES' ? a : b; const no = a.outcome === 'NO' ? a : b;
    const [{ rows, utxos }, yesLive, noLive, fee] = await Promise.all([
      this.vaultState(market.id, ['VAULT_MASTER']), this.liveOrder(yes, market), this.liveOrder(no, market), this.feeInput(),
    ]);
    const vault = this.vaultContract(market);
    const tx = new TransactionBuilder({ provider: this.provider, maximumFeeSatoshis: 30_000n });
    tx.addInput(utxos[0]!, (vault.unlock as any).mergeCompleteSet(BigInt(shares)));
    tx.addInput(yesLive.utxo, (yesLive.contract.unlock as any).fill(BigInt(shares)));
    tx.addInput(noLive.utxo, (noLive.contract.unlock as any).fill(BigInt(shares)));
    tx.addInput(fee, this.signer.unlockP2PKH());
    tx.addOutput({ to: vault.tokenAddress, amount: utxos[0]!.satoshis - BigInt(shares * 1000), token: { category: market.vaultCategoryId, amount: 0n, nft: { capability: 'mutable', commitment: '00' } } });
    tx.addOutput({ to: this.payout(yes), amount: BigInt(shares * yes.priceSats) });
    tx.addOutput({ to: this.payout(no), amount: BigInt(shares * no.priceSats) });
    const yesLeft = yes.remainingShares > shares;
    const noLeft = no.remainingShares > shares;
    if (yesLeft) tx.addOutput({ to: yesLive.contract.tokenAddress, amount: 1000n, token: { category: market.yesCategoryId, amount: BigInt(yes.remainingShares - shares) } });
    if (noLeft && !yesLeft) tx.addOutput({ to: this.walletAddress, amount: 1000n });
    if (noLeft) tx.addOutput({ to: noLive.contract.tokenAddress, amount: 1000n, token: { category: market.noCategoryId, amount: BigInt(no.remainingShares - shares) } });
    tx.addBchChangeOutputIfNeeded({ to: this.walletAddress, feeRate: 1 });
    const sent = await tx.send();
    this.updateVault(rows, sent.txid, [{ vout: 0, satoshis: Number(sent.outputs[0]!.valueSatoshis) }]);
    return sent.txid;
  }

  private updateVault(rows: Array<typeof vaultUtxos.$inferSelect>, txid: string, outputs: Array<{ vout: number; satoshis: number }>) {
    const now = Date.now();
    this.db.transaction(() => rows.forEach((row, index) => this.db.update(vaultUtxos).set({ txid, vout: outputs[index]!.vout,
      satoshis: outputs[index]!.satoshis, updatedAt: now }).where(eq(vaultUtxos.id, row.id)).run()));
  }
}

export class ChipnetResolutionExecutor implements ResolutionExecutor {
  private readonly provider = new ElectrumNetworkProvider('chipnet');
  private readonly privateKey = decodeChipnetWallet();
  private readonly signer = new SignatureTemplate(this.privateKey);
  private readonly walletAddress = chipnetFundingAddress(this.privateKey);
  private readonly oraclePubkey: Uint8Array;
  constructor(private readonly db: MarketDb) {
    const decoded = decodePrivateKeyWif(process.env.ORACLE_PRIVATE_KEY || process.env.MARKET_WALLET_PRIVATE_KEY!);
    if (typeof decoded === 'string') throw new Error('Invalid oracle WIF: ' + decoded);
    const pubkey = secp256k1.derivePublicKeyCompressed(decoded.privateKey);
    if (typeof pubkey === 'string') throw new Error('Could not derive oracle public key: ' + pubkey);
    this.oraclePubkey = pubkey;
  }
  async resolve(market: { id: string; marketIdHex: string; vaultContractAddress: string }, outcome: 'YES' | 'NO', signatureHex: string) {
    const row = this.db.select().from(vaultUtxos).where(and(eq(vaultUtxos.marketId, market.id), eq(vaultUtxos.utxoRole, 'VAULT_MASTER'))).get();
    if (!row) throw new Error('Vault NFT UTXO state is missing.');
    const yesCategoryId = this.db.select().from(markets).where(eq(markets.id, market.id)).get()!.yesCategoryId;
    const noCategoryId = this.db.select().from(markets).where(eq(markets.id, market.id)).get()!.noCategoryId;
    const fullMarket = this.db.select().from(markets).where(eq(markets.id, market.id)).get()!;
    const vault = new Contract(artifact('MarketVault'), [yesCategoryId, noCategoryId, this.oraclePubkey, market.marketIdHex], { provider: this.provider });
    const utxo = (await this.provider.getUtxos(vault.tokenAddress)).find((u) => u.txid.toLowerCase() === row.txid.toLowerCase() && u.vout === row.vout);
    if (!utxo) throw new Error('Current vault NFT UTXO is missing from Chipnet.');
    const fee = (await this.provider.getUtxos(this.walletAddress)).find((u) => !u.token && u.satoshis >= 5000n);
    if (!fee) throw new Error('Resolution requires a native BCH wallet UTXO of at least 5,000 sats for fees.');
    const outcomeByte = outcome === 'YES' ? '01' : '02';
    const tx = new TransactionBuilder({ provider: this.provider, maximumFeeSatoshis: 20_000n });
    tx.addInput(utxo, (vault.unlock as any).resolveMarket(Buffer.from(signatureHex, 'hex'), Buffer.from(outcomeByte, 'hex')));
    tx.addInput(fee, this.signer.unlockP2PKH());
    tx.addOutput({ to: vault.tokenAddress, amount: utxo.satoshis, token: { category: fullMarket.vaultCategoryId, amount: 0n, nft: { capability: 'mutable', commitment: outcomeByte } } });
    tx.addBchChangeOutputIfNeeded({ to: this.walletAddress, feeRate: 1 });
    const sent = await tx.send();
    this.db.update(vaultUtxos).set({ txid: sent.txid, vout: 0, satoshis: Number(sent.outputs[0]!.valueSatoshis), nftCommitment: outcomeByte, updatedAt: Date.now() }).where(eq(vaultUtxos.id, row.id)).run();
    return sent.txid;
  }
}
