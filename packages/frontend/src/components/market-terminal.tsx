"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useState, type FormEvent } from "react";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { getOrderbook, type Market, type Orderbook } from "@/lib/api";

type Outcome = "YES" | "NO";
type Side = "BUY" | "SELL";
type PreparedOrder = {
  contract: string;
  address: string;
  requiredSatoshis: number;
  requiredTokenCategory: string | null;
  requiredTokenAmount: number;
  constructorArgs: unknown[];
};

const apiUrl = process.env.NEXT_PUBLIC_API_URL || "http://127.0.0.1:3001";

function bch(sats: number) {
  return (sats / 100_000_000).toFixed(4);
}

function shortHash(value: string) {
  return value ? `${value.slice(0, 10)}…${value.slice(-8)}` : "—";
}

function emptyBook(): Orderbook {
  return { yes: { bids: [], asks: [] }, no: { bids: [], asks: [] }, ticks: [] };
}

export default function MarketTerminal({ market, initialOrderbook }: { market: Market; initialOrderbook: Orderbook }) {
  const [orderbook, setOrderbook] = useState(initialOrderbook);
  const [outcome, setOutcome] = useState<Outcome>("YES");
  const [side, setSide] = useState<Side>("BUY");
  const [price, setPrice] = useState("500");
  const [shares, setShares] = useState("2");
  const [makerPubKey, setMakerPubKey] = useState("");
  const [makerAddress, setMakerAddress] = useState("");
  const [prepared, setPrepared] = useState<PreparedOrder | null>(null);
  const [txid, setTxid] = useState("");
  const [vout, setVout] = useState("");
  const [utxoSatoshis, setUtxoSatoshis] = useState("");
  const [tokenCategory, setTokenCategory] = useState("");
  const [tokenAmount, setTokenAmount] = useState("");
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  const [tab, setTab] = useState<"book" | "trades">("book");

  const refresh = useCallback(async () => {
    try {
      setOrderbook(await getOrderbook(market.id));
    } catch {
      setMessage("Could not refresh the order book. Check that the backend is running.");
    }
  }, [market.id]);

  useEffect(() => {
    const timer = window.setInterval(() => void refresh(), 8000);
    return () => window.clearInterval(timer);
  }, [refresh]);

  const currentBook = outcome === "YES" ? orderbook.yes : orderbook.no;
  const bestBid = useMemo(() => Math.max(0, ...currentBook.bids.map((row) => row.priceSats)), [currentBook.bids]);
  const bestAsk = useMemo(() => Math.min(1000, ...currentBook.asks.map((row) => row.priceSats)), [currentBook.asks]);
  const totalShares = useMemo(
    () => currentBook.bids.reduce((sum, row) => sum + row.shares, 0) + currentBook.asks.reduce((sum, row) => sum + row.shares, 0),
    [currentBook],
  );
  const isOpen = market.status === "OPEN";

  async function prepareOrder(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    setMessage("");
    setPrepared(null);
    try {
      const response = await fetch(`${apiUrl}/api/orders/prepare`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          marketId: market.id,
          side,
          outcome,
          priceSats: Number(price),
          shares: Number(shares),
          makerPubKey,
        }),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error?.message || data.error || "Could not prepare order.");
      setPrepared(data as PreparedOrder);
      setUtxoSatoshis(String(data.requiredSatoshis));
      setTokenCategory(data.requiredTokenCategory || "");
      setTokenAmount(data.requiredTokenAmount ? String(data.requiredTokenAmount) : "");
      setMessage("Order prepared. Fund the contract address from your BCH wallet, then enter its outpoint below.");
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Could not prepare order.");
    } finally {
      setBusy(false);
    }
  }

  async function registerOrder(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!prepared) return;
    setBusy(true);
    setMessage("");
    try {
      const body: Record<string, unknown> = {
        marketId: market.id,
        side,
        outcome,
        priceSats: Number(price),
        shares: Number(shares),
        makerPubKey,
        makerAddress,
        utxoTxid: txid.trim(),
        utxoVout: Number(vout),
        utxoSatoshis: Number(utxoSatoshis),
      };
      if (side === "SELL") {
        body.tokenCategory = tokenCategory.trim();
        body.tokenAmount = Number(tokenAmount);
      }
      const response = await fetch(`${apiUrl}/api/orders/register`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.message || data.error?.message || data.error || "Could not register order.");
      setMessage(data.matches?.length
        ? `Order registered. Settlement matched ${data.matches.map((match: { shares: number; txid: string }) => `${match.shares} shares · ${shortHash(match.txid)}`).join(", ")}.`
        : `Order registered as ${data.orderId}. It is resting until a compatible order arrives.`);
      setPrepared(null);
      setTxid("");
      setVout("");
      await refresh();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Could not register order.");
    } finally {
      setBusy(false);
    }
  }

  const midpoint = bestBid && bestAsk < 1000 ? Math.round((bestBid + bestAsk) / 2) : market[outcome === "YES" ? "lastYesPriceSats" : "lastNoPriceSats"];

  return (
    <main className="site-shell terminal-shell">
      <header className="topbar">
        <Link className="brand" href="/"><span className="brand-mark"><span /></span><span>outcome<span className="brand-dot">.</span></span></Link>
        <nav className="topnav" aria-label="Main navigation"><Link href="/" className="nav-active">Markets</Link><a href="/#how-it-works">How it works</a></nav>
        <div className="topbar-right"><span className="network-pill"><span className="live-dot" /> Chipnet</span><span className="wallet-button wallet-static">Market terminal</span></div>
      </header>

      <div className="breadcrumb"><Link href="/">Markets</Link><span>/</span><span>{market.title}</span></div>

      <section className="terminal-heading">
        <div>
          <div className="market-status"><i /> {isOpen ? "Trading open" : market.status.replace("_", " ")}</div>
          <h1>{market.title}</h1>
          <p>{market.description || "A binary outcome market on Bitcoin Cash."}</p>
          <div className="contract-line"><span>VAULT</span><code>{shortHash(market.vaultContractAddress)}</code><button type="button" onClick={() => navigator.clipboard?.writeText(market.vaultContractAddress)}>Copy address</button></div>
        </div>
        <div className="terminal-volume"><span>24h market volume</span><strong>{bch(market.volumeSats)} <small>BCH</small></strong><span className="volume-caption">Settled on Chipnet</span></div>
      </section>

      <section className="terminal-stats">
        <div><span>YES probability</span><strong>{(market.lastYesPriceSats / 10).toFixed(1)}<small>%</small></strong></div>
        <div><span>NO probability</span><strong>{(market.lastNoPriceSats / 10).toFixed(1)}<small>%</small></strong></div>
        <div><span>Last YES price</span><strong>{market.lastYesPriceSats}<small> sats</small></strong></div>
        <div><span>Last NO price</span><strong>{market.lastNoPriceSats}<small> sats</small></strong></div>
        <div><span>Open book depth</span><strong>{totalShares}<small> shares</small></strong></div>
      </section>

      <div className="terminal-grid">
        <Card className="panel book-panel">
          <div className="panel-heading"><div><span className="panel-kicker">LIVE MARKET</span><h2>Order book</h2></div><span className="refresh-note"><i /> Refreshes every 8s</span></div>
          <div className="outcome-tabs" role="tablist" aria-label="Choose outcome">
            <button className={outcome === "YES" ? "outcome-tab active-yes" : "outcome-tab"} onClick={() => setOutcome("YES")} type="button" role="tab" aria-selected={outcome === "YES"}>YES <strong>{(market.lastYesPriceSats / 10).toFixed(1)}¢</strong></button>
            <button className={outcome === "NO" ? "outcome-tab active-no" : "outcome-tab"} onClick={() => setOutcome("NO")} type="button" role="tab" aria-selected={outcome === "NO"}>NO <strong>{(market.lastNoPriceSats / 10).toFixed(1)}¢</strong></button>
          </div>
          <div className="book-summary"><span>Bid / ask</span><strong>{bestBid || "—"} <i>/</i> {bestAsk < 1000 ? bestAsk : "—"} <small>sats</small></strong><span>Mid <b>{midpoint} sats</b></span></div>
          <div className="book-columns">
            <div className="book-side asks"><div className="book-label"><span>ASKS</span><span>SHARES</span></div>
              {currentBook.asks.length ? [...currentBook.asks].sort((a, b) => a.priceSats - b.priceSats).map((row, i) => <div className="book-row" key={`ask-${row.priceSats}-${i}`}><span>{row.priceSats} <small>¢</small></span><b>{row.shares}</b><i style={{ width: `${Math.max(8, row.shares / Math.max(1, totalShares) * 100)}%` }} /></div>) : <div className="book-empty">No asks yet</div>}
            </div>
            <div className="book-side bids"><div className="book-label"><span>BIDS</span><span>SHARES</span></div>
              {currentBook.bids.length ? [...currentBook.bids].sort((a, b) => b.priceSats - a.priceSats).map((row, i) => <div className="book-row" key={`bid-${row.priceSats}-${i}`}><span>{row.priceSats} <small>¢</small></span><b>{row.shares}</b><i style={{ width: `${Math.max(8, row.shares / Math.max(1, totalShares) * 100)}%` }} /></div>) : <div className="book-empty">No bids yet</div>}
            </div>
          </div>
          <div className="book-panel-foot"><span>Price-time priority</span><span>1 share = 1,000 sats at resolution</span></div>
        </Card>

        <Card className="panel order-panel">
          <div className="panel-heading"><div><span className="panel-kicker">TAKE A POSITION</span><h2>Place an order</h2></div><span className="testnet-tag">TESTNET</span></div>
          {!isOpen && <div className="closed-message">This market is resolved and no longer accepts orders.</div>}
          <form onSubmit={prepareOrder} className="order-form">
            <div className="field-label">Direction</div>
            <div className="segmented">
              <button type="button" disabled={!!prepared} className={side === "BUY" ? "selected" : ""} onClick={() => { setSide("BUY"); setPrepared(null); }}>Buy</button>
              <button type="button" disabled={!!prepared} className={side === "SELL" ? "selected sell-selected" : ""} onClick={() => { setSide("SELL"); setPrepared(null); }}>Sell</button>
            </div>
            <div className="field-label">Outcome</div>
            <div className="segmented outcome-segment">
              <button type="button" disabled={!!prepared} className={outcome === "YES" ? "selected yes-selected" : ""} onClick={() => { setOutcome("YES"); setPrepared(null); }}>YES</button>
              <button type="button" disabled={!!prepared} className={outcome === "NO" ? "selected no-selected" : ""} onClick={() => { setOutcome("NO"); setPrepared(null); }}>NO</button>
            </div>
            <div className="form-two">
              <label>Limit price <span>sats / share</span><input type="number" min={1} max={999} required disabled={!!prepared} value={price} onChange={(event) => setPrice(event.target.value)} /></label>
              <label>Shares<input type="number" min={1} step={1} required disabled={!!prepared} value={shares} onChange={(event) => setShares(event.target.value)} /></label>
            </div>
            <label className="full-label">Maker public key <span>Compressed BCH public key</span><input placeholder="02… or 03…" required disabled={!!prepared} value={makerPubKey} onChange={(event) => { setMakerPubKey(event.target.value); setPrepared(null); }} /></label>
            <Button className="submit-order" type="submit" disabled={!isOpen || busy || !!prepared}>{busy ? "Working…" : prepared ? "Order prepared" : "Prepare order"} <span>↗</span></Button>
          </form>

          {prepared && (
            <form className="funding-form" onSubmit={registerOrder}>
              <div className="funding-callout"><span className="callout-icon">1</span><div><b>Fund the contract output</b><p>Send exactly {prepared.requiredSatoshis} sats for a BUY or {prepared.requiredTokenAmount} outcome tokens + 1,000 sats for a SELL.</p></div></div>
              <div className="copy-address"><code>{prepared.address}</code><button type="button" onClick={() => navigator.clipboard?.writeText(prepared.address)}>Copy</button></div>
              <div className="form-two">
                <label>Funding transaction ID<input required minLength={64} maxLength={64} value={txid} onChange={(event) => setTxid(event.target.value)} /></label>
                <label>Output index (vout)<input type="number" min={0} required value={vout} onChange={(event) => setVout(event.target.value)} /></label>
              </div>
              <label className="full-label">Maker payout address<input placeholder="bchtest:…" required value={makerAddress} onChange={(event) => setMakerAddress(event.target.value)} /></label>
              {side === "SELL" && <div className="form-two"><label>Token category<input required value={tokenCategory} onChange={(event) => setTokenCategory(event.target.value)} /></label><label>Token amount<input type="number" required value={tokenAmount} onChange={(event) => setTokenAmount(event.target.value)} /></label></div>}
              <input type="hidden" value={utxoSatoshis} readOnly aria-label="Required BCH amount" />
              <Button className="register-order" type="submit" disabled={busy}>{busy ? "Registering…" : "Register funded order"} <span>→</span></Button>
            </form>
          )}
          {message && <p className="form-message" role="status">{message}</p>}
          <p className="order-note"><span>ⓘ</span> Order preparation does not send BCH. Fund the address from your Chipnet wallet, then register the transaction output.</p>
        </Card>
      </div>

      <Card className="panel activity-panel">
        <div className="panel-heading"><div><span className="panel-kicker">MARKET ACTIVITY</span><h2>Recent trades</h2></div><div className="activity-tabs"><button className={tab === "book" ? "active" : ""} onClick={() => setTab("book")} type="button">Order book</button><button className={tab === "trades" ? "active" : ""} onClick={() => setTab("trades")} type="button">Trades <span>{orderbook.ticks.length}</span></button></div></div>
        {tab === "trades" ? (
          orderbook.ticks.length ? <div className="trade-list">{[...orderbook.ticks].reverse().slice(0, 8).map((trade, index) => <div className="trade-row" key={trade.id || trade.bchTxid || index}><span className="trade-type">{trade.matchType}</span><span>{trade.sharesTraded} shares</span><span>YES {trade.yesPriceSats}¢ · NO {trade.noPriceSats}¢</span><code>{shortHash(trade.bchTxid)}</code><button type="button" onClick={() => navigator.clipboard?.writeText(trade.bchTxid)}>Copy txid</button></div>)}</div> : <div className="activity-empty">No trades yet. Compatible orders settle automatically.</div>
        ) : (
          <div className="activity-empty">Order book updates automatically while this page is open.</div>
        )}
      </Card>

      <footer className="footer"><Link className="brand" href="/"><span className="brand-mark"><span /></span><span>outcome<span className="brand-dot">.</span></span></Link><span>Binary markets, settled on Bitcoin Cash.</span><span className="footer-network"><i /> Chipnet test environment</span></footer>
    </main>
  );
}
