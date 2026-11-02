import '../src/config/load-env.js';
import { publicKeyToP2pkhCashAddress, secp256k1 } from '@bitauth/libauth';
import { ElectrumNetworkProvider, SignatureTemplate, TransactionBuilder } from 'cashscript';
import { chipnetFundingAddress, decodeChipnetWallet } from '../src/services/chipnet.service.js';

const args = process.argv.slice(2).filter((arg) => arg !== '--');
const positional = args.filter((arg) => !arg.startsWith('--'));
const broadcast = args.includes('--broadcast');
const [orderAddress, tokenCategory, amountText] = positional;

if (!orderAddress?.toLowerCase().startsWith('bchtest:') || !tokenCategory || !/^[0-9a-f]{64}$/i.test(tokenCategory)
  || !amountText || !/^\d+$/.test(amountText) || BigInt(amountText) <= 0n) {
  throw new Error('Usage: pnpm --filter @bch-market/backend fund-sell-order -- <sell order bchtest address> <64-char token category> <token amount> [--wallet2] [--broadcast]');
}

const tokenAmount = BigInt(amountText);
const wallet = args.includes('--wallet2') ? 2 : 1;
const privateKey = decodeChipnetWallet(wallet);
const fundingAddress = chipnetFundingAddress(privateKey);
const publicKey = secp256k1.derivePublicKeyCompressed(privateKey);
if (typeof publicKey === 'string') throw new Error('Could not derive the Chipnet wallet public key: ' + publicKey);
const tokenAddressResult = publicKeyToP2pkhCashAddress({ publicKey, prefix: 'bchtest', tokenSupport: true });
if (typeof tokenAddressResult === 'string') throw new Error('Could not derive the Chipnet token address: ' + tokenAddressResult);
const walletTokenAddress = tokenAddressResult.address;

const provider = new ElectrumNetworkProvider('chipnet');
const signer = new SignatureTemplate(privateKey);
const walletUtxos = await provider.getUtxos(walletTokenAddress);
const tokenUtxos = walletUtxos.filter((utxo) => utxo.token
  && !utxo.token.nft
  && utxo.token.category.toLowerCase() === tokenCategory.toLowerCase())
  .sort((a, b) => Number(b.token!.amount - a.token!.amount));

const selectedTokens = [] as typeof tokenUtxos;
let selectedTokenAmount = 0n;
let selectedTokenSatoshis = 0n;
for (const utxo of tokenUtxos) {
  selectedTokens.push(utxo);
  selectedTokenAmount += utxo.token!.amount;
  selectedTokenSatoshis += utxo.satoshis;
  if (selectedTokenAmount >= tokenAmount) break;
}
if (selectedTokenAmount < tokenAmount) {
  throw new Error(`Wallet has ${selectedTokenAmount} matching tokens; ${tokenAmount} required for this sell order.`);
}

const tokenChange = selectedTokenAmount - tokenAmount;
const outputSatoshis = 1000n * (tokenChange > 0n ? 2n : 1n);
const nativeUtxos = walletUtxos.filter((utxo) => !utxo.token).sort((a, b) => Number(b.satoshis - a.satoshis));
const selectedNative = [] as typeof nativeUtxos;
let totalSatoshis = selectedTokenSatoshis;
for (const utxo of nativeUtxos) {
  if (totalSatoshis >= outputSatoshis + 2000n) break;
  selectedNative.push(utxo);
  totalSatoshis += utxo.satoshis;
}
if (totalSatoshis < outputSatoshis + 1000n) {
  throw new Error(`Need enough native BCH in the backend wallet for ${outputSatoshis} sats of token outputs plus the network fee.`);
}

const tx = new TransactionBuilder({ provider, maximumFeeSatoshis: 10_000n });
for (const utxo of selectedTokens) tx.addInput(utxo, signer.unlockP2PKH());
for (const utxo of selectedNative) tx.addInput(utxo, signer.unlockP2PKH());
tx.addOutput({ to: orderAddress, amount: 1000n, token: { category: tokenCategory, amount: tokenAmount } });
if (tokenChange > 0n) tx.addOutput({ to: walletTokenAddress, amount: 1000n, token: { category: tokenCategory, amount: tokenChange } });
tx.addBchChangeOutputIfNeeded({ to: fundingAddress, feeRate: 1 });

console.log(`Funding source (wallet ${wallet}): ${fundingAddress}`);
console.log(`Token change address: ${walletTokenAddress}`);
console.log(`Sell order: ${orderAddress} (1,000 sats + ${tokenAmount} tokens, expected vout 0)`);
console.log(`Token category: ${tokenCategory}`);
console.log(`Selected token UTXOs: ${selectedTokens.length} (${selectedTokenAmount} tokens, ${selectedTokenSatoshis} sats)`);
console.log(`Selected native BCH UTXOs: ${selectedNative.length}`);

if (!broadcast) {
  console.log('Dry run only. Add --broadcast to publish this Chipnet transaction.');
} else {
  const sent = await tx.send();
  console.log(JSON.stringify({
    txid: sent.txid,
    order: { address: orderAddress, txid: sent.txid, vout: 0, satoshis: 1000, tokenCategory, tokenAmount: Number(tokenAmount) },
  }, null, 2));
}
