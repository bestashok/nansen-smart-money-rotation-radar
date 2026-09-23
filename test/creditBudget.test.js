import assert from "node:assert/strict";
import test from "node:test";
import { withCreditBudget } from "../src/server/creditBudget.js";

test("credit budget refuses calls that could exceed 100 free-plan credits", async () => {
  const client = withCreditBudget({
    async post() { return { data: {}, meta: { status: 200 } }; },
  }, 100);

  for (let index = 0; index < 10; index += 1) {
    await client.post("/api/v1/token-screener", {});
  }
  await assert.rejects(
    client.post("/api/v1/token-screener", {}),
    /would exceed 100/,
  );
  assert.equal(client.usage().reservedCredits, 100);
  assert.equal(client.usage().calls.length, 10);
});
