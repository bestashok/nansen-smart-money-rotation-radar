import "dotenv/config";
import { createNansenClient, NansenApiError } from "./nansenClient.js";
import { runResearchGate, RESEARCH_ENDPOINTS } from "./researchGate.js";

function serializeFailure(error) {
  if (error instanceof NansenApiError) {
    return {
      endpoint: error.endpoint,
      status: error.status,
      category: error.category,
      message: error.message,
      response: error.response,
    };
  }
  return { message: error?.message ?? String(error) };
}

try {
  const result = await runResearchGate(createNansenClient());
  console.log(`Research token: ${result.token?.symbol ?? "none"}`);
  if (result.token) {
    console.log(`chain: ${result.token.chain}`);
    console.log(`contract address: ${result.token.contractAddress}`);
  }
  console.log(`Research duration: ${result.durationMs?.toFixed(1) ?? "not run"} ms`);

  if (result.failures) {
    for (const [name, error] of Object.entries(result.failures)) {
      console.error(`\n${name.toUpperCase()} FAILED`);
      console.error(JSON.stringify(serializeFailure(error), null, 2));
    }
  } else if (result.token) {
    console.log(`\nFLOW INTELLIGENCE (${result.flowIntelligence.length})`);
    console.log(JSON.stringify(result.flowIntelligence, null, 2));
    console.log(`\nFLOWS (${result.flows.length})`);
    console.log(JSON.stringify(result.flows, null, 2));
    console.log(`\nSMART MONEY BUYERS (${result.buyers.length})`);
    console.log(JSON.stringify(result.buyers, null, 2));
    console.log(`\nSMART MONEY SELLERS (${result.sellers.length})`);
    console.log(JSON.stringify(result.sellers, null, 2));
    console.log(`\nHOLDERS (${result.holders.length})`);
    console.log(JSON.stringify(result.holders, null, 2));
    console.log(`\nWARNINGS`);
    console.log(JSON.stringify(result.warnings, null, 2));
  }

  console.log(`\n${result.reason}`);
  console.log(`GATE 2 = ${result.passed ? "PASS" : "FAIL"}`);
  if (!result.passed) process.exitCode = 1;
} catch (error) {
  console.error("GATE 2 = FAIL");
  console.error(JSON.stringify(serializeFailure(error), null, 2));
  console.error(`Required endpoints: ${JSON.stringify(RESEARCH_ENDPOINTS)}`);
  process.exitCode = 1;
}
