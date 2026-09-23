import "dotenv/config";
import { withCreditBudget } from "./creditBudget.js";
import { discoverTokens } from "./discovery.js";
import { createNansenClient } from "./nansenClient.js";
import { detectRotations } from "./rotationEngine.js";

const budgetedClient = withCreditBudget(createNansenClient(), 100);
const discovery = await discoverTokens(budgetedClient);
const tokens = discovery.tokens.slice(0, 4);
const now = new Date();
const date = {
  from: new Date(now.getTime() - 7 * 24 * 60 * 60 * 1_000).toISOString(),
  to: now.toISOString(),
};
const labels = ["Fund", "Smart Trader", "30D Smart Trader", "90D Smart Trader", "180D Smart Trader"];
const researched = [];
const failures = [];

for (const token of tokens) {
  const sides = {};
  for (const buyOrSell of ["BUY", "SELL"]) {
    try {
      const response = await budgetedClient.post("/api/v1/tgm/who-bought-sold", {
        chain: token.chain,
        token_address: token.contractAddress,
        buy_or_sell: buyOrSell,
        date,
        pagination: { page: 1, per_page: 25 },
        filters: {
          include_smart_money_labels: labels,
          trade_volume_usd: { min: 1 },
        },
        order_by: [{
          field: buyOrSell === "BUY" ? "bought_volume_usd" : "sold_volume_usd",
          direction: "DESC",
        }],
      });
      sides[buyOrSell] = response.data.data ?? [];
    } catch (error) {
      failures.push({ token: token.symbol, side: buyOrSell, status: error.status, message: error.message });
      sides[buyOrSell] = [];
    }
  }
  researched.push({
    token,
    buyers: sides.BUY.map((row) => ({
      address: row.address,
      label: row.address_label,
      boughtVolumeUsd: row.bought_volume_usd,
    })),
    sellers: sides.SELL.map((row) => ({
      address: row.address,
      label: row.address_label,
      soldVolumeUsd: row.sold_volume_usd,
    })),
  });
}

const rotations = detectRotations(researched);
const usage = budgetedClient.usage();
console.log("STRICT CREDIT-CAPPED ROTATION GATE");
console.log(`tokens researched: ${researched.length}`);
for (const item of researched) {
  console.log(`${item.token.symbol}: ${item.buyers.length} buyers, ${item.sellers.length} sellers`);
}
console.log(`probable rotations found: ${rotations.length}`);
for (const rotation of rotations) {
  console.log(
    `${rotation.sourceToken.symbol} -> ${rotation.destinationToken.symbol}: ` +
    `${rotation.overlappingWalletCount} overlapping wallet(s)`,
  );
}
console.log(`reserved worst-case credits: ${usage.reservedCredits}/${usage.limit}`);
console.log(`real Nansen calls attempted: ${usage.calls.length}`);
if (failures.length) console.log(`failures: ${JSON.stringify(failures)}`);
console.log(`GATE 3 = ${researched.some((item) => item.buyers.length || item.sellers.length) ? "PASS" : "FAIL"}`);
