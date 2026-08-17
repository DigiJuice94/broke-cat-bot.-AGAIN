import { config } from "./config.ts";

export function choosePositionUsd(input: {
  score:number; confidence:number; spendableUsd:number; routeQuality:number; multiTrend:boolean;
}): number {
  const {score, confidence, spendableUsd, routeQuality, multiTrend} = input;
  if (spendableUsd < config.minPositionUsd) return 0;

  // v2.3: on a ~$100 test wallet, keep normal entries meaningful enough to beat
  // round-trip costs without allowing a single score to consume the whole wallet.
  const scoreFactor = Math.max(0, Math.min(1, (score - 78) / 22));
  const confidenceFactor = Math.max(0.65, Math.min(1, confidence / 100));
  const routeFactor = Math.max(0.70, Math.min(1, routeQuality / 100));
  const trendBoost = multiTrend ? 1.08 : 1;
  const rawTarget = config.basePositionUsd + (config.maxPositionUsd - config.basePositionUsd) * scoreFactor;
  const qualityFactor = Math.max(0.90, confidenceFactor * routeFactor);
  const desired = Math.max(config.basePositionUsd, rawTarget * qualityFactor * trendBoost);

  return Math.min(spendableUsd, config.maxPositionUsd, Math.max(config.minPositionUsd, desired));
}
