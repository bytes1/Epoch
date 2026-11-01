import '../src/config/load-env.js';
import { encodePrivateKeyWif, generatePrivateKey } from '@bitauth/libauth';
import { chipnetFundingAddress } from '../src/services/chipnet.service.js';

const privateKey = generatePrivateKey();
if (typeof privateKey === 'string') throw new Error('Could not create a private key: ' + privateKey);
const wif = encodePrivateKeyWif(privateKey, 'testnet');
console.log('Chipnet funding address: ' + chipnetFundingAddress(privateKey));
console.log('Chipnet WIF (secret; keep offline and never share): ' + wif);
