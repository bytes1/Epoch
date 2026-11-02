import '../src/config/load-env.js';
import { publicKeyToP2pkhCashAddress, secp256k1 } from '@bitauth/libauth';
import { ElectrumNetworkProvider } from 'cashscript';
import { chipnetFundingAddress, decodeChipnetWallet } from '../src/services/chipnet.service.js';

const wallet = process.argv.includes('--wallet2') ? 2 : 1;
const categoryIndex = process.argv.indexOf('--category');
const category = categoryIndex >= 0 ? process.argv[categoryIndex + 1]?.toLowerCase() : undefined;
if (categoryIndex >= 0 && (!category || !/^[0-9a-f]{64}$/.test(category))) {
  throw new Error('--category must be a 64-character CashToken category ID.');
}

const privateKey = decodeChipnetWallet(wallet);
const fundingAddress = chipnetFundingAddress(privateKey);
const publicKey = secp256k1.derivePublicKeyCompressed(privateKey);
if (typeof publicKey === 'string') throw new Error('Could not derive the Chipnet wallet public key: ' + publicKey);
const tokenAddressResult = publicKeyToP2pkhCashAddress({ publicKey, prefix: 'bchtest', tokenSupport: true });
if (typeof tokenAddressResult === 'string') throw new Error('Could not derive the Chipnet token address: ' + tokenAddressResult);

const utxos = await new ElectrumNetworkProvider('chipnet').getUtxos(tokenAddressResult.address);
const totals = new Map<string, bigint>();
for (const utxo of utxos) {
  if (utxo.token) {
    const key = utxo.token.category.toLowerCase();
    totals.set(key, (totals.get(key) ?? 0n) + utxo.token.amount);
  }
}

const selected = category ? [{ category, amount: totals.get(category) ?? 0n }] : [...totals.entries()]
  .map(([tokenCategory, amount]) => ({ category: tokenCategory, amount }));
console.log(JSON.stringify({
  wallet,
  network: 'chipnet',
  fundingAddress,
  tokenAddress: tokenAddressResult.address,
  utxoCount: utxos.length,
  bchSatoshisAcrossUtxos: utxos.reduce((sum, utxo) => sum + utxo.satoshis, 0n).toString(),
  tokens: selected.map((item) => ({ category: item.category, amount: item.amount.toString() })),
}, null, 2));
