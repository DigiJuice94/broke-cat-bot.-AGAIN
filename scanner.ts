import { Birdeye } from "./birdeye.ts";
import { getAxiomTrending, getFomoTrending } from "./trendingFeed.ts";
import { bundleRisk } from "./bundle.ts";
import { Jupiter } from "./jupiter.ts";
import { config } from "./config.ts";
import { Candidate, DiscoveredToken, Snapshot } from "./types.ts";
import { log } from "./log.ts";
import { scoreCandidate } from "./scoring.ts";
import { DexScreener } from "./dexscreener.ts";

export class Scanner {
  readonly candidates = new Map<string, Candidate>();
  private lastDiscovery = 0;
  private dex = new DexScreener();
  constructor(private birdeye: Birdeye, private jupiter: Jupiter, private onReady: (c: Candidate) => Promise<void>) {}

  private add(t: DiscoveredToken) {
    const existing = this.candidates.get(t.address);
    if (existing) {
      existing.sources.add(t.source); existing.lastSeenAt=Date.now();
      if (t.rank != null) existing.trendingRanks[t.source]=t.rank;
      if (existing.token.name==="Unknown" && t.name!=="Unknown") existing.token.name=t.name;
      if (existing.token.symbol==="?" && t.symbol!=="?") existing.token.symbol=t.symbol;
      if (existing.token.decimals==null && t.decimals!=null) existing.token.decimals=t.decimals;
      if (t.seed) existing.token.seed={...(existing.token.seed??{}),...Object.fromEntries(Object.entries(t.seed).filter(([,v])=>v!==undefined))};
      return;
    }
    if ([...this.candidates.values()].filter(c=>!["DROPPED","BOUGHT","FAILED"].includes(c.state)).length>=config.maxActiveCandidates) return;
    this.candidates.set(t.address,{token:t,firstSeenAt:Date.now(),lastSeenAt:Date.now(),sources:new Set([t.source]),
      trendingRanks:t.rank==null?{}:{[t.source]:t.rank},snapshots:[],score:0,dataConfidence:0,state:"WATCHING",collecting:false});
  }

  private async discover() {
    const external = await Promise.allSettled([getAxiomTrending(),getFomoTrending()]);
    for(const r of external) if(r.status==="fulfilled") for(const t of r.value) this.add(t);
    for (const fn of [()=>this.birdeye.trending(),()=>this.birdeye.newListings(),()=>this.birdeye.memeMomentum()]) {
      try { for (const t of await fn()) this.add(t); } catch(e) { log.warn(`[DISCOVERY DATA] ${e instanceof Error?e.message:String(e)}`); }
    }
    const active=[...this.candidates.values()].filter(c=>!["DROPPED","BOUGHT","FAILED"].includes(c.state)).length;
    log.info(`[DISCOVERY] active candidates=${active} total-known=${this.candidates.size}`);
  }
  private rankText(c:Candidate){return Object.entries(c.trendingRanks).map(([k,v])=>`${k}#${v}`).join(",");}
  private priority(c:Candidate){return (c.sources.has("axiom")?3:0)+(c.sources.has("fomo")?3:0)+(c.sources.has("birdeye-trending")?2:0)+(c.sources.has("birdeye-meme")?1:0)+c.score/100;}

  private async collect(c:Candidate,index:number) {
    if(c.collecting||["DROPPED","BOUGHT","FAILED"].includes(c.state))return;
    c.collecting=true;
    try{
      const seed=c.token.seed??{};
      const doBirdeye=index<config.birdeyeDeepCandidates || c.score>=config.promoteScore;
      const age=Date.now()-c.firstSeenAt;
      const doRoute=(index<config.routeDeepCandidates && age>=Math.min(20_000,config.minObservationMs/2)) || c.score>=config.promoteScore;
      const doBundle=index<config.bundleDeepCandidates || c.score>=70;

      const marketPromise=doBirdeye?this.birdeye.snapshot(c.token.address,seed):Promise.resolve(seed);
      const bundlePromise=doBundle?bundleRisk(c.token.address):Promise.resolve({risk:undefined,status:"unknown" as const});
      const routePromise=doRoute?this.jupiter.canBuyAndSell(c.token.address):Promise.resolve({buy:false,sell:false,quality:undefined});
      const [market,bundle,route]=await Promise.all([marketPromise,bundlePromise,routePromise]);

      const snap:Snapshot={at:Date.now(),...market,
        bundleRisk:bundle.risk,bundleStatus:doBundle?(bundle.status==="ok"?"ok":bundle.status==="error"?"error":"unknown"):"skipped",
        buyRoute:route.buy,sellRoute:route.sell,routeQuality:route.quality};
      c.snapshots.push(snap); if(c.snapshots.length>12)c.snapshots.shift();
      const scored=scoreCandidate(c); c.score=scored.score;c.dataConfidence=scored.confidence;c.decisionReason=scored.reason;
      if(age>=config.minObservationMs&&c.score>=config.buyScore&&c.dataConfidence>=config.minDataConfidence&&snap.buyRoute&&(!config.requireSellRoute||snap.sellRoute))c.state="READY";
      else if(age>=config.maxObservationMs){c.state="DROPPED";c.decisionReason=`NO BUY: observation ended at score ${Math.round(c.score)} / data ${Math.round(c.dataConfidence)}%`;}
      else if(c.score>=config.promoteScore)c.state="DEVELOPING"; else c.state="WATCHING";

      if(snap.dataErrors?.length&&snap.priceUsd==null)log.warn(`[DATA] ${c.token.name} ($${c.token.symbol}) | ${snap.dataErrors.join(" | ")}`);
      log.scan({name:c.token.name,symbol:c.token.symbol,priceUsd:snap.priceUsd,score:c.score,confidence:c.dataConfidence,
        status:c.state==="READY"?"✅ READY":c.state==="DROPPED"?"❌ NO BUY":`⏳ ${c.state}`,reason:c.decisionReason,sources:[...c.sources],rankText:this.rankText(c),
        details:{buys1m:snap.buys1m,sells1m:snap.sells1m,buys5m:snap.buys5m,sells5m:snap.sells5m,volume1mUsd:snap.volume1mUsd,volume5mUsd:snap.volume5mUsd,
          liquidityUsd:snap.liquidityUsd,holderCount:snap.holderCount,uniqueWallet1m:snap.uniqueWallet1m,
          top10HolderPct:snap.top10HolderPct,deep:`BE:${doBirdeye?"Y":"-"} B:${doBundle?"Y":"-"} R:${doRoute?"Y":"-"}`}});
      if(c.state==="READY")await this.onReady(c);
    }catch(e){log.warn(`[SCAN ERROR] ${c.token.name} ${c.token.address}: ${e instanceof Error?e.message:String(e)}`);}finally{c.collecting=false;}
  }

  async tick(){
    const now=Date.now(); if(now-this.lastDiscovery>=config.discoveryIntervalMs){this.lastDiscovery=now;await this.discover();}
    const active=[...this.candidates.values()].filter(c=>!["DROPPED","BOUGHT","FAILED"].includes(c.state)).sort((a,b)=>this.priority(b)-this.priority(a));
    const dex=await this.dex.batch(active.map(c=>c.token.address));
    for(const c of active){const d=dex.get(c.token.address);if(d)c.token.seed={...(c.token.seed??{}),...Object.fromEntries(Object.entries(d).filter(([,v])=>v!==undefined))};}
    await Promise.all(active.map((c,i)=>this.collect(c,i)));
  }
}
