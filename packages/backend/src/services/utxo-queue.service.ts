/** Serializes zero-confirmation spends per market without an external queue. */
export class KeyedMutex {
  private readonly tails = new Map<string, Promise<void>>();

  async runExclusive<T>(key: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.tails.get(key) ?? Promise.resolve();
    let release!: () => void;
    const current = new Promise<void>((resolve) => { release = resolve; });
    this.tails.set(key, current);
    await previous;
    try { return await operation(); }
    finally {
      release();
      if (this.tails.get(key) === current) this.tails.delete(key);
    }
  }
}

export const marketMutex = new KeyedMutex();
/** Serializes spends from the shared operational wallet across all markets. */
export const walletMutex = new KeyedMutex();
