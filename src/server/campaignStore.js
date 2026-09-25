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
// API_CALL_LIMIT total (909 - 620 already sent = 289 today). Never negative.
export function campaignCallsRemaining(history = [], limit = API_CALL_LIMIT) {
  return Math.max(0, limit - campaignCallsSent(history));
}
