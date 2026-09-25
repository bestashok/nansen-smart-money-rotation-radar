import assert from "node:assert/strict";
import test from "node:test";
import { createApp, lastKnownCredits } from "../src/server/app.js";

test("lastKnownCredits coerces the string header values Nansen returns", () => {
  assert.equal(lastKnownCredits({ calls: [{ creditsRemaining: "339" }, { creditsRemaining: "344" }] }), 344);
  assert.equal(lastKnownCredits({ calls: [{ creditsRemaining: 339 }] }), 339);
  assert.equal(lastKnownCredits({ calls: [{ creditsRemaining: null }, { creditsRemaining: "339" }] }), 339);
  assert.equal(lastKnownCredits({ calls: [{ creditsRemaining: null }] }), null);
  assert.equal(lastKnownCredits({ calls: [] }), null);
});

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

test("POST /api/scan rejects an invalid credit limit before contacting Nansen", async (t) => {
  const server = createApp().listen(0);
  t.after(() => server.close());
  await new Promise((resolve) => server.once("listening", resolve));
  const { port } = server.address();

  const response = await fetch(`http://127.0.0.1:${port}/api/scan`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ creditLimit: 9 }),
  });
  const body = await response.json();

  assert.equal(response.status, 400);
  assert.match(body.error, /creditLimit/);
});

test("POST /api/scan rejects a credit limit above the 200-credit hard cap", async (t) => {
  const server = createApp().listen(0);
  t.after(() => server.close());
  await new Promise((resolve) => server.once("listening", resolve));
  const { port } = server.address();

  const response = await fetch(`http://127.0.0.1:${port}/api/scan`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ creditLimit: 201 }),
  });

  assert.equal(response.status, 400);
});

test("POST /api/campaign keeps the same 200-credit hard cap", async (t) => {
  const server = createApp().listen(0);
  t.after(() => server.close());
  await new Promise((resolve) => server.once("listening", resolve));
  const { port } = server.address();

  const response = await fetch(`http://127.0.0.1:${port}/api/campaign`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ creditLimit: 201 }),
  });

  assert.equal(response.status, 400);
});
