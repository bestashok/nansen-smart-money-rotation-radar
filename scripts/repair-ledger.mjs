// Restores the dedup ledger (data/cache.json) for requests whose Nansen
// responses were lost when the atomic cache rename failed (Windows EPERM).
//
// Why this exists: those calls DID reach Nansen and ARE counted in the
// campaign total, but their stored responses never made it into the ledger.
// Left unrepaired, the next Live Scan 2 continuation would silently repeat
// every one of them — burning genuine calls on identical requests.
//
// What it does:
//   - rebuilds each lost request body with the exact function the planner
//     uses (researchBodyFor), so the repaired cache key matches the request
//     that was actually sent
//   - marks repaired entries `dataLost` (never re-sent, never served as
//     fresh data, pagination continues one page deeper)
//   - never touches entries that already exist, and skips genuine API
//     failures (those may legitimately be re-requested later)
//
// Idempotent: run it as many times as you like. Run it BEFORE starting the
// next campaign cycle (while the server is not writing the cache).
import { readCampaignHistory } from "../src/server/campaignStore.js";
import { repairLostLedgerEntries } from "../src/server/ledgerRepair.js";

const history = await readCampaignHistory();
const report = await repairLostLedgerEntries(history);

console.log("ledger repair report:");
console.log(`  repaired (lost responses restored) : ${report.repaired}`);
console.log(`  skipped: already in the ledger     : ${report.skippedExisting}`);
console.log(`  skipped: genuine API failures      : ${report.skippedNotLost}`);
console.log(`  skipped: not reconstructable       : ${report.skippedUnreconstructable}`);
console.log(`  total ledger entries now           : ${report.totalEntries}`);
