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

test("withCallBudget reports every real send through onSend and never for refused requests", async () => {
  const events = [];
  let dispatched = 0;
  const guarded = withCallBudget({
    async post() {
      dispatched += 1;
      return { data: {}, meta: { status: 200 } };
    },
  }, 2, { onSend: (event) => events.push(event) });

  await guarded.post("/one", {});
  await guarded.post("/two", {});
  await assert.rejects(
    guarded.post("/three", {}),
    (error) => error instanceof CallBudgetExceededError,
  );

  assert.equal(dispatched, 2);
  assert.deepEqual(events, [
    { calls: 1, limit: 2, endpoint: "/one" },
    { calls: 2, limit: 2, endpoint: "/two" },
  ]);
});
