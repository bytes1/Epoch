import { decodePrivateKeyWif, secp256k1, sha256 } from '@bitauth/libauth';

/** BCH OP_CHECKDATASIG signs SHA256(market_id || outcome_byte) with a DER ECDSA signature. */
export function signResolution(marketIdHex: string, outcome: 'YES' | 'NO', privateKeyWif: string) {
  const decoded = decodePrivateKeyWif(privateKeyWif);
  if (typeof decoded === 'string') throw new Error('Invalid ORACLE_PRIVATE_KEY: ' + decoded);
  if (!/^[0-9a-f]{8}$/i.test(marketIdHex)) throw new Error('marketIdHex must be exactly 4 bytes');
  const message = Buffer.from(marketIdHex + (outcome === 'YES' ? '01' : '02'), 'hex');
  const signature = secp256k1.signMessageHashDER(decoded.privateKey, sha256.hash(message));
  if (typeof signature === 'string') throw new Error('Oracle signing failed: ' + signature);
  return Buffer.from(signature).toString('hex');
}
