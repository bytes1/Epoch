export type Market = {
  id: string;
  marketIdHex: string;
  title: string;
  description: string;
  status: "OPEN" | "RESOLVED_YES" | "RESOLVED_NO";
  yesCategoryId: string;
  noCategoryId: string;
  vaultContractAddress: string;
  lastYesPriceSats: number;
  lastNoPriceSats: number;
  volumeSats: number;
  createdAt: number;
  resolvedAt: number | null;
};

export type BookLevel = { priceSats: number; shares: number };
export type Trade = {
  id?: string;
  matchType: "DIRECT" | "MINT" | "MERGE";
  yesPriceSats: number;
  noPriceSats: number;
  sharesTraded: number;
  bchTxid: string;
  executedAt: number;
};
export type Orderbook = {
  yes: { bids: BookLevel[]; asks: BookLevel[] };
  no: { bids: BookLevel[]; asks: BookLevel[] };
  ticks: Trade[];
};

const apiBase = () =>
  (typeof window === "undefined"
    ? process.env.API_BASE_URL
    : process.env.NEXT_PUBLIC_API_URL) || "http://127.0.0.1:3001";

async function request<T>(path: string): Promise<T> {
  const response = await fetch(`${apiBase()}${path}`, { cache: "no-store" });
  if (!response.ok) throw new Error(`API request failed (${response.status})`);
  return response.json() as Promise<T>;
}

export async function getMarkets() {
  return request<Market[]>("/api/markets");
}

export async function getOrderbook(marketId: string) {
  return request<Orderbook>(`/api/markets/${encodeURIComponent(marketId)}/orderbook`);
}
