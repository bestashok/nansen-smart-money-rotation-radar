import { useEffect, useMemo, useState } from "react";

const money = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 });
const compact = new Intl.NumberFormat("en-US", { notation: "compact", maximumFractionDigits: 1 });

function shortAddress(address = "") { return address.length > 14 ? `${address.slice(0, 7)}…${address.slice(-5)}` : address; }

async function writeClipboard(text) {
  if (navigator.clipboard?.writeText) {
    await navigator.clipboard.writeText(text);
    return;
  }

  const textarea = document.createElement("textarea");
  textarea.value = text;
  textarea.setAttribute("readonly", "");
  textarea.style.position = "fixed";
  textarea.style.opacity = "0";
  document.body.appendChild(textarea);
  textarea.select();
  const copied = document.execCommand("copy");
  textarea.remove();
  if (!copied) throw new Error("Clipboard access is unavailable.");
}

function CopyAddress({ address, shorten = false }) {
  const [copyState, setCopyState] = useState("idle");

  async function copyAddress(event) {
    event.stopPropagation();
    try {
      await writeClipboard(address);
      setCopyState("copied");
    } catch {
      setCopyState("error");
    }
    window.setTimeout(() => setCopyState("idle"), 1600);
  }

  const label = copyState === "copied" ? "Contract address copied" : copyState === "error" ? "Copy failed" : "Copy contract address";
  return <span className="contract-address">
    <code title={address}>{shorten ? shortAddress(address) : address}</code>
    <button type="button" className={`copy-button ${copyState}`} aria-label={label} title={label} onClick={copyAddress}>
      {copyState === "copied"
        ? <svg viewBox="0 0 16 16" aria-hidden="true"><path d="m3.5 8 3 3 6-7" /></svg>
        : <svg viewBox="0 0 16 16" aria-hidden="true"><rect x="5.5" y="2.5" width="8" height="9" rx="1" /><path d="M10.5 13.5h-7a1 1 0 0 1-1-1v-8" /></svg>}
    </button>
    <span className="sr-only" aria-live="polite">{copyState === "copied" ? "Copied" : copyState === "error" ? "Copy failed" : ""}</span>
  </span>;
}

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
    <div><label>Token</label><strong>{item.token.symbol} · {item.token.chain}</strong><CopyAddress address={item.token.contractAddress} /></div>
    <div><label>Smart Money</label><strong>{item.buyers.length} buyers / {item.sellers.length} sellers</strong><span>Netflow {money.format(item.flowIntelligence?.[0]?.smartTraderNetFlowUsd ?? item.token.netflowUsd ?? 0)}</span></div>
    <div><label>Holders</label><strong>{item.holders.length} researched</strong><span>Top holder {(100 * (item.holders[0]?.ownershipPercentage ?? 0)).toFixed(2)}%</span></div>
    <div><label>Final</label><strong>{item.score}/100 · {item.state}</strong><span>{item.explanation}</span></div>
    <div className="wide"><label>Wallet evidence</label><div className="wallets">{[...item.buyers.slice(0, 4), ...item.sellers.slice(0, 4)].map((wallet, index) => <span key={`${wallet.address}-${index}`} title={wallet.address}>{shortAddress(wallet.address)} {wallet.label && `· ${wallet.label}`}</span>)}</div></div>
  </div>;
}

export default function App() {
  const [status, setStatus] = useState({ phase: "IDLE", running: false, message: "Ready for a live scan.", apiCallLimit: 909, campaignCallsSent: 0, runCallLimit: null, totalCalls: 0, successfulCalls: 0, failedCalls: 0, retries: 0, creditsReserved: 0, creditsRemainingFromBudget: null, spendableCredits: null });
  const [results, setResults] = useState(null);
  const [usage, setUsage] = useState({ cumulativeRealNansenApiCalls: 0, consumedCredits: 0 });
  const [campaign, setCampaign] = useState({ targetApiCalls: 909, campaignCallsSent: 0, cumulativeRealNansenApiCalls: 0, callsRemaining: 909, completedRuns: 0, latest: null, canRun: true });
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
    const [nextStatus, nextResults, nextUsage, nextCampaign] = await Promise.all([
      fetch("/api/status").then((r) => r.json()),
      fetch("/api/results").then((r) => r.json()),
      fetch("/api/usage").then((r) => r.json()),
      fetch("/api/campaign").then((r) => r.json()),
    ]);
    setStatus(nextStatus); setResults(nextResults); setUsage(nextUsage); setCampaign(nextCampaign);
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

  async function runCampaign() {
    setScanError("");
    const response = await fetch("/api/campaign", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ creditLimit: Number(creditLimit) }),
    });
    if (!response.ok) {
      const body = await response.json().catch(() => ({}));
      setScanError(body.error ?? "Live Scan 2 could not be started.");
      return;
    }
    await refresh();
  }

  return <main>
    <header><div><p className="eyebrow">NANSEN · MULTI-CHAIN INTELLIGENCE</p><h1>SMART MONEY<br /><em>ROTATION RADAR</em></h1><p className="subtitle">See where Smart Money appears to be rotating before the crowd.</p></div><div className="scan-controls"><label>Maximum Nansen credits<input type="number" min="10" max="200" step="10" value={creditLimit} disabled={status.running} onChange={(event) => setCreditLimit(event.target.value)} /></label><small>Default 200 · maximum 200 · no token-count limit · conservative safety accounting</small><button disabled={status.running || !Number.isSafeInteger(Number(creditLimit)) || Number(creditLimit) < 10 || Number(creditLimit) > 200} onClick={runScan}>{status.running ? "SCAN IN PROGRESS" : "RUN LIVE SCAN"}</button></div></header>

    <section className={`status ${status.phase === "FAILED" || scanError ? "danger" : ""}`}><span className={status.running ? "pulse" : "dot"} /><div><label>{status.phase.replaceAll("_", " ")} · CAMPAIGN HARD CAP {status.apiCallLimit ?? 909} CALLS · SENT {status.campaignCallsSent ?? 0}/{status.apiCallLimit ?? 909}</label><strong>{scanError || status.message}</strong></div></section>

    <section className="metrics">
      <article><label>Qualifying tokens</label><strong>{results?.tokensDiscovered ?? "—"}</strong></article>
      <article><label>Analyzed</label><strong>{results?.tokensAnalyzed ?? "—"}</strong></article>
      <article><label>Skipped by budget</label><strong>{results?.tokensSkippedByBudget ?? "—"}</strong></article>
      <article><label>Credits reserved</label><strong>{results?.creditBudget ? `${results.creditBudget.reservedCredits}/${results.creditBudget.limit}` : "—"}</strong></article>
      <article><label>Live API calls (this run)</label><strong>{status.totalCalls ?? "—"}</strong></article>
      <article><label>Cumulative API calls (incl. original 91)</label><strong>{usage.cumulativeRealNansenApiCalls ?? 0}</strong></article>
      <article><label>Credits consumed (this run)</label><strong>{status.creditsReserved > 0 || status.running ? `${status.creditsReserved ?? 0}${status.spendableCredits != null ? `/${status.spendableCredits}` : ""}` : "—"}</strong></article>
      <article><label>Credits consumed (all time)</label><strong>{usage.consumedCredits ?? 0}</strong></article>
      <article><label>Nansen credits left (last call)</label><strong>{status.creditsRemaining ?? "—"}</strong></article>
      <article><label>Total time</label><strong>{results ? `${(results.totalDurationMs / 1000).toFixed(1)}s` : "—"}</strong></article>
    </section>

    <section className="panel campaign-panel"><div className="panel-title"><div><p>LIVE SCAN 2 CAMPAIGN</p><h2>Broader wallet coverage · {campaign.targetApiCalls ?? 909} genuine-call campaign total</h2></div><span>{campaign.completedRuns} completed cycles</span></div>
      <div className="campaign-layout"><div><div className="campaign-count"><strong>{campaign.campaignCallsSent ?? campaign.cumulativeRealNansenApiCalls ?? 0}</strong><span>/ {campaign.targetApiCalls ?? 909} REAL CALLS</span></div><div className="progress"><i style={{ width: `${Math.min(100, ((campaign.campaignCallsSent ?? campaign.cumulativeRealNansenApiCalls ?? 0) / (campaign.targetApiCalls || 909)) * 100)}%` }} /></div><div className="campaign-count live-api-count"><strong>{status.totalCalls ?? 0}</strong><span>/ {status.runCallLimit ?? status.apiCallLimit ?? 909} LIVE API CALLS THIS RUN · HARD CAP</span><small>{status.spendableCredits != null ? `${status.creditsReserved ?? 0}/${status.spendableCredits} credits spent this run · 5-credit reserve` : ""}</small></div><p>Each Live Scan 2 cycle collects BUY/SELL wallet evidence, flow context, and holder depth across every qualifying token until the run budget is spent or distinct research runs out, then tests genuine cross-token overlap. A 15-minute cooldown prevents duplicate runs. One run may send up to {status.runCallLimit ?? status.apiCallLimit ?? 909} real Nansen requests, retries included, and the campaign total never exceeds {status.apiCallLimit ?? 909}. When the Nansen balance is known the cycle is credit-aware: it spends at most {status.spendableCredits ?? "the balance"} credits (a 5-credit safety reserve is kept) and fills that spend with 1-credit research before ever scheduling a 5-credit holder call, so scarce credits buy the maximum number of genuine, distinct requests.</p></div><div className="campaign-action"><button className="secondary" disabled={status.running || !campaign.canRun || !Number.isSafeInteger(Number(creditLimit)) || Number(creditLimit) < 10 || Number(creditLimit) > 200} onClick={runCampaign}>{campaign.callsRemaining === 0 ? "TARGET COMPLETE" : "RUN LIVE SCAN 2"}</button><small>{campaign.callsRemaining ?? 909} campaign calls remaining{!campaign.canRun && campaign.callsRemaining > 0 && campaign.nextEligibleAt ? ` · next cycle ${new Date(campaign.nextEligibleAt).toLocaleTimeString()}` : ""}</small></div></div>
      {campaign.latest && <div className="campaign-latest"><span>Latest: {campaign.latest.tokensPairedForResearch} tokens with BUY/SELL pairs · {campaign.latest.runReport?.nansenApiCallsSent ?? campaign.latest.totalCalls ?? campaign.latest.liveApiCalls}/{campaign.latest.runReport?.runCallLimit ?? campaign.latest.apiCallLimit ?? 909} Nansen API calls sent — {campaign.latest.successfulCalls ?? "—"} successful, {campaign.latest.failedCalls ?? "—"} failed, {campaign.latest.retries ?? 0} retries · {campaign.latest.runReport ? `${campaign.latest.runReport.callsRemainingFromRunBudget} remaining in run budget · ${campaign.latest.creditBudget?.reservedCredits ?? 0}/${campaign.latest.creditBudget?.limit ?? 909} credits reserved` : `${campaign.latest.liveApiCalls} live calls · ${campaign.latest.creditBudget?.reservedCredits ?? 0}/${campaign.latest.creditBudget?.limit ?? 200} credits reserved`}</span>{campaign.latest.runReport?.stopReason && <span>Stop reason: {campaign.latest.runReport.stopReason}</span>}<RotationMap rotations={campaign.latest.rotations} /></div>}
    </section>

    <section className="panel"><div className="panel-title"><div><p>DISCOVERED TOKENS</p><h2>Every qualifying token returned by Nansen</h2></div><span>{tableRows.length} rows</span></div>
      {!tableRows.length ? <div className="empty">No completed scan results yet. Run a live scan to populate real Nansen evidence.</div> : <div className="table-wrap"><table><thead><tr><th>#</th><th>Token</th><th>Chain</th><th>Contract</th><th>Market cap</th><th>Liquidity</th><th>Netflow</th><th>Buyers</th><th>Sellers</th><th>Score</th><th>State</th><th>Status</th></tr></thead><tbody>{tableRows.map(({ token, research }, index) => <tr key={`${token.chain}-${token.contractAddress}`} onClick={() => research && setSelectedAddress(token.contractAddress)} className={selected?.token.contractAddress === token.contractAddress ? "selected" : ""}><td>{index + 1}</td><td><b>{token.symbol}</b></td><td>{token.chain}</td><td><CopyAddress address={token.contractAddress} shorten /></td><td>{compact.format(token.marketCapUsd ?? 0)}</td><td>{compact.format(token.liquidityUsd ?? 0)}</td><td className={(token.netflowUsd ?? 0) >= 0 ? "positive" : "negative"}>{money.format(token.netflowUsd ?? 0)}</td><td>{research?.buyers.length ?? "—"}</td><td>{research?.sellers.length ?? "—"}</td><td><b>{research?.score ?? "—"}</b></td><td>{research ? <span className={`pill ${research.state}`}>{research.state}</span> : "—"}</td><td><span className={`scan-state ${research ? "complete" : "skipped"}`}>{research ? "ANALYZED" : "SKIPPED · BUDGET"}</span></td></tr>)}</tbody></table></div>}
    </section>

    <div className="split"><section className="panel"><div className="panel-title"><div><p>ROTATION MAP</p><h2>Observed wallet overlap</h2></div></div><RotationMap rotations={results?.rotations} /></section><section className="panel"><div className="panel-title"><div><p>TOKEN EVIDENCE</p><h2>{selected?.token.symbol ?? "Select a token"}</h2></div></div><TokenDetail item={selected} /></section></div>
    <footer>Observed Smart Money Rotation is an inference from overlapping wallet behavior—not proof of direct fund transfer or financial advice.</footer>
  </main>;
}
