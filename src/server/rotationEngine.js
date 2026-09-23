function walletKey(address) {
  if (typeof address !== "string") return null;
  return address.startsWith("0x") ? address.toLowerCase() : address;
}

function finite(value) {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

export function detectRotations(researchedTokens) {
  const rotations = [];

  for (const source of researchedTokens) {
    const sellers = new Map(
      source.sellers
        .map((wallet) => [walletKey(wallet.address), wallet])
        .filter(([key]) => key),
    );
    if (sellers.size === 0) continue;

    for (const destination of researchedTokens) {
      if (source.token.contractAddress === destination.token.contractAddress &&
          source.token.chain === destination.token.chain) continue;

      const overlaps = [];
      for (const buyer of destination.buyers) {
        const key = walletKey(buyer.address);
        const seller = key ? sellers.get(key) : null;
        if (!seller) continue;
        overlaps.push({
          address: buyer.address,
          label: buyer.label || seller.label || null,
          sourceSoldVolumeUsd: finite(seller.soldVolumeUsd),
          destinationBoughtVolumeUsd: finite(buyer.boughtVolumeUsd),
        });
      }

      if (overlaps.length === 0) continue;
      const sourceSoldVolumeUsd = overlaps.reduce(
        (sum, wallet) => sum + wallet.sourceSoldVolumeUsd,
        0,
      );
      const destinationBoughtVolumeUsd = overlaps.reduce(
        (sum, wallet) => sum + wallet.destinationBoughtVolumeUsd,
        0,
      );
      const destinationNetflowUsd = finite(destination.token.netflowUsd);
      const confidence = Math.min(
        100,
        20 + overlaps.length * 15 +
        (destinationNetflowUsd > 0 ? 15 : 0) +
        (destinationBoughtVolumeUsd > sourceSoldVolumeUsd ? 10 : 0),
      );

      rotations.push({
        type: "PROBABLE_SMART_MONEY_ROTATION",
        sourceToken: source.token,
        destinationToken: destination.token,
        sourceSellerCount: source.sellers.length,
        destinationBuyerCount: destination.buyers.length,
        overlappingWalletCount: overlaps.length,
        overlappingWallets: overlaps,
        sourceSoldVolumeUsd,
        destinationBoughtVolumeUsd,
        destinationNetflowUsd,
        confidence,
        explanation:
          `${overlaps.length} wallet(s) were observed selling ${source.token.symbol} ` +
          `and buying ${destination.token.symbol}; this is behavioral overlap, not proof of a direct transfer.`,
      });
    }
  }

  return rotations.sort((a, b) =>
    b.overlappingWalletCount - a.overlappingWalletCount ||
    b.confidence - a.confidence ||
    b.destinationBoughtVolumeUsd - a.destinationBoughtVolumeUsd,
  );
}
