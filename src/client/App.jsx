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
  const [creditLimit, setCreditLimit] = useState("200");
  const [scanError, setScanError] = useState("");
  const selected = useMemo(() => results?.tokens?.find((item) => item.token.contractAddress === selectedAddress) ?? results?.tokens?.[0], [results, selectedAddress]);
  const tableRows = useMemo(() => {
    const researched = new Map((results?.tokens ?? []).map((item) => [`${item.token.chain}:${item.token.contractAddress}`, item]));
    const discovered = results?.discoveredTokens ?? (results?.tokens ?? []).map((item) => item.token);
    return discovered.map((token) => ({ token, research: researched.get(`${token.chain}:${token.contractAddress}`) ?? null }));
  }, [results]);

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
    setScanError("");
    const response = await fetch("/api/scan", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ creditLimit: Number(creditLimit) }),
    });
    if (!response.ok) {
      const body = await response.json().catch(() => ({}));
      setScanError(body.error ?? "The scan could not be started.");
      return;
    }
    await refresh();
  }

  return <main>
    <header><div><p className="eyebrow">NANSEN · MULTI-CHAIN INTELLIGENCE</p><h1>SMART MONEY<br /><em>ROTATION RADAR</em></h1><p className="subtitle">See where Smart Money appears to be rotating before the crowd.</p></div><div className="scan-controls"><label>Maximum Nansen credits<input type="number" min="10" max="200" step="10" value={creditLimit} disabled={status.running} onChange={(event) => setCreditLimit(event.target.value)} /></label><small>Maximum 200 · no token-count limit · approximately 90 credits per fully researched token</small><button disabled={status.running || !Number.isSafeInteger(Number(creditLimit)) || Number(creditLimit) < 10 || Number(creditLimit) > 200} onClick={runScan}>{status.running ? "SCAN IN PROGRESS" : "RUN LIVE SCAN"}</button></div></header>

    <section className={`status ${status.phase === "FAILED" || scanError ? "danger" : ""}`}><span className={status.running ? "pulse" : "dot"} /><div><label>{status.phase.replaceAll("_", " ")} · HARD CAP {status.creditLimit ?? creditLimit} CREDITS</label><strong>{scanError || status.message}</strong></div></section>

    <section className="metrics">
      <article><label>Qualifying tokens</label><strong>{results?.tokensDiscovered ?? "—"}</strong></article>
      <article><label>Analyzed</label><strong>{results?.tokensAnalyzed ?? "—"}</strong></article>
      <article><label>Skipped by budget</label><strong>{results?.tokensSkippedByBudget ?? "—"}</strong></article>
      <article><label>Credits reserved</label><strong>{results?.creditBudget ? `${results.creditBudget.reservedCredits}/${results.creditBudget.limit}` : "—"}</strong></article>
      <article><label>Current scan calls</label><strong>{results?.liveApiCalls ?? "—"}</strong></article>
      <article><label>Cumulative real calls</label><strong>{usage.cumulativeRealNansenApiCalls ?? 0}</strong></article>
      <article><label>Total time</label><strong>{results ? `${(results.totalDurationMs / 1000).toFixed(1)}s` : "—"}</strong></article>
    </section>

    <section className="panel"><div className="panel-title"><div><p>DISCOVERED TOKENS</p><h2>Every qualifying token returned by Nansen</h2></div><span>{tableRows.length} rows</span></div>
      {!tableRows.length ? <div className="empty">No completed scan results yet. Run a live scan to populate real Nansen evidence.</div> : <div className="table-wrap"><table><thead><tr><th>#</th><th>Token</th><th>Chain</th><th>Contract</th><th>Market cap</th><th>Liquidity</th><th>Netflow</th><th>Buyers</th><th>Sellers</th><th>Score</th><th>State</th><th>Status</th></tr></thead><tbody>{tableRows.map(({ token, research }, index) => <tr key={`${token.chain}-${token.contractAddress}`} onClick={() => research && setSelectedAddress(token.contractAddress)} className={selected?.token.contractAddress === token.contractAddress ? "selected" : ""}><td>{index + 1}</td><td><b>{token.symbol}</b></td><td>{token.chain}</td><td><code title={token.contractAddress}>{shortAddress(token.contractAddress)}</code></td><td>{compact.format(token.marketCapUsd ?? 0)}</td><td>{compact.format(token.liquidityUsd ?? 0)}</td><td className={(token.netflowUsd ?? 0) >= 0 ? "positive" : "negative"}>{money.format(token.netflowUsd ?? 0)}</td><td>{research?.buyers.length ?? "—"}</td><td>{research?.sellers.length ?? "—"}</td><td><b>{research?.score ?? "—"}</b></td><td>{research ? <span className={`pill ${research.state}`}>{research.state}</span> : "—"}</td><td><span className={`scan-state ${research ? "complete" : "skipped"}`}>{research ? "ANALYZED" : "SKIPPED · BUDGET"}</span></td></tr>)}</tbody></table></div>}
    </section>

    <div className="split"><section className="panel"><div className="panel-title"><div><p>ROTATION MAP</p><h2>Observed wallet overlap</h2></div></div><RotationMap rotations={results?.rotations} /></section><section className="panel"><div className="panel-title"><div><p>TOKEN EVIDENCE</p><h2>{selected?.token.symbol ?? "Select a token"}</h2></div></div><TokenDetail item={selected} /></section></div>
    <footer>Observed Smart Money Rotation is an inference from overlapping wallet behavior—not proof of direct fund transfer or financial advice.</footer>
  </main>;
}
