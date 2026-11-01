import '../src/config/load-env.js';
import { chipnetFundingAddress } from '../src/services/chipnet.service.js';

try {
  console.log(chipnetFundingAddress());
  console.log('Network: Chipnet (bchtest). Fund this address with at least 6,000 sats of native BCH before creating a market.');
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
}
