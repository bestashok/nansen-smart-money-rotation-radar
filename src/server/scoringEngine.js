function clamp(value, min = 0, max = 100) {
  return Math.max(min, Math.min(max, value));
}

function component(value, maximum, scale) {
  return clamp((Math.max(0, value) / scale) * maximum, 0, maximum);
}

export function scoreToken(researched, rotations) {
  const incoming = rotations.filter(
    (rotation) => rotation.destinationToken.contractAddress === researched.token.contractAddress,
  );
  const outgoing = rotations.filter(
    (rotation) => rotation.sourceToken.contractAddress === researched.token.contractAddress,
  );
  const netflow = researched.flowIntelligence?.[0]?.smartTraderNetFlowUsd ?? researched.token.netflowUsd ?? 0;
  const buyVolume = researched.buyers.reduce((sum, wallet) => sum + (wallet.boughtVolumeUsd ?? 0), 0);
  const sellVolume = researched.sellers.reduce((sum, wallet) => sum + (wallet.soldVolumeUsd ?? 0), 0);
  const topOwnership = researched.holders.slice(0, 10).reduce(
    (sum, holder) => sum + (holder.ownershipPercentage ?? 0), 0,
  );

  const components = {
    smartMoneyNetflow: component(netflow, 25, 250_000),
    smartBuyerConviction: component(buyVolume, 20, 250_000),
    rotationConfirmation: clamp(incoming.reduce((sum, edge) => sum + edge.overlappingWalletCount * 5, 0), 0, 25),
    marketQuality: component(researched.token.liquidityUsd ?? 0, 15, 2_000_000),
    holderQuality: clamp(15 - Math.max(0, topOwnership - 0.25) * 30, 0, 15),
  };
  const penalties = {
    heavySelling: sellVolume > buyVolume * 1.5 ? 10 : 0,
    weakLiquidity: (researched.token.liquidityUsd ?? 0) < 150_000 ? 8 : 0,
    concentration: topOwnership > 0.5 ? 10 : 0,
  };
  const score = Math.round(clamp(
    Object.values(components).reduce((sum, value) => sum + value, 0) -
    Object.values(penalties).reduce((sum, value) => sum + value, 0),
  ));
  let state = "NEUTRAL";
  if (penalties.concentration || score < 25) state = "HIGH_RISK";
  else if (sellVolume > buyVolume * 1.5) state = "DISTRIBUTION";
  else if (incoming.length && score >= 65) state = "ROTATION_IN";
  else if (netflow > 0 && score >= 50) state = "EARLY_ACCUMULATION";
  else if (score >= 35) state = "WATCH";

  return {
    ...researched,
    score,
    state,
    scoring: { components, penalties },
    rotationsIn: incoming,
    rotationsOut: outgoing,
    explanation: `${state}: score ${score}/100 from observed netflow, wallet activity, market quality, holder concentration, and rotation evidence.`,
  };
}

export function scoreTokens(researchedTokens, rotations) {
  return researchedTokens.map((token) => scoreToken(token, rotations)).sort((a, b) => b.score - a.score);
}
