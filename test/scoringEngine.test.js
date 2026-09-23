import assert from "node:assert/strict";
import test from "node:test";
import { scoreToken } from "../src/server/scoringEngine.js";

test("score is bounded and evidence components are transparent", () => {
  const token = { token: { symbol: "X", contractAddress: "0x1", liquidityUsd: 1_000_000, netflowUsd: 50_000 }, buyers: [{ boughtVolumeUsd: 20_000 }], sellers: [], holders: [], flowIntelligence: [] };
  const result = scoreToken(token, []);
  assert.ok(result.score >= 0 && result.score <= 100);
  assert.equal(typeof result.scoring.components.smartMoneyNetflow, "number");
  assert.notEqual(result.state, "BUY");
});
