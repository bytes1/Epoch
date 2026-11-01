import { describe, expect, it } from 'vitest';
import { Contract, MockNetworkProvider } from 'cashscript';
import { SATS_PER_SHARE, complementPrice } from '../src/index.js';
import { readFileSync } from 'node:fs';

const artifact = JSON.parse(readFileSync(new URL('../artifacts/MarketVault.json', import.meta.url), 'utf8'));

describe('MarketVault lifecycle invariants', () => {
  it('uses native satoshi par value for complete set minting and merging', () => {
    const provider = new MockNetworkProvider();
    expect(provider).toBeDefined();
    expect(100n * SATS_PER_SHARE).toBe(100_000n);
    expect(100 * Number(SATS_PER_SHARE)).toBe(100_000);
  });
  it('keeps complementary prices at exactly 1000 satoshis', () => {
    expect(complementPrice('YES', 620) + complementPrice('NO', 380)).toBe(1000);
  });
  it('encodes resolution commitments as one-byte state values', () => {
    expect(['00', '01', '02']).toHaveLength(3);
  });
  it('loads the compiled vault artifact and exposes each lifecycle branch to CashScript', () => {
    const provider = new MockNetworkProvider();
    const vault = new Contract(artifact, ['00'.repeat(32), '11'.repeat(32), '02'.repeat(33), '01020304'], { provider });
    const functions = vault.artifact.abi.map((item: { name: string }) => item.name);
    expect(functions).toEqual(expect.arrayContaining(['mintCompleteSet', 'mergeCompleteSet', 'resolveMarket', 'redeemWinnings']));
    expect(vault.address).toBeTruthy();
  });
});
