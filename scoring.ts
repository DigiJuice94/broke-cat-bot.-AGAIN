import { Candidate, Snapshot } from "./types.ts";

const clamp = (v:number, a=0, b=100) => Math.max(a, Math.min(b, v));
const gain = (a?:number, b?:number) => (a != null && b != null && a !== 0) ? ((b-a)/Math.abs(a))*100 : 0;

export function scoreCandidate(c: Candidate): {score:number;confidence:number;reason:string} {
  const s = c.snapshots.at(-1);
  const prev = c.snapshots.length >= 2 ? c.snapshots.at(-2) : undefined;
  if (!s) return { score: 0, confidence: 0, reason: "waiting for first snapshot" };

  // Confidence measures MARKET DATA completeness. Route checks are execution readiness,
  // not market intelligence, so a missing route no longer fakes a low data score.
  const coreFields: (keyof Snapshot)[] = [
    "priceUsd", "liquidityUsd", "marketCapUsd", "holderCount",
    "volume1mUsd", "buys1m", "sells1m", "priceChange1mPct"
  ];
  const bonusFields: (keyof Snapshot)[] = ["volume5mUsd", "trades1m", "uniqueWallet1m", "buyVolume1mUsd", "sellVolume1mUsd", "chainTx1m", "top10HolderPct"];
  const corePresent = coreFields.filter(k => s[k] !== undefined).length;
  const bonusPresent = bonusFields.filter(k => s[k] !== undefined).length;
  let confidence = (corePresent / coreFields.length) * 82 + (bonusPresent / bonusFields.length) * 8;
  if (s.bundleStatus === "ok") confidence += 4;
  if (c.snapshots.length >= 3) confidence += 6;
  confidence = clamp(confidence);

  // Market/runner score stays independent from Jupiter routing. A coin can be a strong
  // runner even if it is not executable; execution is still a hard READY gate in scanner.ts.
  let score = 28;
  const buys = s.buys1m ?? 0;
  const sells = s.sells1m ?? 0;
  const ratio = buys / Math.max(1, sells);
  const volumeNow = s.volume1mUsd ?? 0;

  score += clamp((ratio - 1) * 8, -10, 24);
  score += clamp((s.priceChange1mPct ?? 0) * 0.75, -15, 18);
  score += clamp(gain(prev?.volume1mUsd, s.volume1mUsd) * 0.10, -8, 14);
  score += clamp(gain(prev?.holderCount, s.holderCount) * 0.20, -4, 8);
  score += clamp(gain(prev?.uniqueWallet1m, s.uniqueWallet1m) * 0.12, -4, 8);

  // Helius on-chain activity: prefer acceleration, not simply a large historical count.
  const tx10 = s.chainTx10s ?? 0;
  const tx30 = s.chainTx30s ?? 0;
  const tx60 = s.chainTx1m ?? 0;
  const recentShare = tx60 > 0 ? tx10 / tx60 : 0;
  score += clamp(tx10 * 0.8, 0, 10);
  score += clamp((tx30 - (tx60 - tx30)) * 0.35, -5, 10);
  score += clamp((recentShare - 0.17) * 30, -4, 8);

  if (volumeNow >= 500) score += 3;
  if (volumeNow >= 2_500) score += 4;
  if (volumeNow >= 10_000) score += 4;
  if ((s.uniqueWallet1m ?? 0) >= 10) score += 4;
  if ((s.uniqueWallet1m ?? 0) >= 25) score += 4;
  if (tx60 >= 10) score += 3;
  if (tx60 >= 30) score += 3;
  if (tx60 >= 60) score += 3;

  // Trending means "look here first", with only a modest score bonus.
  if (c.sources.has("axiom")) score += 5;
  if (c.sources.has("fomo")) score += 5;
  if (c.sources.has("birdeye-trending")) score += 4;
  if (c.sources.has("birdeye-new")) score += 2;
  if (c.sources.has("axiom") && c.sources.has("fomo")) score += 4;

  if (s.top10HolderPct != null) score -= clamp((s.top10HolderPct - 25) * 0.35, 0, 18);
  if (s.bundleRisk != null) score -= clamp((s.bundleRisk - 20) * 0.30, 0, 24);
  score = clamp(score);

  let reason = "collecting momentum data";
  if (s.priceUsd == null) reason = "market data incomplete";
  else if (ratio >= 2) reason = `buy pressure ${ratio.toFixed(1)}x`;
  else if (tx10 >= 5 && tx10 >= Math.max(2, (tx60 - tx30))) reason = `Helius activity accelerating: ${tx10} tx/10s, ${tx60} tx/1m`;
  else if ((s.priceChange1mPct ?? 0) >= 8) reason = `price momentum +${(s.priceChange1mPct ?? 0).toFixed(1)}%/1m`;
  else if (!s.buyRoute) reason = "market data received; no buy route yet";
  else if (!s.sellRoute) reason = "market data received; sell route unavailable";

  return { score, confidence, reason };
}
