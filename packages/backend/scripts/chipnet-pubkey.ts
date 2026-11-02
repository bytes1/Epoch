import '../src/config/load-env.js';
import { secp256k1 } from '@bitauth/libauth';
import { decodeChipnetWallet } from '../src/services/chipnet.service.js';

const wallet = process.argv.includes('--wallet2') ? 2 : 1;
const publicKey = secp256k1.derivePublicKeyCompressed(decodeChipnetWallet(wallet));
if (typeof publicKey === 'string') throw new Error('Could not derive compressed public key: ' + publicKey);
console.log(`Wallet ${wallet} compressed public key:`);
console.log(Buffer.from(publicKey).toString('hex'));
