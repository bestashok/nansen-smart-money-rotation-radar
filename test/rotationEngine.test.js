import assert from "node:assert/strict";
import test from "node:test";
import { detectRotations } from "../src/server/rotationEngine.js";

function researched(symbol, address, buyers, sellers, netflowUsd = 1_000) {
  return {
    token: { symbol, chain: "base", contractAddress: address, netflowUsd },
    buyers,
    sellers,
  };
}

test("rotation engine records wallet-overlap evidence without claiming transfer", () => {
  const source = researched("SOURCE", "0xsource", [], [
    { address: "0xABC", label: "Smart Trader", soldVolumeUsd: 500 },
    { address: "0xdef", label: null, soldVolumeUsd: 100 },
  ]);
  const destination = researched("DEST", "0xdest", [
    { address: "0xabc", label: "Smart Trader", boughtVolumeUsd: 800 },
    { address: "0x999", label: null, boughtVolumeUsd: 50 },
  ], []);

  const rotations = detectRotations([source, destination]);

  assert.equal(rotations.length, 1);
  assert.equal(rotations[0].sourceToken.symbol, "SOURCE");
  assert.equal(rotations[0].destinationToken.symbol, "DEST");
  assert.equal(rotations[0].overlappingWalletCount, 1);
  assert.equal(rotations[0].overlappingWallets[0].address, "0xabc");
  assert.match(rotations[0].explanation, /not proof of a direct transfer/);
});

test("rotation engine does not create edges without wallet overlap", () => {
  const rotations = detectRotations([
    researched("ONE", "0x1", [], [{ address: "wallet-one", soldVolumeUsd: 5 }]),
    researched("TWO", "0x2", [{ address: "wallet-two", boughtVolumeUsd: 5 }], []),
  ]);
  assert.deepEqual(rotations, []);
});

test("non-EVM addresses remain case-sensitive", () => {
  const rotations = detectRotations([
    researched("ONE", "sol1", [], [{ address: "AbC", soldVolumeUsd: 5 }]),
    researched("TWO", "sol2", [{ address: "abc", boughtVolumeUsd: 5 }], []),
  ]);
  assert.deepEqual(rotations, []);
});
