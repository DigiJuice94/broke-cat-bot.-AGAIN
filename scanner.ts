import { Birdeye } from "./birdeye.ts";
import { getAxiomTrending, getFomoTrending } from "./trendingFeed.ts";
import { bundleRisk } from "./bundle.ts";
import { Jupiter } from "./jupiter.ts";
import { config } from "./config.ts";
import { Candidate, DiscoveredToken, Snapshot } from "./types.ts";
import { log } from "./log.ts";
import { scoreCandidate } from "./scoring.ts";
import { DexScreener } from "./dexscreener.ts";
import { MobulaAxiomDiscovery } from "./mobula.ts";

export class Scanner {
  readonly candidates = new Map<string, Candidate>();
  private lastDiscovery = 0;
  private lastDexDiscovery = 0;
  private lastBirdeyeNew = 0;
  private lastBirdeyeTrending = 0;
  private lastBirdeyeMeme = 0;
  private dex = new DexScreener();
  private mobula = new MobulaAxiomDiscovery();
  constructor(private birdeye: Birdeye, private jupiter: Jupiter, private onReady: (c: Candidate) => Promise<void>) {}

  private activeCount() {
    return [...this.candidates.values()].filter(c=>!["DROPPED","BOUGHT","FAILED"].includes(c.state)).length;
  }

  private add(t: DiscoveredToken) {
    const now = Date.now();
    const existing = this.candidates.get(t.address);
    if (existing) {
      const previousSeen = existing.lastSeenAt;
      existing.sources.add(t.source); existing.lastSeenAt=now;
      if (t.rank != null) {
        const oldRank=existing.trendingRanks[t.source];
        existing.previousTrendingRanks ??= {};
        existing.rankMovement ??= {};
        if(oldRank!=null){
          existing.previousTrendingRanks[t.source]=oldRank;
          existing.rankMovement[t.source]=oldRank-t.rank; // positive = climbing
        }
        existing.trendingRanks[t.source]=t.rank;
      }
      if (existing.token.name==="Unknown" && t.name!=="Unknown") existing.token.name=t.name;
      if (existing.token.symbol==="?" && t.symbol!=="?") existing.token.symbol=t.symbol;
      if (existing.token.decimals==null && t.decimals!=null) existing.token.decimals=t.decimals;
      if (t.seed) existing.token.seed={...(existing.token.seed??{}),...Object.fromEntries(Object.entries(t.seed).filter(([,v])=>v!==undefined))};

      // Critical starvation fix: a token that was dropped can become interesting
      // again. If DEX/Birdeye rediscover it after a cooldown and there is room in
      // the watch pool, start a fresh observation window instead of leaving it
      // permanently DROPPED.
      if (existing.state === "DROPPED" && this.activeCount() < config.maxActiveCandidates) {
        const droppedAt = existing.lastDroppedAt ?? previousSeen;
        const isTrending = ["fomo","axiom","mobula-axiom-volume","mobula-axiom-price","birdeye-trending","dex-momentum"].includes(t.source);
        const cooldown = isTrending ? config.trendingRewatchCooldownMs : (this.activeCount() < config.minActiveCandidates ? Math.min(config.rewatchCooldownMs, 15_000) : config.rewatchCooldownMs);
        if (now - droppedAt >= cooldown) {
          existing.firstSeenAt = now;
          existing.snapshots = [];
          existing.score = 0;
          existing.dataConfidence = 0;
          existing.state = "WATCHING";
          existing.decisionReason = "rediscovered — fresh observation";
          existing.collecting = false;
          existing.watchCycles = (existing.watchCycles ?? 1) + 1;
          log.info(`[REWATCH] ${existing.token.name} ($${existing.token.symbol}) | fresh 30-90s observation | source:${t.source}`);
        }
      }
      return;
    }
    if (this.activeCount()>=config.maxActiveCandidates) return;
    this.candidates.set(t.address,{token:t,firstSeenAt:now,lastSeenAt:now,sources:new Set([t.source]),
      trendingRanks:t.rank==null?{}:{[t.source]:t.rank},previousTrendingRanks:{},rankMovement:{},snapshots:[],score:0,dataConfidence:0,state:"WATCHING",collecting:false,watchCycles:1});
  }

  private pruneKnown() {
    const now = Date.now();
    for (const [address,c] of this.candidates) {
      if (["DROPPED","FAILED"].includes(c.state) && now-c.lastSeenAt > config.knownRetentionMs) this.candidates.delete(address);
    }
  }

  private async birdeyeFeed(label:string, due:boolean, fn:()=>Promise<DiscoveredToken[]>) {
    if (!due || !this.birdeye.isCuAvailable()) return;
    try { for (const t of await fn()) this.add(t); }
    catch(e) {
      const m=e instanceof Error?e.message:String(e);
      if (!m.toLowerCase().includes("cooldown")) log.warn(`[DISCOVERY ${label}] ${m}`);
    }
  }

  private async discover() {
    const now=Date.now();
    // PRIMARY trending lane: Mobula Pulse recreates Axiom-style discovery with ranked Solana tokens.
    // It is intentionally queried before DEX/new-token fallbacks so popular runners get scanner capacity first.
    try { for(const t of (await this.mobula.trending()).slice(0,config.mobulaActiveSlots)) this.add(t); }
    catch(e){ log.warn(`[MOBULA DISCOVERY] ${e instanceof Error?e.message:String(e)}`); }

    // Optional direct/custom adapters remain supported if the user later obtains a supported feed.
    const external = await Promise.allSettled([getAxiomTrending(),getFomoTrending()]);
    for(const r of external) if(r.status==="fulfilled") for(const t of r.value) this.add(t);

    // Birdeye Trending gets second priority behind the Axiom-style lane.
    const trendDue=now-this.lastBirdeyeTrending>=config.birdeyeTrendingIntervalMs;
    if(trendDue){this.lastBirdeyeTrending=now; await this.birdeyeFeed("BIRDEYE TREND",true,()=>this.birdeye.trending());}

    // DEX Screener is the always-on, no-key fallback/enrichment discovery source.
    if(now-this.lastDexDiscovery>=config.dexDiscoveryIntervalMs){
      this.lastDexDiscovery=now;
      try { for(const t of await this.dex.discover()) this.add(t); }
      catch(e){ log.warn(`[DEX DISCOVERY] ${e instanceof Error?e.message:String(e)}`); }
    }

    // New listings remain a separate early-runner lane after trending capacity is reserved.
    const newDue=now-this.lastBirdeyeNew>=config.birdeyeNewIntervalMs;
    if(newDue){this.lastBirdeyeNew=now; await this.birdeyeFeed("BIRDEYE NEW",true,()=>this.birdeye.newListings());}
    if(config.birdeyeMemeIntervalMs>0){
      const memeDue=now-this.lastBirdeyeMeme>=config.birdeyeMemeIntervalMs;
      if(memeDue){this.lastBirdeyeMeme=now; await this.birdeyeFeed("BIRDEYE MEME",true,()=>this.birdeye.memeMomentum());}
    }
    this.pruneKnown();
    const active=this.activeCount();
    const poolState=active<config.minActiveCandidates?"REFILLING":"HEALTHY";
    const trending=[...this.candidates.values()].filter(c=>!["DROPPED","BOUGHT","FAILED"].includes(c.state) && (["fomo","axiom","mobula-axiom-volume","mobula-axiom-price","birdeye-trending","dex-momentum"] as const).some(x=>c.sources.has(x))).length;
    const early=Math.max(0,active-trending);
    log.info(`[DISCOVERY] active=${active} 🔥trending=${trending} 🐣early=${early} target≥${config.minActiveCandidates} total-known=${this.candidates.size} pool:${poolState} | AXIOM-STYLE:${this.mobula.enabled()?"Mobula:on":"off"} DEX:on Birdeye:${this.birdeye.isCuAvailable()?"available":"CU cooldown"} | ${this.birdeye.budgetText()}`);
  }
  private rankText(c:Candidate){return Object.entries(c.trendingRanks).map(([k,v])=>{
    const move=(c.rankMovement as any)?.[k]??0;
    return `${k}#${v}${move>0?`↑${move}`:move<0?`↓${Math.abs(move)}`:""}`;
  }).join(",");}
  private priority(c:Candidate){
    // Trending lane always gets first shot at scanner/deep-check capacity.
    const axiomStyle=(c.sources.has("mobula-axiom-volume")||c.sources.has("mobula-axiom-price"))?12:0;
    const bestClimb=Math.max(0,...Object.values(c.rankMovement??{}).map(Number));
    return axiomStyle+(c.sources.has("fomo")?10:0)+(c.sources.has("axiom")?10:0)+(c.sources.has("birdeye-trending")?7:0)+(c.sources.has("dex-momentum")?5:0)+(c.sources.has("birdeye-new")?2:0)+(c.sources.has("dex-profile")?0.5:0)+(c.sources.has("dex-boost-top")?0.25:0)+(c.sources.has("dex-boost")?0:0)+Math.min(4,bestClimb*0.5)+c.score/100;
  }

  private async collect(c:Candidate,index:number) {
    if(c.collecting||["DROPPED","BOUGHT","FAILED"].includes(c.state))return;
    c.collecting=true;
    try{
      const seed=c.token.seed??{};
      // Birdeye overview is only for already-promising finalists. DEX data builds the first score.
      const doBirdeye=this.birdeye.isCuAvailable() && index<config.birdeyeDeepCandidates && c.score>=config.birdeyeDeepMinScore;
      const age=Date.now()-c.firstSeenAt;
      const doRoute=(index<config.routeDeepCandidates && age>=Math.min(20_000,config.minObservationMs/2)) || c.score>=config.promoteScore;
      const doHolder=this.birdeye.isCuAvailable() && index<config.birdeyeHolderCandidates && c.score>=config.birdeyeHolderMinScore;
      const doBundle=index<config.bundleDeepCandidates || c.score>=70;

      const marketPromise=doBirdeye?this.birdeye.snapshot(c.token.address,seed):Promise.resolve(seed);
      const bundlePromise=doBundle?bundleRisk(c.token.address):Promise.resolve({risk:undefined,status:"unknown" as const});
      const routePromise=doRoute?this.jupiter.canBuyAndSell(c.token.address):Promise.resolve({buy:false,sell:false,quality:undefined});
      const holderPromise=doHolder?this.birdeye.holderStats(c.token.address):Promise.resolve({});
      const [market,bundle,route,holder]=await Promise.all([marketPromise,bundlePromise,routePromise,holderPromise]);

      const snap:Snapshot={at:Date.now(),...market,...holder,
        bundleRisk:bundle.risk,bundleStatus:doBundle?(bundle.status==="ok"?"ok":bundle.status==="error"?"error":"unknown"):"skipped",
        buyRoute:route.buy,sellRoute:route.sell,routeQuality:route.quality};
      c.snapshots.push(snap); if(c.snapshots.length>12)c.snapshots.shift();
      let scored=scoreCandidate(c); c.score=scored.score;c.dataConfidence=scored.confidence;c.decisionReason=scored.reason;

      // Same-cycle finalist escalation: if the NEW data collected above pushes a
      // candidate across the buy threshold, do not wait for the next scanner tick.
      // Immediately fetch any missing high-value checks, then recalculate the score
      // and READY state using those results.
      let finalBirdeye=doBirdeye, finalHolder=doHolder, finalBundle=doBundle, finalRoute=doRoute;
      if(c.score>=config.buyScore){
        log.info(`[FINALIST NOW] ${c.token.name} ($${c.token.symbol}) | fresh score ${Math.round(c.score)}/100 crossed buy threshold — verifying now`);

        const tasks:Promise<void>[]=[];
        if(!finalRoute){
          finalRoute=true;
          tasks.push(this.jupiter.canBuyAndSell(c.token.address).then(r=>{snap.buyRoute=r.buy;snap.sellRoute=r.sell;snap.routeQuality=r.quality;}));
        }
        if(!finalBirdeye && this.birdeye.isCuAvailable()){
          finalBirdeye=true;
          tasks.push(this.birdeye.snapshot(c.token.address,c.token.seed??{}).then(m=>{Object.assign(snap,m);}));
        }
        if(!finalHolder && this.birdeye.isCuAvailable()){
          finalHolder=true;
          tasks.push(this.birdeye.holderStats(c.token.address).then(h=>{Object.assign(snap,h);}));
        }
        if(!finalBundle){
          finalBundle=true;
          tasks.push(bundleRisk(c.token.address).then(b=>{snap.bundleRisk=b.risk;snap.bundleStatus=b.status==="ok"?"ok":b.status==="error"?"error":"unknown";}));
        }
        if(tasks.length) await Promise.all(tasks);
        scored=scoreCandidate(c); c.score=scored.score;c.dataConfidence=scored.confidence;c.decisionReason=scored.reason;
      }

      if(age>=config.minObservationMs&&c.score>=config.buyScore&&c.dataConfidence>=config.minDataConfidence&&snap.buyRoute&&(!config.requireSellRoute||snap.sellRoute))c.state="READY";
      else if(age>=config.maxObservationMs){c.state="DROPPED";c.lastDroppedAt=Date.now();c.decisionReason=`NO BUY: observation ended at score ${Math.round(c.score)} / data ${Math.round(c.dataConfidence)}%`;}
      else if(c.score>=config.promoteScore)c.state="DEVELOPING"; else c.state="WATCHING";

      if(snap.dataErrors?.length&&snap.priceUsd==null&&!snap.dataErrors.some(x=>x.includes("cooldown")))log.warn(`[DATA] ${c.token.name} ($${c.token.symbol}) | ${snap.dataErrors.join(" | ")}`);
      log.scan({name:c.token.name,symbol:c.token.symbol,priceUsd:snap.priceUsd,score:c.score,confidence:c.dataConfidence,
        status:c.state==="READY"?"✅ READY":c.state==="DROPPED"?"❌ NO BUY":`⏳ ${c.state}`,reason:c.decisionReason,sources:[...c.sources],rankText:this.rankText(c),
        details:{buys1m:snap.buys1m,sells1m:snap.sells1m,buys5m:snap.buys5m,sells5m:snap.sells5m,volume1mUsd:snap.volume1mUsd,volume5mUsd:snap.volume5mUsd,
          liquidityUsd:snap.liquidityUsd,holderCount:snap.holderCount,uniqueWallet1m:snap.uniqueWallet1m,
          top10HolderPct:snap.top10HolderPct,deep:`BE:${finalBirdeye?"Y":"-"} H:${finalHolder?"Y":"-"} B:${finalBundle?"Y":"-"} R:${finalRoute?"Y":"-"}`}});
      if(c.state==="READY")await this.onReady(c);
    }catch(e){log.warn(`[SCAN ERROR] ${c.token.name} ${c.token.address}: ${e instanceof Error?e.message:String(e)}`);}finally{c.collecting=false;}
  }

  async tick(){
    const now=Date.now(); if(now-this.lastDiscovery>=config.discoveryIntervalMs){this.lastDiscovery=now;await this.discover();}
    const active=[...this.candidates.values()].filter(c=>!["DROPPED","BOUGHT","FAILED"].includes(c.state)).sort((a,b)=>this.priority(b)-this.priority(a));
    const dex=await this.dex.batch(active.map(c=>c.token.address));
    for(const c of active){const d=dex.get(c.token.address) as any;if(d){
      c.token.seed={...(c.token.seed??{}),...Object.fromEntries(Object.entries(d).filter(([k,v])=>v!==undefined&&!k.startsWith("token")))};
      if(c.token.name==="Unknown"&&d.tokenName)c.token.name=d.tokenName;
      if(c.token.symbol==="?"&&d.tokenSymbol)c.token.symbol=d.tokenSymbol;
      // Organic momentum lane: an already-known token can become a runner even if
      // it is no longer new. This is deliberately independent of paid DEX boosts.
      const buys=Number(d.buys5m??0), sells=Number(d.sells5m??0);
      const ratio=buys/Math.max(1,sells), p5=Number(d.priceChange5mPct??0);
      if(buys>=config.momentumMinBuys5m && ratio>=config.momentumMinBuySellRatio && p5>=config.momentumMinPrice5mPct){
        c.sources.add("dex-momentum");
        c.trendingRanks["dex-momentum"]=1;
      }
    }}
    // Re-sort after DEX data can promote an older token into the trending lane.
    const ordered=[...active].sort((a,b)=>this.priority(b)-this.priority(a));
    await Promise.all(ordered.map((c,i)=>this.collect(c,i)));
  }
}
