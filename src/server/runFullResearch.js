import "dotenv/config";
import { createNansenClient } from "./nansenClient.js";
import { scanAllTokens } from "./scanner.js";

const result = await scanAllTokens(createNansenClient());
console.log("FULL RESEARCH SCAN COMPLETE");
console.log(`tokens discovered: ${result.tokensDiscovered}`);
console.log(`tokens analyzed: ${result.tokensAnalyzed}`);
console.log(`tokens failed: ${result.tokensFailed}`);
console.log(`maximum concurrent tokens: ${result.maximumConcurrentRequests}`);
console.log(`discovery duration: ${result.discoveryDurationMs.toFixed(1)} ms`);
console.log(`research duration: ${result.researchDurationMs.toFixed(1)} ms`);
console.log(`total duration: ${result.totalDurationMs.toFixed(1)} ms`);
for (const researched of result.tokens) {
  console.log(
    `${researched.token.symbol} (${researched.token.chain}): ` +
    `${researched.buyers.length} buyers, ${researched.sellers.length} sellers, ` +
    `${researched.holders.length} holders`,
  );
}
if (result.failures.length) {
  console.error("FAILURES");
  for (const failure of result.failures) {
    console.error(`${failure.token.symbol} (${failure.token.chain}): ${failure.reason}`);
    for (const [name, error] of Object.entries(failure.details ?? {})) {
      console.error(
        `  ${name}: endpoint=${error.endpoint ?? "unknown"} ` +
        `status=${error.status ?? "none"} category=${error.category ?? "unknown"} ` +
        `message=${error.message ?? String(error)}`,
      );
    }
  }
}

if (result.tokensDiscovered > 0 && result.tokensAnalyzed === 0) process.exitCode = 1;
