import { Candidate, Snapshot } from "./types.ts";
const clamp = (v:number, a=0, b=100) => Math.max(a, Math.min(b, v));
const gain = (a?:number, b?:number) => (a != null && b != null && a !== 0) ? ((b-a)/Math.abs(a))*100 : 0;

export function scoreCandidate(c: Candidate): {score:number;confidence:number;reason:string} {
  const s = c.snapshots.at(-1), prev = c.snapshots.length >= 2 ? c.snapshots.at(-2) : undefined;
  if (!s) return { score:0, confidence:0, reason:"waiting for first snapshot" };

  // Either 1m or 5m DEX flow counts satisfy the buy/sell-flow data slot.
  const checks = [s.priceUsd, s.liquidityUsd, s.marketCapUsd, s.volume1mUsd ?? s.volume5mUsd,
    s.buys1m ?? s.buys5m, s.sells1m ?? s.sells5m, s.priceChange1mPct ?? s.priceChange5mPct];
  const corePresent = checks.filter(v => v !== undefined).length;
  const bonus = [s.holderCount, s.uniqueWallet1m, s.chainTx1m, s.top10HolderPct, s.buyVolume1mUsd, s.sellVolume1mUsd]
    .filter(v => v !== undefined).length;
  let confidence = (corePresent/checks.length)*78 + (bonus/6)*12 + (c.snapshots.length >= 3 ? 6 : 0) + (s.bundleStatus === "ok" ? 4 : 0);
  confidence = clamp(confidence);

  let score = 25;
  const buys = s.buys1m ?? s.buys5m ?? 0, sells = s.sells1m ?? s.sells5m ?? 0;
  const ratio = buys / Math.max(1, sells);
  const priceMomentum = s.priceChange1mPct ?? ((s.priceChange5mPct ?? 0) / 3);
  const volumeNow = s.volume1mUsd ?? ((s.volume5mUsd ?? 0) / 5);
  score += clamp((ratio-1)*8, -10, 24);
  score += clamp(priceMomentum*0.75, -15, 18);
  score += clamp(gain(prev?.volume1mUsd ?? prev?.volume5mUsd, s.volume1mUsd ?? s.volume5mUsd)*0.10, -8, 14);
  score += clamp(gain(prev?.priceUsd, s.priceUsd)*0.7, -8, 12);
  score += clamp(gain(prev?.holderCount, s.holderCount)*0.20, -4, 8);

  const tx10=s.chainTx10s??0, tx30=s.chainTx30s??0, tx60=s.chainTx1m??0;
  if (tx60 > 0) {
    score += clamp(tx10*0.8,0,10);
    score += clamp((tx30-(tx60-tx30))*0.35,-5,10);
    score += clamp(((tx10/tx60)-0.17)*30,-4,8);
  }
  if (volumeNow>=500) score+=3; if (volumeNow>=2500) score+=4; if (volumeNow>=10000) score+=4;
  if (tx60>=10) score+=3; if (tx60>=30) score+=3; if (tx60>=60) score+=3;
  if (c.sources.has("axiom")) score+=5; if (c.sources.has("fomo")) score+=5;
  if (c.sources.has("birdeye-trending")) score+=4; if (c.sources.has("birdeye-new")) score+=2;
  if (c.sources.has("axiom") && c.sources.has("fomo")) score+=4;
  if (s.top10HolderPct != null) score -= clamp((s.top10HolderPct-25)*0.35,0,18);
  if (s.bundleRisk != null) score -= clamp((s.bundleRisk-20)*0.30,0,24);
  score = clamp(score);

  let reason="collecting momentum data";
  if (s.priceUsd == null) reason="market data incomplete";
  else if (ratio>=2) reason=`buy pressure ${ratio.toFixed(1)}x`;
  else if (tx10>=5 && tx10>=Math.max(2,(tx60-tx30))) reason=`on-chain activity accelerating: ${tx10} tx/10s, ${tx60} tx/1m`;
  else if (priceMomentum>=8) reason=`price momentum +${priceMomentum.toFixed(1)}%`;
  else if (!s.buyRoute) reason="market data received; route check pending";
  else if (!s.sellRoute) reason="market data received; sell route unavailable";
  return { score, confidence, reason };
}
