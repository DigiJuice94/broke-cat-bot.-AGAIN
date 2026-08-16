import { config } from "./config.js";

export function choosePositionUsd(input: {
  score:number; confidence:number; spendableUsd:number; routeQuality:number; multiTrend:boolean;
}): number {
  const {score, confidence, spendableUsd, routeQuality, multiTrend} = input;
  if (spendableUsd < config.minPositionUsd) return 0;
  // No hard max-position cap. Conviction directly determines the fraction of all spendable funds.
  const scoreConviction = Math.max(0, Math.min(1, (score - 65) / 35));
  const confidenceFactor = Math.max(0, Math.min(1, confidence / 100));
  const routeFactor = Math.max(0.25, Math.min(1, routeQuality / 100));
  const trendFactor = multiTrend ? 1 : 0.88;
  const fraction = Math.max(0, Math.min(1, scoreConviction * scoreConviction * confidenceFactor * routeFactor * trendFactor));
  const chosen = spendableUsd * fraction;
  return Math.min(spendableUsd, Math.max(config.minPositionUsd, chosen));
}
