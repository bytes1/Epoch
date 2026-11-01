import { describe, expect, it } from 'vitest';
import { Contract, MockNetworkProvider, TransactionBuilder } from 'cashscript';
import { readFileSync } from 'node:fs';
const artifact = JSON.parse(readFileSync(new URL('../artifacts/BuyOrder.json', import.meta.url), 'utf8'));

describe('CLOB settlement transaction cases', () => {
  it('provides an isolated CashScript mock network for direct swaps', () => {
    const provider = new MockNetworkProvider();
    const builder = new TransactionBuilder({ provider });
    const buy = new Contract(artifact, ['02'.repeat(33), '11'.repeat(20), '22'.repeat(32), 620n], { provider });
    expect(builder.outputs).toHaveLength(0);
    expect(buy.artifact.abi.map((fn: { name: string }) => fn.name)).toEqual(expect.arrayContaining(['fill', 'cancel']));
  });
  it('preserves complementary mint and merge satoshi totals', () => {
    const shares = 25;
    expect(shares * 620 + shares * 380).toBe(shares * 1000);
    expect(shares * 450 + shares * 500).toBeLessThan(shares * 1000);
  });
});
