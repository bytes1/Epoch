import { notFound } from "next/navigation";
import MarketTerminal from "@/components/market-terminal";
import { getMarkets, getOrderbook } from "@/lib/api";

export default async function MarketPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  let market;
  try {
    const markets = await getMarkets();
    market = markets.find((item) => item.id === id);
  } catch {
    notFound();
  }
  if (!market) notFound();

  const orderbook = await getOrderbook(id).catch(() => ({
    yes: { bids: [], asks: [] },
    no: { bids: [], asks: [] },
    ticks: [],
  }));

  return <MarketTerminal market={market} initialOrderbook={orderbook} />;
}
