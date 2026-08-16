import { Candidate } from "./types.ts";
const clamp = (v:number, a=0, b=100) => Math.max(a, Math.min(b, v));
const gain = (a?:number, b?:number) => (a != null && b != null && a !== 0) ? ((b-a)/Math.abs(a))*100 : 0;

export function scoreCandidate(c: Candidate): {score:number;confidence:number;reason:string} {
  const s = c.snapshots.at(-1), prev = c.snapshots.length >= 2 ? c.snapshots.at(-2) : undefined;
  if (!s) return { score:0, confidence:0, reason:"waiting for first snapshot" };

  // Confidence now measures only data sources we actually use: DEX Screener + Birdeye + our own snapshots.
  const core = [s.priceUsd, s.liquidityUsd, s.marketCapUsd, s.volume1mUsd ?? s.volume5mUsd,
    s.buys1m ?? s.buys5m, s.sells1m ?? s.sells5m, s.priceChange1mPct ?? s.priceChange5mPct];
  const deep = [s.holderCount, s.top10HolderPct, s.buyVolume1mUsd, s.sellVolume1mUsd];
  const corePct = core.filter(v=>v!==undefined).length/core.length;
  const deepPct = deep.filter(v=>v!==undefined).length/deep.length;
  let confidence = corePct*82 + deepPct*10 + (c.snapshots.length>=2?4:0) + (c.snapshots.length>=3?4:0);
  confidence = clamp(confidence);

  let score = 25;
  const buys = s.buys1m ?? s.buys5m ?? 0, sells = s.sells1m ?? s.sells5m ?? 0;
  const ratio = buys / Math.max(1, sells);
  const priceMomentum = s.priceChange1mPct ?? ((s.priceChange5mPct ?? 0) / 3);
  const volumeNow = s.volume1mUsd ?? ((s.volume5mUsd ?? 0) / 5);

  // Current market strength.
  score += clamp((ratio-1)*8, -10, 24);
  score += clamp(priceMomentum*0.75, -15, 18);
  if (volumeNow>=500) score+=3; if (volumeNow>=2500) score+=4; if (volumeNow>=10000) score+=4;
  if (s.liquidityUsd != null) {
    if (s.liquidityUsd < 1500) score -= 8;
    else if (s.liquidityUsd >= 5000) score += 2;
    if (s.liquidityUsd >= 20000) score += 2;
  }
  if (s.buyVolume1mUsd != null && s.sellVolume1mUsd != null) {
    const volRatio = s.buyVolume1mUsd / Math.max(1, s.sellVolume1mUsd);
    score += clamp((volRatio-1)*4, -6, 10);
  }
  if ((s.uniqueWallet1m ?? 0) >= 10) score += 2;
  if ((s.uniqueWallet1m ?? 0) >= 25) score += 2;
  if ((s.uniqueWallet1m ?? 0) >= 50) score += 2;

  // What changed while Broke Cat watched the coin — this is the main early-runner signal.
  const volAccel = gain(prev?.volume1mUsd ?? prev?.volume5mUsd, s.volume1mUsd ?? s.volume5mUsd);
  const priceAccel = gain(prev?.priceUsd, s.priceUsd);
  const buyAccel = gain(prev?.buys1m ?? prev?.buys5m, s.buys1m ?? s.buys5m);
  const holderAccel = gain(prev?.holderCount, s.holderCount);
  score += clamp(volAccel*0.10, -8, 14);
  score += clamp(priceAccel*0.7, -8, 12);
  score += clamp(buyAccel*0.08, -5, 12);
  score += clamp(holderAccel*0.20, -4, 8);

  // Discovery priority is useful evidence, but never enough to force a buy.
  if (c.sources.has("axiom")) score+=5; if (c.sources.has("fomo")) score+=5;
  if (c.sources.has("birdeye-trending")) score+=4; if (c.sources.has("birdeye-new")) score+=2;
  if (c.sources.has("dex-profile")) score+=1; if (c.sources.has("dex-boost")) score+=1; if (c.sources.has("dex-boost-top")) score+=2;
  if (c.sources.has("axiom") && c.sources.has("fomo")) score+=4;

  // Risk deductions.
  if (s.top10HolderPct != null) score -= clamp((s.top10HolderPct-25)*0.35,0,18);
  if (s.bundleRisk != null) score -= clamp((s.bundleRisk-20)*0.30,0,24);
  score = clamp(score);

  let reason="collecting momentum data";
  if (s.priceUsd == null) reason="market data incomplete";
  else if (buyAccel>=40 && buys>=5) reason=`buyers accelerating +${buyAccel.toFixed(0)}%`;
  else if (volAccel>=40) reason=`volume accelerating +${volAccel.toFixed(0)}%`;
  else if (ratio>=2) reason=`buy pressure ${ratio.toFixed(1)}x`;
  else if (priceMomentum>=8) reason=`price momentum +${priceMomentum.toFixed(1)}%`;
  else if (!s.buyRoute) reason="market data received; route check pending";
  else if (!s.sellRoute) reason="market data received; sell route unavailable";
  return { score, confidence, reason };
}
