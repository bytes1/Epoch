import '../src/config/load-env.js';
import { chipnetFundingAddress, decodeChipnetWallet } from '../src/services/chipnet.service.js';

try {
  const wallet = process.argv.includes('--wallet2') ? 2 : 1;
  console.log(chipnetFundingAddress(decodeChipnetWallet(wallet)));
  console.log(`Wallet ${wallet} · Chipnet (bchtest).`);
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
}
