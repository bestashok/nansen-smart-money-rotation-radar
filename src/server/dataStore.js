import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

const dataDir = path.resolve("data");
const latestPath = path.join(dataDir, "latest-results.json");
const historyPath = path.join(dataDir, "scan-history.json");

export async function saveScan(result) {
  await mkdir(dataDir, { recursive: true });
  let history = [];
  try { history = JSON.parse(await readFile(historyPath, "utf8")); } catch {}
  history.unshift({
    scanStartedAt: result.scanStartedAt,
    scanCompletedAt: result.scanCompletedAt,
    totalDurationMs: result.totalDurationMs,
    tokensDiscovered: result.tokensDiscovered,
    tokensAnalyzed: result.tokensAnalyzed,
    tokensFailed: result.tokensFailed,
  });
  await writeFile(latestPath, JSON.stringify(result, null, 2));
  await writeFile(historyPath, JSON.stringify(history.slice(0, 50), null, 2));
}

export async function readLatest() {
  try { return JSON.parse(await readFile(latestPath, "utf8")); } catch { return null; }
}

export async function readHistory() {
  try { return JSON.parse(await readFile(historyPath, "utf8")); } catch { return []; }
}
