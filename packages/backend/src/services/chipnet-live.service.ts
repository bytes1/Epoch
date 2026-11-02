import { createHash, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { and, eq } from 'drizzle-orm';
import { Contract, ElectrumNetworkProvider, SignatureTemplate, TransactionBuilder, type Utxo } from 'cashscript';
import { decodePrivateKeyWif, publicKeyToP2pkhCashAddress, secp256k1 } from '@bitauth/libauth';
import type { MarketDb } from '../db/index.js';
import { markets, orders, vaultUtxos } from '../db/schema.js';
import { continuationVout, yesExecutionPrice, type BookOrder, type MatchExecutor, type MatchType } from './matcher.service.js';
import type { ResolutionExecutor } from './resolution.service.js';
import type { OrderVerifier } from '../routes/orders.routes.js';
import { decodeChipnetWallet, chipnetFundingAddress } from './chipnet.service.js';
import { walletMutex } from './utxo-queue.service.js';
import { categoryIdVmBytes } from '../utils/cashtokens.js';

const artifact = (name: string) => JSON.parse(readFileSync(new URL('../../../contracts/artifacts/' + name + '.json', import.meta.url), 'utf8'));
const BCH_DUST_LIMIT_SATS = 546;
const hash160 = (bytes: Uint8Array) => createHash('ripemd160').update(createHash('sha256').update(bytes).digest()).digest('hex');
const toHex = (value: string | Uint8Array) => typeof value === 'string' ? value : Buffer.from(value).toString('hex');

function addOutputAt(tx: TransactionBuilder, index: number, output: Parameters<TransactionBuilder['addOutput']>[0], paddingAddress: string) {
  while (tx.outputs.length < index) tx.addOutput({ to: paddingAddress, amount: 1000n });
  if (tx.outputs.length !== index) throw new Error(`Transaction output layout expected index ${index}, found ${tx.outputs.length}.`);
  tx.addOutput(output);
}

class StaleOrderError extends Error {}

export function makerTokenAddress(pubkeyHex: string) {
  const result = publicKeyToP2pkhCashAddress({ publicKey: Buffer.from(pubkeyHex, 'hex'), prefix: 'bchtest', tokenSupport: true });
  if (typeof result === 'string') throw new Error('Could not derive maker address: ' + result);
  return result.address;
}

function orderContract(order: BookOrder, market: typeof markets.$inferSelect, provider: ElectrumNetworkProvider) {
  const contractName = order.side === 'BUY' ? 'BuyOrder' : 'SellOrder';
  const pubkey = Buffer.from(order.makerPubkey, 'hex');
  const p2pkh = Buffer.from('76a914' + hash160(pubkey) + '88ac', 'hex');
  const args = [order.makerPubkey, hash160(p2pkh),
    categoryIdVmBytes(order.outcome === 'YES' ? market.yesCategoryId : market.noCategoryId), BigInt(order.priceSats)];
  return new Contract(artifact(contractName), args, { provider });
}

function marketVaultArtifact(market: typeof markets.$inferSelect, oraclePubkey: Uint8Array, provider: ElectrumNetworkProvider) {
  for (const name of ['MarketVault', 'MarketVaultV1']) {
    const contract = new Contract(artifact(name),
      [categoryIdVmBytes(market.yesCategoryId), categoryIdVmBytes(market.noCategoryId), oraclePubkey, market.marketIdHex], { provider });
    if (contract.tokenAddress === market.vaultContractAddress) return { name, contract };
  }
  throw new Error('No known MarketVault artifact matches this market address. Preserve its deployment artifact before upgrading contracts.');
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
    } else if (utxo.satoshis !== 1000n || !utxo.token || utxo.token.category.toLowerCase() !== token.toLowerCase() || utxo.token.amount !== BigInt(input.shares)) {
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
    return walletMutex.runExclusive('chipnet-operational-wallet', () => this.dispatch(marketId, kind, shares, matched));
  }

  async isOrderLive(order: BookOrder) {
    const market = this.db.select().from(markets).where(eq(markets.id, order.marketId)).get();
    if (!market) throw new Error(`Market for order ${order.id} no longer exists.`);
    try {
      await this.liveOrder(order, market);
      return true;
    } catch (error) {
      if (error instanceof StaleOrderError) return false;
      throw error;
    }
  }

  private async dispatch(marketId: string, kind: MatchType, shares: number, matched: [BookOrder, BookOrder]) {
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
    if (!utxo) throw new StaleOrderError(`Order ${order.id} UTXO is no longer unspent; refresh or cancel the order.`);
    const tokenCategory = order.outcome === 'YES' ? market.yesCategoryId : market.noCategoryId;
    if (order.side === 'BUY' && (utxo.token || utxo.satoshis !== BigInt(order.remainingShares * order.priceSats + 1000)))
      throw new StaleOrderError(`Buy order ${order.id} does not have the exact remaining BCH collateral.`);
    if (order.side === 'SELL' && (utxo.satoshis !== 1000n || !utxo.token || utxo.token.category.toLowerCase() !== tokenCategory.toLowerCase() || utxo.token.amount !== BigInt(order.remainingShares)))
      throw new StaleOrderError(`Order ${order.id} token UTXO no longer contains its remaining shares.`);
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
    const yesPrice = yesExecutionPrice('DIRECT', buy, sell);
    const executionPrice = buy.outcome === 'YES' ? yesPrice : 1000 - yesPrice;
    const tx = new TransactionBuilder({ provider: this.provider, maximumFeeSatoshis: 20_000n });
    tx.addInput(buyUtxo, (buyContract.unlock as any).fill(BigInt(shares)));
    tx.addInput(sellUtxo, (sellContract.unlock as any).fill(BigInt(shares), BigInt(executionPrice)));
    tx.addInput(fee, this.signer.unlockP2PKH());
    tx.addOutput({ to: this.payout(buy), amount: 1000n, token: { category, amount: BigInt(shares) } });
    tx.addOutput({ to: this.payout(sell), amount: BigInt(shares * executionPrice) });
    const buyLeft = buy.remainingShares - shares;
    if (buyLeft > 0) addOutputAt(tx, continuationVout('DIRECT', buy), { to: buyContract.address, amount: buyUtxo.satoshis - BigInt(shares * buy.priceSats) }, this.walletAddress);
    const sellLeft = sell.remainingShares - shares;
    if (sellLeft > 0) addOutputAt(tx, continuationVout('DIRECT', sell), { to: sellContract.tokenAddress, amount: 1000n, token: { category, amount: BigInt(sellLeft) } }, this.walletAddress);
    const buyerRefund = shares * (buy.priceSats - executionPrice) + (buyLeft === 0 && sellLeft === 0 ? 1000 : 0);
    if (buyerRefund >= BCH_DUST_LIMIT_SATS) tx.addOutput({ to: this.payout(buy), amount: BigInt(buyerRefund) });
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
      const { name, contract: vaultContract } = marketVaultArtifact(contract, this.oraclePubkey, this.provider);
      const batonArtifact = name === 'MarketVaultV1' ? 'MintingBatonV1' : 'MintingBaton';
      const baton = new Contract(artifact(batonArtifact), [hash160(Buffer.from(vaultContract.lockingBytecode, 'hex'))], { provider: this.provider });
      const address = row.utxoRole === 'VAULT_MASTER' ? vaultContract.tokenAddress : baton.tokenAddress;
      const addressUtxos = await this.provider.getUtxos(address);
      const found = addressUtxos.find((u) => u.txid.toLowerCase() === row.txid.toLowerCase() && u.vout === row.vout) ??
        addressUtxos.find((u) => u.token?.category.toLowerCase() === row.tokenCategory.toLowerCase() &&
          u.token.nft?.capability === (row.utxoRole === 'VAULT_MASTER' ? 'mutable' : 'minting') &&
          (row.utxoRole !== 'VAULT_MASTER' || u.token.nft.commitment === '00'));
      if (!found) throw new Error(`${row.utxoRole} UTXO is not visible on Chipnet; reconcile the market state before retrying.`);
      if (found.txid !== row.txid || found.vout !== row.vout || Number(found.token?.amount ?? 0n) !== row.tokenAmount)
        this.db.update(vaultUtxos).set({ txid: found.txid, vout: found.vout,
        satoshis: Number(found.satoshis), tokenAmount: Number(found.token?.amount ?? 0n),
        nftCommitment: found.token?.nft?.commitment ?? row.nftCommitment, updatedAt: Date.now() })
        .where(eq(vaultUtxos.id, row.id)).run();
      utxos.push(found);
    }
    return { rows: selected, utxos };
  }

  private vaultContract(market: typeof markets.$inferSelect) {
    return marketVaultArtifact(market, this.oraclePubkey, this.provider).contract;
  }
  private batonContract(market: typeof markets.$inferSelect) {
    const { name, contract } = marketVaultArtifact(market, this.oraclePubkey, this.provider);
    return new Contract(artifact(name === 'MarketVaultV1' ? 'MintingBatonV1' : 'MintingBaton'), [hash160(Buffer.from(contract.lockingBytecode, 'hex'))], { provider: this.provider });
  }
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
      { to: baton.tokenAddress, amount: utxos[1]!.satoshis, token: { category: market.yesCategoryId, amount: utxos[1]!.token!.amount - BigInt(shares), nft: { capability: 'minting', commitment: '' } } },
      { to: baton.tokenAddress, amount: utxos[2]!.satoshis, token: { category: market.noCategoryId, amount: utxos[2]!.token!.amount - BigInt(shares), nft: { capability: 'minting', commitment: '' } } },
      { to: this.payout(yes), amount: 1000n, token: { category: market.yesCategoryId, amount: BigInt(shares) } },
      { to: this.payout(no), amount: 1000n, token: { category: market.noCategoryId, amount: BigInt(shares) } },
    ]);
    const yesLeft = yes.remainingShares > shares;
    const noLeft = no.remainingShares > shares;
    if (yesLeft) addOutputAt(tx, continuationVout('MINT', yes), { to: yesLive.contract.address, amount: yesLive.utxo.satoshis - BigInt(shares * yes.priceSats) }, this.walletAddress);
    if (noLeft) addOutputAt(tx, continuationVout('MINT', no), { to: noLive.contract.address, amount: noLive.utxo.satoshis - BigInt(shares * no.priceSats) }, this.walletAddress);
    const yesExecution = yesExecutionPrice('MINT', yes, no);
    const yesRefund = shares * (yes.priceSats - yesExecution);
    const noRefund = shares * (no.priceSats - (1000 - yesExecution));
    if (yesRefund >= BCH_DUST_LIMIT_SATS) tx.addOutput({ to: this.payout(yes), amount: BigInt(yesRefund) });
    if (noRefund >= BCH_DUST_LIMIT_SATS) tx.addOutput({ to: this.payout(no), amount: BigInt(noRefund) });
    tx.addBchChangeOutputIfNeeded({ to: this.walletAddress, feeRate: 1 });
    const sent = await tx.send();
    this.updateVault(rows, sent.txid, sent.outputs.slice(0, 3).map((output, index) => ({
      vout: index, satoshis: Number(output.valueSatoshis),
      tokenAmount: Number(utxos[index]!.token?.amount ?? 0n) - (index === 0 ? 0 : shares),
    })));
    return sent.txid;
  }

  private async merge(market: typeof markets.$inferSelect, shares: number, a: BookOrder, b: BookOrder) {
    const yes = a.outcome === 'YES' ? a : b; const no = a.outcome === 'NO' ? a : b;
    const [{ rows, utxos }, yesLive, noLive, fee] = await Promise.all([
      this.vaultState(market.id, ['VAULT_MASTER']), this.liveOrder(yes, market), this.liveOrder(no, market), this.feeInput(),
    ]);
    const vault = this.vaultContract(market);
    const yesExecution = yesExecutionPrice('MERGE', yes, no);
    const noExecution = 1000 - yesExecution;
    const tx = new TransactionBuilder({ provider: this.provider, maximumFeeSatoshis: 30_000n, allowImplicitFungibleTokenBurn: true });
    tx.addInput(utxos[0]!, (vault.unlock as any).mergeCompleteSet(BigInt(shares)));
    tx.addInput(yesLive.utxo, (yesLive.contract.unlock as any).fill(BigInt(shares), BigInt(yesExecution)));
    tx.addInput(noLive.utxo, (noLive.contract.unlock as any).fill(BigInt(shares), BigInt(noExecution)));
    tx.addInput(fee, this.signer.unlockP2PKH());
    tx.addOutput({ to: vault.tokenAddress, amount: utxos[0]!.satoshis - BigInt(shares * 1000), token: { category: market.vaultCategoryId, amount: 0n, nft: { capability: 'mutable', commitment: '00' } } });
    tx.addOutput({ to: this.payout(yes), amount: BigInt(shares * yesExecution) });
    tx.addOutput({ to: this.payout(no), amount: BigInt(shares * noExecution) });
    const yesLeft = yes.remainingShares > shares;
    const noLeft = no.remainingShares > shares;
    addOutputAt(tx, continuationVout('MERGE', yes), yesLeft
      ? { to: yesLive.contract.tokenAddress, amount: 1000n, token: { category: market.yesCategoryId, amount: BigInt(yes.remainingShares - shares) } }
      : { to: this.payout(yes), amount: 1000n }, this.walletAddress);
    addOutputAt(tx, continuationVout('MERGE', no), noLeft
      ? { to: noLive.contract.tokenAddress, amount: 1000n, token: { category: market.noCategoryId, amount: BigInt(no.remainingShares - shares) } }
      : { to: this.payout(no), amount: 1000n }, this.walletAddress);
    tx.addBchChangeOutputIfNeeded({ to: this.walletAddress, feeRate: 1 });
    const sent = await tx.send();
    this.updateVault(rows, sent.txid, [{ vout: 0, satoshis: Number(sent.outputs[0]!.valueSatoshis) }]);
    return sent.txid;
  }

  private updateVault(rows: Array<typeof vaultUtxos.$inferSelect>, txid: string,
    outputs: Array<{ vout: number; satoshis: number; tokenAmount?: number }>) {
    const now = Date.now();
    this.db.transaction(() => rows.forEach((row, index) => this.db.update(vaultUtxos).set({ txid, vout: outputs[index]!.vout,
      satoshis: outputs[index]!.satoshis,
      ...(outputs[index]!.tokenAmount === undefined ? {} : { tokenAmount: outputs[index]!.tokenAmount }), updatedAt: now })
      .where(eq(vaultUtxos.id, row.id)).run()));
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
    return walletMutex.runExclusive('chipnet-operational-wallet', () => this.resolveExclusive(market, outcome, signatureHex));
  }

  private async resolveExclusive(market: { id: string; marketIdHex: string; vaultContractAddress: string }, outcome: 'YES' | 'NO', signatureHex: string) {
    const row = this.db.select().from(vaultUtxos).where(and(eq(vaultUtxos.marketId, market.id), eq(vaultUtxos.utxoRole, 'VAULT_MASTER'))).get();
    if (!row) throw new Error('Vault NFT UTXO state is missing.');
    const yesCategoryId = this.db.select().from(markets).where(eq(markets.id, market.id)).get()!.yesCategoryId;
    const noCategoryId = this.db.select().from(markets).where(eq(markets.id, market.id)).get()!.noCategoryId;
    const fullMarket = this.db.select().from(markets).where(eq(markets.id, market.id)).get()!;
    const vault = marketVaultArtifact(fullMarket, this.oraclePubkey, this.provider).contract;
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
