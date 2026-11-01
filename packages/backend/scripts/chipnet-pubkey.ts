import '../src/config/load-env.js';
import { secp256k1 } from '@bitauth/libauth';
import { decodeChipnetWallet } from '../src/services/chipnet.service.js';

const publicKey = secp256k1.derivePublicKeyCompressed(decodeChipnetWallet());
if (typeof publicKey === 'string') throw new Error('Could not derive compressed public key: ' + publicKey);
console.log(Buffer.from(publicKey).toString('hex'));
