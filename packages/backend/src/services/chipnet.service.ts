import { createHash, randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { Contract, ElectrumNetworkProvider, SignatureTemplate, TransactionBuilder, type Utxo } from 'cashscript';
import { binToValueSatoshis, decodePrivateKeyWif, privateKeyToP2pkhCashAddress, secp256k1 } from '@bitauth/libauth';
import { INITIAL_OUTCOME_TOKEN_SUPPLY, type GenesisAdapter, type GenesisResult } from './genesis.service.js';
import { walletMutex } from './utxo-queue.service.js';
import { categoryIdVmBytes } from '../utils/cashtokens.js';

const readArtifact = (name: string) => JSON.parse(readFileSync(new URL('../../../contracts/artifacts/' + name + '.json', import.meta.url), 'utf8'));

export function decodeChipnetWallet(wallet: 1 | 2 = 1) {
  const variable = wallet === 2 ? 'MARKET_WALLET_PRIVATE_KEY_2' : 'MARKET_WALLET_PRIVATE_KEY';
  const wif = process.env[variable];
  if (!wif) throw new Error(`Set ${variable} to a Chipnet WIF. Keep it private and out of source control.`);
  const decoded = decodePrivateKeyWif(wif);
  if (typeof decoded === 'string') throw new Error(`Invalid ${variable}: ${decoded}`);
  return decoded.privateKey;
}

export function chipnetFundingAddress(privateKey = decodeChipnetWallet()) {
  const result = privateKeyToP2pkhCashAddress({ privateKey, prefix: 'bchtest' });
  return result.address;
}

const hash160 = (hex: string) => createHash('ripemd160').update(createHash('sha256').update(Buffer.from(hex, 'hex')).digest()).digest('hex');

/** Builds and broadcasts the three category-seeding transactions and the fixed 0/1/2 vault bundle. */
export class ChipnetGenesisAdapter implements GenesisAdapter {
  private readonly provider = new ElectrumNetworkProvider('chipnet');
  private readonly privateKey = decodeChipnetWallet();
  private readonly signer = new SignatureTemplate(this.privateKey);
  private readonly walletAddress = chipnetFundingAddress(this.privateKey);

  async createMarket(_title: string, _description: string): Promise<GenesisResult> {
    return walletMutex.runExclusive('chipnet-operational-wallet', () => this.createMarketExclusive());
  }

  private async createMarketExclusive(): Promise<GenesisResult> {
    const walletUtxos = (await this.provider.getUtxos(this.walletAddress))
      .filter((utxo) => !utxo.token).sort((a, b) => Number(b.satoshis - a.satoshis));
    const initialFunding: Utxo[] = [];
    let fundingSatoshis = 0n;
    for (const utxo of walletUtxos) {
      initialFunding.push(utxo);
      fundingSatoshis += utxo.satoshis;
      if (fundingSatoshis >= 6_000n) break;
    }
    if (fundingSatoshis < 6_000n) throw new Error('Fund the Chipnet wallet with at least 6,000 sats of native BCH, then retry market creation.');

    const oracleWif = process.env.ORACLE_PRIVATE_KEY || process.env.MARKET_WALLET_PRIVATE_KEY;
    if (!oracleWif) throw new Error('Set ORACLE_PRIVATE_KEY or MARKET_WALLET_PRIVATE_KEY before creating a market.');
    const oracleKey = decodePrivateKeyWif(oracleWif);
    if (typeof oracleKey === 'string') throw new Error('Invalid oracle WIF: ' + oracleKey);
    const oraclePubKey = secp256k1.derivePublicKeyCompressed(oracleKey.privateKey);
    if (typeof oraclePubKey === 'string') throw new Error('Could not derive the oracle public key: ' + oraclePubKey);
    const marketIdHex = randomBytes(4).toString('hex');

    const preGenesis = [] as Array<{ txid: string; vout: number }>;
    let spendable = initialFunding;
    for (let index = 0; index < 3; index += 1) {
      const tx = new TransactionBuilder({ provider: this.provider, maximumFeeSatoshis: 10_000n });
      for (const utxo of spendable) tx.addInput(utxo, this.signer.unlockP2PKH());
      tx.addOutput({ to: this.walletAddress, amount: 1000n });
      tx.addBchChangeOutputIfNeeded({ to: this.walletAddress, feeRate: 1 });
      const sent = await tx.send();
      preGenesis.push({ txid: sent.txid, vout: 0 });
      const change = sent.outputs[1]?.valueSatoshis;
      if (change === undefined) throw new Error('The wallet UTXO was too small to preserve BCH change for the next genesis transaction.');
      const changeSatoshis = typeof change === 'bigint' ? change : typeof change === 'number' ? BigInt(change) : binToValueSatoshis(change);
      if (changeSatoshis < 1000n) throw new Error('Insufficient BCH remains after category seeding; fund the wallet with more than 6,000 sats and retry.');
      spendable = [{ txid: sent.txid, vout: 1, satoshis: changeSatoshis }];
    }

    const yesCategoryId = preGenesis[0]!.txid;
    const noCategoryId = preGenesis[1]!.txid;
    const vaultCategoryId = preGenesis[2]!.txid;

    const vault = new Contract(readArtifact('MarketVault'), [categoryIdVmBytes(yesCategoryId), categoryIdVmBytes(noCategoryId), oraclePubKey, marketIdHex], { provider: this.provider });
    const vaultScriptHash = hash160(vault.lockingBytecode);
    const yesBaton = new Contract(readArtifact('MintingBaton'), [vaultScriptHash], { provider: this.provider });
    const noBaton = new Contract(readArtifact('MintingBaton'), [vaultScriptHash], { provider: this.provider });
    const genesis = new TransactionBuilder({ provider: this.provider, maximumFeeSatoshis: 10_000n });
    for (const outpoint of preGenesis) genesis.addInput({ ...outpoint, satoshis: 1000n }, this.signer.unlockP2PKH());
    genesis.addInput(spendable[0]!, this.signer.unlockP2PKH());
    genesis.addOutputs([
      { to: vault.tokenAddress, amount: 1000n, token: { category: vaultCategoryId, amount: 0n, nft: { capability: 'mutable', commitment: '00' } } },
      { to: yesBaton.tokenAddress, amount: 1000n, token: { category: yesCategoryId, amount: INITIAL_OUTCOME_TOKEN_SUPPLY, nft: { capability: 'minting', commitment: '' } } },
      { to: noBaton.tokenAddress, amount: 1000n, token: { category: noCategoryId, amount: INITIAL_OUTCOME_TOKEN_SUPPLY, nft: { capability: 'minting', commitment: '' } } },
    ]);
    genesis.addBchChangeOutputIfNeeded({ to: this.walletAddress, feeRate: 1 });
    const sent = await genesis.send();

    return { marketIdHex, yesCategoryId, noCategoryId, vaultCategoryId,
      vaultContractAddress: vault.tokenAddress, txid: sent.txid };
  }
}
