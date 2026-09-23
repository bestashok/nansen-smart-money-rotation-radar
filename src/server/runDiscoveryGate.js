import "dotenv/config";
import { discoverTokens, TOKEN_SCREENER_ENDPOINT } from "./discovery.js";
import { createNansenClient, NansenApiError } from "./nansenClient.js";

function displayNumber(value) {
  return value === null ? "not returned" : value.toLocaleString("en-US");
}

try {
  const result = await discoverTokens(createNansenClient());
  console.log(`GATE 1 endpoint: POST ${TOKEN_SCREENER_ENDPOINT}`);
  console.log(`Filters: ${JSON.stringify(result.filters)}`);
  console.log(`Returned ${result.tokens.length} qualifying token(s) in ${result.durationMs.toFixed(1)} ms.`);

  for (const [index, token] of result.tokens.entries()) {
    console.log(`\nToken ${index + 1}`);
    console.log(`symbol: ${token.symbol}`);
    console.log(`chain: ${token.chain}`);
    console.log(`contract address: ${token.contractAddress}`);
    console.log(`market cap: ${displayNumber(token.marketCapUsd)}`);
    console.log(`liquidity: ${displayNumber(token.liquidityUsd)}`);
    console.log(`netflow: ${displayNumber(token.netflowUsd)}`);
  }

  if (result.tokens.length === 0) {
    console.log("\nScan complete — 0 qualifying tokens found.");
  }

  console.log("\nGATE 1 = PASS");
} catch (error) {
  if (error instanceof NansenApiError) {
    console.error("GATE 1 = FAIL");
    console.error(`endpoint: POST ${error.endpoint ?? TOKEN_SCREENER_ENDPOINT}`);
    console.error(`HTTP status: ${error.status ?? "not attempted"}`);
    console.error(`category: ${error.category}`);
    console.error(`useful error: ${error.message}`);
    if (error.response) console.error(`response: ${JSON.stringify(error.response)}`);
    process.exitCode = 1;
  } else {
    throw error;
  }
}
