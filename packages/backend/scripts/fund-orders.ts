import '../src/config/load-env.js';
import { ElectrumNetworkProvider, SignatureTemplate, TransactionBuilder } from 'cashscript';
import { chipnetFundingAddress, decodeChipnetWallet } from '../src/services/chipnet.service.js';

const ORDER_SATOSHIS = 2000n;
const FEE_RESERVE_SATOSHIS = 1000n;
const addresses = process.argv.slice(2).filter((arg) => arg.toLowerCase().startsWith('bchtest:'));
const broadcast = process.argv.includes('--broadcast');
const satoshisFlag = process.argv.indexOf('--satoshis');
const satoshisText = satoshisFlag >= 0 ? process.argv[satoshisFlag + 1] : undefined;

if (addresses.length < 1 || addresses.length > 2) {
  throw new Error('Usage: pnpm --filter @bch-market/backend fund-orders -- <order bchtest address> [second order bchtest address] [--satoshis <amount>] [--wallet2] [--broadcast]');
}

if (addresses.length === 1 && satoshisText === undefined) {
  throw new Error('For one order address, provide its exact output amount with --satoshis <amount>.');
}
if (satoshisText !== undefined && !/^\d+$/.test(satoshisText)) {
  throw new Error('--satoshis must be a positive whole number.');
}
const orderSatoshis = satoshisText === undefined ? ORDER_SATOSHIS : BigInt(satoshisText);
if (orderSatoshis <= 0n || orderSatoshis > BigInt(Number.MAX_SAFE_INTEGER)) {
  throw new Error('--satoshis must be a positive safe integer.');
}

if (addresses.length === 2 && addresses[0]!.toLowerCase() === addresses[1]!.toLowerCase()) {
  throw new Error('YES and NO order addresses must be different.');
}

const wallet = process.argv.includes('--wallet2') ? 2 : 1;
const privateKey = decodeChipnetWallet(wallet);
const walletAddress = chipnetFundingAddress(privateKey);
const provider = new ElectrumNetworkProvider('chipnet');
const signer = new SignatureTemplate(privateKey);
const utxos = (await provider.getUtxos(walletAddress)).filter((utxo) => !utxo.token)
  .sort((a, b) => Number(b.satoshis - a.satoshis));

const selected = [] as typeof utxos;
let total = 0n;
const requiredFunding = orderSatoshis * BigInt(addresses.length) + FEE_RESERVE_SATOSHIS;
for (const utxo of utxos) {
  selected.push(utxo);
  total += utxo.satoshis;
  if (total >= requiredFunding) break;
}

if (total < requiredFunding) {
  throw new Error(`Need at least ${requiredFunding} sats in native Chipnet BCH UTXOs; found ${total}.`);
}

const tx = new TransactionBuilder({ provider, maximumFeeSatoshis: 10_000n });
for (const utxo of selected) tx.addInput(utxo, signer.unlockP2PKH());
for (const address of addresses) tx.addOutput({ to: address, amount: orderSatoshis });
tx.addBchChangeOutputIfNeeded({ to: walletAddress, feeRate: 1 });

console.log(`Funding source (wallet ${wallet}): ${walletAddress}`);
addresses.forEach((address, index) => console.log(`Order ${index + 1}: ${address} (${orderSatoshis} sats, expected vout ${index})`));
console.log(`Selected native BCH inputs: ${selected.length}, total ${total} sats.`);

if (!broadcast) {
  console.log('Dry run only. Add --broadcast to publish this Chipnet transaction.');
} else {
  const sent = await tx.send();
  const outputs = addresses.map((address, vout) => ({ address, txid: sent.txid, vout, satoshis: Number(orderSatoshis) }));
  console.log(JSON.stringify({ txid: sent.txid, outputs }, null, 2));
}
