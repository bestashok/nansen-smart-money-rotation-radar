import assert from "node:assert/strict";
import test from "node:test";
import { CallBudgetExceededError, withCallBudget } from "../src/server/callBudget.js";

test("call budget refuses every real attempt beyond its target", async () => {
  let realCalls = 0;
  const guarded = withCallBudget({
    async post() {
      realCalls += 1;
      return { data: {}, meta: { status: 200 } };
    },
  }, 2);

  await guarded.post("/one", {});
  await guarded.post("/two", {});
  await assert.rejects(
    guarded.post("/three", {}),
    (error) => error instanceof CallBudgetExceededError,
  );
  assert.equal(realCalls, 2);
  assert.deepEqual(guarded.usage(), { limit: 2, calls: 2, remainingCalls: 0 });
});
