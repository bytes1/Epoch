import Link from "next/link";
import { Card } from "@/components/ui/card";
import { getMarkets, type Market } from "@/lib/api";

function formatBch(sats: number) {
  return (sats / 100_000_000).toFixed(4);
}

function probability(sats: number) {
  return `${(sats / 10).toFixed(1)}%`;
}

function statusLabel(market: Market) {
  if (market.status === "RESOLVED_YES") return "Resolved · YES";
  if (market.status === "RESOLVED_NO") return "Resolved · NO";
  return "Trading";
}

export default async function Home() {
  let markets: Market[] = [];
  let apiOnline = true;
  try {
    markets = await getMarkets();
  } catch {
    apiOnline = false;
  }

  const openMarkets = markets.filter((market) => market.status === "OPEN").length;
  const totalVolume = markets.reduce((sum, market) => sum + market.volumeSats, 0);

  return (
    <main className="site-shell">
      <header className="topbar">
        <Link className="brand" href="/" aria-label="Outcome home">
          <span className="brand-mark"><span /></span>
          <span>outcome<span className="brand-dot">.</span></span>
        </Link>
        <nav className="topnav" aria-label="Main navigation">
          <a className="nav-active" href="#markets">Markets</a>
          <a href="#how-it-works">How it works</a>
        </nav>
        <div className="topbar-right">
          <span className="network-pill"><span className="live-dot" /> Chipnet</span>
          <a className="wallet-button" href="#markets">Explore markets <span aria-hidden="true">↗</span></a>
        </div>
      </header>

      <section className="hero">
        <div className="hero-copy">
          <div className="eyebrow"><span className="eyebrow-line" /> Prediction markets on Bitcoin Cash</div>
          <h1>Turn a point of view<br />into a <em>position.</em></h1>
          <p>Trade on what happens next. Every market resolves to a simple YES or NO, backed by on-chain BCH.</p>
          <a className="primary-link" href="#markets">Explore live markets <span>↓</span></a>
          <div className="hero-footnote"><span className="shield-icon">◇</span> Non-custodial settlement · Built on BCH</div>
        </div>

        <div className="hero-visual" aria-label="Illustration of a binary market probability">
          <div className="visual-orbit orbit-one" />
          <div className="visual-orbit orbit-two" />
          <div className="visual-card">
            <div className="visual-card-top"><span>MARKET PROBABILITY</span><span className="visual-live"><i /> LIVE</span></div>
            <div className="visual-question">Will the next block arrive<br />in under 10 minutes?</div>
            <div className="visual-stat-row"><strong>YES</strong><b>68%</b></div>
            <div className="probability-track"><span /></div>
            <div className="visual-stat-row muted"><span>NO</span><b>32%</b></div>
            <div className="visual-chart"><span /><span /><span /><span /><span /><span /><span /><span /><span /><span /><span /><span /><span /><span /><span /><span /><span /><span /><span /></div>
            <div className="visual-card-bottom"><span>Volume</span><strong>1.42 BCH</strong><span className="visual-change">+4.2%</span></div>
          </div>
          <div className="floating-chip chip-yes"><span>YES</span><strong>68¢</strong><i>↗</i></div>
          <div className="floating-chip chip-no"><span>NO</span><strong>32¢</strong><i>↘</i></div>
          <div className="hero-spark spark-a">✳</div>
          <div className="hero-spark spark-b">✳</div>
        </div>
      </section>

      <section className="stats-strip" aria-label="Market statistics">
        <div><span className="stat-label">Active markets</span><strong>{apiOnline ? openMarkets.toString().padStart(2, "0") : "—"}</strong></div>
        <div><span className="stat-label">Markets listed</span><strong>{apiOnline ? markets.length.toString().padStart(2, "0") : "—"}</strong></div>
        <div><span className="stat-label">Total volume</span><strong>{apiOnline ? `${formatBch(totalVolume)} <small>BCH</small>` : "—"}</strong></div>
        <div className="stats-note"><span className={apiOnline ? "live-dot" : "offline-dot"} />{apiOnline ? "Connected to Chipnet" : "Backend unavailable"}</div>
      </section>

      <section id="markets" className="markets-section">
        <div className="section-heading">
          <div><div className="eyebrow"><span className="eyebrow-line" /> The pulse of what’s next</div><h2>Explore markets</h2></div>
          <span className="market-count">{markets.length} {markets.length === 1 ? "market" : "markets"}</span>
        </div>

        {!apiOnline ? (
          <div className="empty-panel">
            <span className="empty-icon">↗</span><h3>Can’t reach the market API</h3>
            <p>Start the Fastify backend on port 3001, then refresh this page.</p>
          </div>
        ) : markets.length === 0 ? (
          <div className="empty-panel">
            <span className="empty-icon">◎</span><h3>No markets yet</h3>
            <p>Create a market through the backend API to see it here.</p>
          </div>
        ) : (
          <div className="market-grid">
            {markets.map((market, index) => (
              <Link className="market-card-link" href={`/markets/${market.id}`} key={market.id}>
                <Card className="market-card">
                <div className="market-card-meta"><span className={market.status === "OPEN" ? "market-status" : "market-status resolved"}><i />{statusLabel(market)}</span><span className="market-index">0{index + 1}</span></div>
                <h3>{market.title}</h3>
                <p className="market-description">{market.description || "A binary outcome market on Bitcoin Cash."}</p>
                <div className="market-probabilities">
                  <div><span>YES</span><strong>{probability(market.lastYesPriceSats)}</strong><div className="mini-track yes-track"><i style={{ width: probability(market.lastYesPriceSats) }} /></div></div>
                  <div><span>NO</span><strong>{probability(market.lastNoPriceSats)}</strong><div className="mini-track no-track"><i style={{ width: probability(market.lastNoPriceSats) }} /></div></div>
                </div>
                <div className="market-card-foot"><span>Volume <b>{formatBch(market.volumeSats)} BCH</b></span><span className="market-open">Open market <b>↗</b></span></div>
                </Card>
              </Link>
            ))}
          </div>
        )}
      </section>

      <section id="how-it-works" className="how-section">
        <div className="how-heading"><div className="eyebrow"><span className="eyebrow-line" /> Straightforward by design</div><h2>Make a call.<br /><em>See it through.</em></h2></div>
        <div className="how-steps">
          <article><span className="step-number">01</span><span className="step-icon">◎</span><h3>Choose a market</h3><p>Find a question you have a view on. Every market has two outcomes: YES and NO.</p></article>
          <article><span className="step-number">02</span><span className="step-icon">↗</span><h3>Place your position</h3><p>Set your price and shares. Orders settle on-chain when compatible positions match.</p></article>
          <article><span className="step-number">03</span><span className="step-icon">✳</span><h3>Resolve and redeem</h3><p>When the outcome is known, winning shares can be redeemed for BCH.</p></article>
        </div>
      </section>

      <footer className="footer"><Link className="brand" href="/"><span className="brand-mark"><span /></span><span>outcome<span className="brand-dot">.</span></span></Link><span>Binary markets, settled on Bitcoin Cash.</span><span className="footer-network"><i /> Chipnet test environment</span></footer>
    </main>
  );
}
