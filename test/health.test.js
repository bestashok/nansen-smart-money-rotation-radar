import assert from "node:assert/strict";
import test from "node:test";
import { createApp } from "../src/server/app.js";

test("GET /api/health reports a healthy service", async (t) => {
  const server = createApp().listen(0);
  t.after(() => server.close());

  await new Promise((resolve) => server.once("listening", resolve));
  const { port } = server.address();
  const response = await fetch(`http://127.0.0.1:${port}/api/health`);
  const body = await response.json();

  assert.equal(response.status, 200);
  assert.equal(body.ok, true);
  assert.equal(body.service, "nansen-smart-money-rotation-radar");
  assert.match(body.timestamp, /^\d{4}-\d{2}-\d{2}T/);
});
