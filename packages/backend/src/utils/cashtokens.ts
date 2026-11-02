/** CashTokens VM introspection uses serialized (little-endian) txid bytes for a category ID. */
export function categoryIdVmBytes(categoryId: string) {
  if (!/^[0-9a-f]{64}$/i.test(categoryId)) throw new Error('CashToken category ID must be a 32-byte hex txid.');
  return Buffer.from(categoryId, 'hex').reverse().toString('hex');
}
