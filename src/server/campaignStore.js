import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";

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
