import { Candidate, Snapshot } from "./types.ts";

const clamp = (v:number, a=0, b=100) => Math.max(a, Math.min(b, v));
const gain = (a?:number, b?:number) => a && b ? ((b-a)/Math.abs(a))*100 : 0;

export function scoreCandidate(c: Candidate): {score:number;confidence:number;reason:string} {
  const s = c.snapshots.at(-1);
  const prev = c.snapshots.length >= 2 ? c.snapshots.at(-2) : undefined;
  if (!s) return { score: 0, confidence: 0, reason: "waiting for first snapshot" };

  const fields: (keyof Snapshot)[] = ["priceUsd","liquidityUsd","marketCapUsd","holderCount","volume1mUsd","buys1m","sells1m","top10HolderPct","buyRoute","sellRoute"];
  const present = fields.filter(k => s[k] !== undefined).length;
  let confidence = present / fields.length * 82;
  if (s.bundleStatus === "ok") confidence += 12;
  else if (s.bundleStatus === "unknown") confidence += 3;
  if (c.snapshots.length >= 3) confidence += 6;
  confidence = clamp(confidence);

  let score = 35;
  const buys = s.buys1m ?? 0, sells = s.sells1m ?? 0;
  const ratio = buys / Math.max(1, sells);
  score += clamp((ratio - 1) * 7, -12, 20);
  score += clamp((s.priceChange1mPct ?? 0) * 0.7, -15, 15);
  score += clamp(gain(prev?.volume1mUsd, s.volume1mUsd) * 0.12, -10, 15);
  score += clamp(gain(prev?.holderCount, s.holderCount) * 0.25, -5, 10);

  if (c.sources.has("axiom")) score += 8;
  if (c.sources.has("fomo")) score += 8;
  if (c.sources.has("birdeye-trending")) score += 5;
  if (c.sources.has("birdeye-new")) score += 3;
  if (c.sources.has("axiom") && c.sources.has("fomo")) score += 6;

  if (s.top10HolderPct != null) score -= clamp((s.top10HolderPct - 25) * 0.35, 0, 18);
  if (s.bundleRisk != null) score -= clamp((s.bundleRisk - 20) * 0.30, 0, 24);
  if (!s.buyRoute) score -= 35;
  if (!s.sellRoute) score -= 30;
  score += clamp(((s.routeQuality ?? 50) - 70) * 0.15, -8, 5);

  score = clamp(score);
  const reason = !s.buyRoute ? "no buy route" : !s.sellRoute ? "sell route unavailable" : ratio >= 2 ? `buy pressure ${ratio.toFixed(1)}x` : "collecting momentum data";
  return { score, confidence, reason };
}
