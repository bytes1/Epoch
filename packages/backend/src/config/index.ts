export type NetworkName = 'mocknet' | 'chipnet';
export const config = {
  network: (process.env.BCH_NETWORK ?? 'mocknet') as NetworkName,
  databasePath: process.env.DATABASE_PATH ?? './data/market.db',
  port: Number(process.env.PORT ?? 3001),
};
