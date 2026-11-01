import { describe, expect, it } from 'vitest';
import { chipnetFundingAddress } from '../src/services/chipnet.service.js';

describe('Chipnet wallet address derivation', () => {
  it('derives a testnet CashAddress without connecting to Electrum', () => {
    const privateKey = new Uint8Array(32); privateKey[31] = 1;
    expect(chipnetFundingAddress(Buffer.from(privateKey))).toMatch(/^bchtest:/);
  });
});
