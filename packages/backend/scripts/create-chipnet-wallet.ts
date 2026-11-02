import '../src/config/load-env.js';
import { encodePrivateKeyWif, generatePrivateKey, secp256k1 } from '@bitauth/libauth';
import { chipnetFundingAddress } from '../src/services/chipnet.service.js';

const wallet2 = process.argv.includes('--wallet2');
const privateKey = generatePrivateKey();
if (typeof privateKey === 'string') throw new Error('Could not create a private key: ' + privateKey);
const wif = encodePrivateKeyWif(privateKey, 'testnet');
const publicKey = secp256k1.derivePublicKeyCompressed(privateKey);
if (typeof publicKey === 'string') throw new Error('Could not derive the compressed public key: ' + publicKey);
console.log(`Chipnet wallet ${wallet2 ? '2' : '1'} address: ${chipnetFundingAddress(privateKey)}`);
console.log(`Compressed public key: ${Buffer.from(publicKey).toString('hex')}`);
console.log(`WIF (secret; keep private): ${wif}`);
if (wallet2) console.log('Add this WIF to the repository-root .env as MARKET_WALLET_PRIVATE_KEY_2=...');
