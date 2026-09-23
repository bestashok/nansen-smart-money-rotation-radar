import { useEffect, useMemo, useState } from "react";

const money = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 });
const compact = new Intl.NumberFormat("en-US", { notation: "compact", maximumFractionDigits: 1 });

function shortAddress(address = "") { return address.length > 14 ? `${address.slice(0, 7)}…${address.slice(-5)}` : address; }

function RotationMap({ rotations }) {
  if (!rotations?.length) return <div className="empty">No probable wallet-overlap rotations were observed in this scan.</div>;
  return <div className="edges">{rotations.map((edge, index) => <article className="edge" key={`${edge.sourceToken.contractAddress}-${edge.destinationToken.contractAddress}-${index}`}>
    <span>{edge.sourceToken.symbol}</span><b>→</b><span>{edge.destinationToken.symbol}</span>
    <small>{edge.overlappingWalletCount} overlapping wallet{edge.overlappingWalletCount === 1 ? "" : "s"} · {edge.confidence}% confidence</small>
  </article>)}</div>;
}

function TokenDetail({ item }) {
  if (!item) return <div className="empty">Select a token to inspect its evidence.</div>;
  return <div className="detail-grid">
    <div><label>Token</label><strong>{item.token.symbol} · {item.token.chain}</strong><code>{item.token.contractAddress}</code></div>
    <div><label>Smart Money</label><strong>{item.buyers.length} buyers / {item.sellers.length} sellers</strong><span>Netflow {money.format(item.flowIntelligence?.[0]?.smartTraderNetFlowUsd ?? item.token.netflowUsd ?? 0)}</span></div>
    <div><label>Holders</label><strong>{item.holders.length} researched</strong><span>Top holder {(100 * (item.holders[0]?.ownershipPercentage ?? 0)).toFixed(2)}%</span></div>
    <div><label>Final</label><strong>{item.score}/100 · {item.state}</strong><span>{item.explanation}</span></div>
    <div className="wide"><label>Wallet evidence</label><div className="wallets">{[...item.buyers.slice(0, 4), ...item.sellers.slice(0, 4)].map((wallet, index) => <span key={`${wallet.address}-${index}`} title={wallet.address}>{shortAddress(wallet.address)} {wallet.label && `· ${wallet.label}`}</span>)}</div></div>
  </div>;
}

export default function App() {
  const [status, setStatus] = useState({ phase: "IDLE", running: false, message: "Ready for a live scan." });
  const [results, setResults] = useState(null);
  const [usage, setUsage] = useState({ cumulativeRealNansenApiCalls: 0 });
  const [selectedAddress, setSelectedAddress] = useState(null);
  const selected = useMemo(() => results?.tokens?.find((item) => item.token.contractAddress === selectedAddress) ?? results?.tokens?.[0], [results, selectedAddress]);

  async function refresh() {
    const [nextStatus, nextResults, nextUsage] = await Promise.all([
      fetch("/api/status").then((r) => r.json()),
      fetch("/api/results").then((r) => r.json()),
      fetch("/api/usage").then((r) => r.json()),
    ]);
    setStatus(nextStatus); setResults(nextResults); setUsage(nextUsage);
  }
  useEffect(() => { refresh(); const timer = setInterval(refresh, 1500); return () => clearInterval(timer); }, []);

  async function runScan() {
    await fetch("/api/scan", { method: "POST" });
    await refresh();
  }

  return <main>
    <header><div><p className="eyebrow">NANSEN · MULTI-CHAIN INTELLIGENCE</p><h1>SMART MONEY<br /><em>ROTATION RADAR</em></h1><p className="subtitle">See where Smart Money appears to be rotating before the crowd.</p></div><button disabled={status.running} onClick={runScan}>{status.running ? "SCAN IN PROGRESS" : "RUN LIVE SCAN"}</button></header>

    <section className={`status ${status.phase === "FAILED" ? "danger" : ""}`}><span className={status.running ? "pulse" : "dot"} /><div><label>{status.phase.replaceAll("_", " ")} · HARD CAP 200 CREDITS</label><strong>{status.message}</strong></div></section>

    <section className="metrics">
      <article><label>Qualifying tokens</label><strong>{results?.tokensDiscovered ?? "—"}</strong></article>
      <article><label>Analyzed</label><strong>{results?.tokensAnalyzed ?? "—"}</strong></article>
      <article><label>Current scan calls</label><strong>{results?.liveApiCalls ?? "—"}</strong></article>
      <article><label>Cumulative real calls</label><strong>{usage.cumulativeRealNansenApiCalls ?? 0}</strong></article>
      <article><label>Total time</label><strong>{results ? `${(results.totalDurationMs / 1000).toFixed(1)}s` : "—"}</strong></article>
    </section>

    <section className="panel"><div className="panel-title"><div><p>DISCOVERED TOKENS</p><h2>Evidence-ranked opportunities</h2></div><span>{results?.tokens?.length ?? 0} rows</span></div>
      {!results?.tokens?.length ? <div className="empty">No completed scan results yet. Run a live scan to populate real Nansen evidence.</div> : <div className="table-wrap"><table><thead><tr><th>#</th><th>Token</th><th>Chain</th><th>Contract</th><th>Market cap</th><th>Liquidity</th><th>Netflow</th><th>Buyers</th><th>Sellers</th><th>Score</th><th>State</th></tr></thead><tbody>{results.tokens.map((item, index) => <tr key={`${item.token.chain}-${item.token.contractAddress}`} onClick={() => setSelectedAddress(item.token.contractAddress)} className={selected?.token.contractAddress === item.token.contractAddress ? "selected" : ""}><td>{index + 1}</td><td><b>{item.token.symbol}</b></td><td>{item.token.chain}</td><td><code title={item.token.contractAddress}>{shortAddress(item.token.contractAddress)}</code></td><td>{compact.format(item.token.marketCapUsd ?? 0)}</td><td>{compact.format(item.token.liquidityUsd ?? 0)}</td><td className={(item.token.netflowUsd ?? 0) >= 0 ? "positive" : "negative"}>{money.format(item.token.netflowUsd ?? 0)}</td><td>{item.buyers.length}</td><td>{item.sellers.length}</td><td><b>{item.score}</b></td><td><span className={`pill ${item.state}`}>{item.state}</span></td></tr>)}</tbody></table></div>}
    </section>

    <div className="split"><section className="panel"><div className="panel-title"><div><p>ROTATION MAP</p><h2>Observed wallet overlap</h2></div></div><RotationMap rotations={results?.rotations} /></section><section className="panel"><div className="panel-title"><div><p>TOKEN EVIDENCE</p><h2>{selected?.token.symbol ?? "Select a token"}</h2></div></div><TokenDetail item={selected} /></section></div>
    <footer>Observed Smart Money Rotation is an inference from overlapping wallet behavior—not proof of direct fund transfer or financial advice.</footer>
  </main>;
}
