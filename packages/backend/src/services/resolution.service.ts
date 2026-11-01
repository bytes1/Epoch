import { randomBytes } from 'node:crypto';

export interface ResolutionExecutor {
  resolve(market: { id: string; marketIdHex: string; vaultContractAddress: string }, outcome: 'YES' | 'NO', signatureHex: string): Promise<string>;
}

/** Explicit simulation adapter used by the mock network and tests; it never broadcasts to BCH. */
export class MockResolutionExecutor implements ResolutionExecutor {
  async resolve(_market: { id: string; marketIdHex: string; vaultContractAddress: string }, _outcome: 'YES' | 'NO', signatureHex: string) {
    if (!signatureHex) throw new Error('Resolution signature is required');
    return randomBytes(32).toString('hex');
  }
}

export class UnconfiguredMatchExecutor {
  async execute(): Promise<string> { throw new Error('A Chipnet CLOB settlement transaction executor is not configured'); }
}

export class UnconfiguredResolutionExecutor implements ResolutionExecutor {
  async resolve(): Promise<string> { throw new Error('A BCH transaction executor is not configured'); }
}
