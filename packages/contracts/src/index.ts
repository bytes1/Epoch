export const SATS_PER_SHARE = 1000n;
export type Outcome = 'YES' | 'NO';
export const complementPrice = (_outcome: Outcome, priceSats: number): number => 1000 - priceSats;
