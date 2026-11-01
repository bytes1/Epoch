import { TransactionBuilder, type NetworkProvider, type Output, type Unlocker, type Utxo } from 'cashscript';

/**
 * Creates a covenant builder with only the supplied inputs and outputs. CashScript 0.13 does not
 * expose withoutChange()/withoutTokenChange(); change is opt-in via add*ChangeOutputIfNeeded().
 * This wrapper deliberately never invokes those helpers, so fixed covenant output indices remain
 * stable. Callers must account for fees and add any change as explicit outputs themselves.
 */
export function createExplicitCovenantBuilder(provider: NetworkProvider) {
  return new TransactionBuilder({ provider });
}

export function addExplicitInput(builder: TransactionBuilder, utxo: Utxo, unlocker: Unlocker) {
  return builder.addInput(utxo, unlocker);
}

export function addExplicitOutputs(builder: TransactionBuilder, outputs: Output[]) {
  return builder.addOutputs(outputs);
}
