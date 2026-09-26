import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { API_CALL_LIMIT } from "./eligibilityCampaign.js";

const campaignPath = path.resolve("data/campaign-history.json");

export async function readCampaignHistory() {
  try { return JSON.parse(await readFile(campaignPath, "utf8")); }
  catch { return []; }
}

export async function saveCampaignRun(run) {
  const history = await readCampaignHistory();
  history.unshift(run);
  await mkdir(path.dirname(campaignPath), { recursive: true });
  const temporaryPath = `${campaignPath}.tmp`;
  await writeFile(temporaryPath, JSON.stringify(history.slice(0, 100), null, 2));
  await rename(temporaryPath, campaignPath);
}

// Genuine Nansen calls already made by every recorded campaign cycle. Legacy
// runs that stored no totals contribute 0 so the ledger never over-counts.
export function campaignCallsSent(history = []) {
  return history.reduce((total, run) => {
    const sent = run?.runReport?.nansenApiCallsSent ?? run?.totalCalls;
    return total + (Number.isSafeInteger(sent) && sent > 0 ? sent : 0);
  }, 0);
}

// Hard maximum for the next continuation: whatever is left of the campaign's
// API_CALL_LIMIT total (909 - calls already sent). Never negative.
export function campaignCallsRemaining(history = [], limit = API_CALL_LIMIT) {
  return Math.max(0, limit - campaignCallsSent(history));
}

// Explains how the all-time total divides up. `recorded` is what the cap counts
// and what campaignCallsSent returns; it is deliberately NOT changed here,
// because enforcement must keep using the same number it always has.
//
// `actual` is what the cumulative ledger says was really spent inside campaign
// cycles, taken from each run's cumulativeCallsBefore/After pair. The two
// differ for two honest reasons:
//   - 3 legacy runs (Sept 23-24) stored liveApiCalls but no runReport, so the
//     cap scored them 0 while the cumulative ledger still counted their calls;
//   - 2 later runs recorded more than the cumulative ledger advanced, dropping
//     10 increments to a write race in appendUsage (since fixed).
// `outsideRuns` is everything genuine that happened with no campaign cycle
// running, i.e. plain Run Live Scan.
export function campaignCallAccounting(history = []) {
  const recorded = campaignCallsSent(history);
  const actual = history.reduce(
    (total, run) => total + (
      Number.isSafeInteger(run?.cumulativeCallsBefore) &&
      Number.isSafeInteger(run?.cumulativeCallsAfter) &&
      run.cumulativeCallsAfter >= run.cumulativeCallsBefore
        ? run.cumulativeCallsAfter - run.cumulativeCallsBefore
        : 0
    ),
    0,
  );
  return {
    recorded,
    actual,
    unrecorded: Math.max(0, actual - recorded),
  };
}

