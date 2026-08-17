import fs from "node:fs";
import { Jupiter } from "./jupiter.ts";
import { config, LAMPORTS_PER_SOL, SOL_MINT, USDC_MINT } from "./config.ts";
import { Candidate, Position } from "./types.ts";
import { log } from "./log.ts";
import { choosePositionUsd } from "./sizing.ts";
import { WalletService } from "./wallet.ts";
import { Notifier } from "./notifier.ts";
import { DexScreener } from "./dexscreener.ts";
import { SolPriceService } from "./solPrice.ts";
import { socialPerformance } from "./socialPerformance.ts";

type ClosedTrack={mint:string;name:string;symbol:string;entryPriceUsd:number;exitPriceUsd:number;exitPnlPct:number;closedAt:number;logged:Set<number>;socialAccounts:string[]};
type ExecutableExit={amountRaw:bigint;outSol:number;outUsd:number;pnlPct:number;dexImpliedUsd:number;valueRatio:number};
type SavedPosition=Omit<Position,"tokenAmountRaw"|"entrySolLamports">&{tokenAmountRaw:string;entrySolLamports:string};

export class Trader {
  readonly positions = new Map<string, Position>();
  private busy = new Set<string>();
  private lastStatusAt = 0;
  private lastIdleStatusAt = 0;
  private lastExitAt = 0;
  private notifier = new Notifier();
  private dex = new DexScreener();
  private solPrice: SolPriceService;
  private closedTracks:ClosedTrack[]=[];

  constructor(private wallet: WalletService, private jupiter: Jupiter) {
    this.solPrice = new SolPriceService(this.dex, this.jupiter);
    this.solPrice.start();
    this.restoreState();
  }

  async warmSolPrice(){await this.solPrice.warm();}
  async initialize(){if(config.walletReconciliationEnabled)await this.reconcileWalletPositions();}

  private restoreState(){
    try{
      if(!fs.existsSync(config.positionStateFile))return;
      const parsed=JSON.parse(fs.readFileSync(config.positionStateFile,"utf8")) as {positions?:SavedPosition[];lastExitAt?:number};
      for(const x of parsed.positions??[]){
        const p:Position={...x,tokenAmountRaw:BigInt(x.tokenAmountRaw),entrySolLamports:BigInt(x.entrySolLamports)};
        this.positions.set(p.mint,p);
      }
      this.lastExitAt=Number(parsed.lastExitAt??0);
      if(this.positions.size)log.info(`[STATE] ♻️ Restored ${this.positions.size} tracked position(s) from ${config.positionStateFile}`);
    }catch(e){log.warn(`[STATE] restore failed: ${e instanceof Error?e.message:String(e)}`);}
  }

  private saveState(){
    try{
      const positions=[...this.positions.values()].map(p=>({...p,tokenAmountRaw:p.tokenAmountRaw.toString(),entrySolLamports:p.entrySolLamports.toString()}));
      fs.writeFileSync(config.positionStateFile,JSON.stringify({savedAt:Date.now(),lastExitAt:this.lastExitAt,positions},null,2));
    }catch(e){log.warn(`[STATE] save failed: ${e instanceof Error?e.message:String(e)}`);}
  }

  private async reconcileWalletPositions(){
    if(!config.liveTrading||!this.wallet.address)return;
    try{
      const holdings=(await this.wallet.tokenHoldingsRaw()).filter(h=>h.mint!==SOL_MINT&&h.mint!==USDC_MINT);
      const walletMints=new Set(holdings.map(h=>h.mint));
      for(const [mint,p] of [...this.positions]){
        if(!walletMints.has(mint)){
          log.warn(`[RECONCILE] ${p.name} ($${p.symbol}) | wallet balance is zero → closing stale internal position`);
          this.positions.delete(mint);
        }
      }
      if(config.recoverUnknownWalletTokens){
        const unknown=holdings.filter(h=>!this.positions.has(h.mint));
        if(unknown.length){
          const market=await this.dex.batch(unknown.map(h=>h.mint));
          const solUsd=await this.solPrice.get();
          for(const h of unknown){
            const s:any=market.get(h.mint); const price=Number(s?.priceUsd??0);
            if(!price)continue;
            let baselineUsd=price*(Number(h.amount)/10**h.decimals);
            try{const q=await this.jupiter.sellQuoteSol(h.mint,h.amount);baselineUsd=q.outSol*solUsd;}catch{}
            const name=String(s?.tokenName??"Recovered Token"),symbol=String(s?.tokenSymbol??"?");
            const p:Position={mint:h.mint,name,symbol,decimals:h.decimals,tokenAmountRaw:h.amount,entrySolLamports:0n,
              entryUsd:Math.max(.01,baselineUsd),originalEntryUsd:Math.max(.01,baselineUsd),entryPriceUsd:price,openedAt:Date.now(),highPriceUsd:price,
              scoreAtBuy:undefined,confidenceAtBuy:undefined,paper:false,runnerProfitStage:0,realizedProceedsUsd:0,realizedCostBasisUsd:0,recoveredFromWallet:true};
            this.positions.set(h.mint,p);
            log.warn(`♻️ [RECOVERED POSITION] ${name} ($${symbol}) | wallet raw ${h.amount.toString()} | baseline value≈$${baselineUsd.toFixed(2)} | CA:${h.mint}`);
          }
        }
      }
      this.saveState();
      log.info(`[RECONCILE] Wallet ↔ bot positions synced | Open:${this.positions.size}`);
    }catch(e){log.warn(`[RECONCILE] failed: ${e instanceof Error?e.message:String(e)}`);}
  }

  async buy(c: Candidate){
    if(this.busy.has(c.token.address)||this.positions.has(c.token.address))return;
    const snap=c.snapshots.at(-1)!;
    const isFlame=c.score>=config.flameAutoBuyScore;
    const cooldownLeft=config.tradeCooldownMs-(Date.now()-this.lastExitAt);
    if(cooldownLeft>0&&!(isFlame&&config.flameBypassCooldown)){
      c.state="DEVELOPING";c.decisionReason=`COOLDOWN: ${Math.ceil(cooldownLeft/1000)}s after last exit`;
      log.scan({name:c.token.name,symbol:c.token.symbol,priceUsd:snap.priceUsd,score:c.score,confidence:c.dataConfidence,status:"⏳ COOLDOWN",reason:c.decisionReason});
      return;
    }
    const routeQuality=Number(snap.routeQuality??0);
    const routeCostPct=Math.max(0,100-routeQuality);
    const expectedNetEdge=config.takeProfitPct-routeCostPct*config.routeCostMultiplier;
    if(config.feeAwareEntryEnabled&&(routeQuality<config.minRouteQualityPct||expectedNetEdge<config.minExpectedNetEdgePct)){
      c.state="DEVELOPING";
      c.decisionReason=`FEE GATE: route ${routeQuality.toFixed(1)}% | est round-trip drag ${routeCostPct.toFixed(1)}% | expected edge ${expectedNetEdge.toFixed(1)}%`;
      log.scan({name:c.token.name,symbol:c.token.symbol,priceUsd:snap.priceUsd,score:c.score,confidence:c.dataConfidence,status:isFlame?"🔥 FLAME BLOCKED":"💸 NO BUY",reason:c.decisionReason});
      return;
    }

    this.busy.add(c.token.address);
    try{
      const [solBalance,solUsd]=await Promise.all([this.wallet.solBalance(),this.solPrice.get()]);
      const spendableSol=Math.max(0,solBalance-config.solFeeReserve),spendableUsd=spendableSol*solUsd;
      const usd=choosePositionUsd({score:c.score,confidence:c.dataConfidence,spendableUsd,routeQuality:snap.routeQuality??50,multiTrend:c.sources.has("axiom")&&c.sources.has("fomo")});
      if(usd<config.minPositionUsd){
        c.state="FAILED";c.decisionReason=`NO BUY: spendable balance below $${config.minPositionUsd}`;
        log.scan({name:c.token.name,symbol:c.token.symbol,priceUsd:snap.priceUsd,score:c.score,confidence:c.dataConfidence,status:"❌ NO BUY",reason:c.decisionReason});return;
      }
      const sol=Math.min(spendableSol,usd/solUsd),lamports=BigInt(Math.floor(sol*LAMPORTS_PER_SOL));
      const entryPrice=snap.priceUsd;if(!entryPrice||entryPrice<=0)throw new Error("entry price unavailable");

      if(!config.liveTrading){
        this.positions.set(c.token.address,{mint:c.token.address,name:c.token.name,symbol:c.token.symbol,decimals:c.token.decimals||6,tokenAmountRaw:0n,
          entrySolLamports:lamports,entryUsd:usd,originalEntryUsd:usd,entryPriceUsd:entryPrice,openedAt:Date.now(),highPriceUsd:entryPrice,
          scoreAtBuy:c.score,confidenceAtBuy:c.dataConfidence,paper:true,socialAccountsAtBuy:snap.social?.keyAccounts??[],metaRunnerAtBuy:c.metaRunner,
          realizedProceedsUsd:0,realizedCostBasisUsd:0,runnerProfitStage:0});
        this.saveState();c.state="BOUGHT";
        log.scan({name:c.token.name,symbol:c.token.symbol,priceUsd:snap.priceUsd,score:c.score,confidence:c.dataConfidence,status:isFlame?"🔥 PAPER FLAME BUY":"🧪 PAPER BUY",reason:`would buy $${usd.toFixed(2)} | route ${routeQuality.toFixed(1)}% | CA:${c.token.address}`});return;
      }

      const result=await this.jupiter.swap(SOL_MINT,c.token.address,lamports);
      const [tokenInfo,buyFeeLamports]=await Promise.all([this.wallet.tokenBalanceRaw(c.token.address),this.wallet.transactionFeeLamports(result.signature)]);
      const raw=tokenInfo.amount>0n?tokenInfo.amount:result.outRaw,decimals=tokenInfo.decimals||c.token.decimals||6;
      const buyFeeUsd=(buyFeeLamports/LAMPORTS_PER_SOL)*solUsd;
      const actualCostUsd=(Number(result.inRaw)/LAMPORTS_PER_SOL)*solUsd+buyFeeUsd;
      const actualEntryPrice=snap.priceUsd??(actualCostUsd/(Number(raw)/10**decimals));
      this.positions.set(c.token.address,{mint:c.token.address,name:c.token.name,symbol:c.token.symbol,decimals,tokenAmountRaw:raw,
        entrySolLamports:result.inRaw,entryUsd:actualCostUsd,originalEntryUsd:actualCostUsd,entryPriceUsd:actualEntryPrice,openedAt:Date.now(),highPriceUsd:actualEntryPrice,
        signature:result.signature,scoreAtBuy:c.score,confidenceAtBuy:c.dataConfidence,paper:false,socialAccountsAtBuy:snap.social?.keyAccounts??[],metaRunnerAtBuy:c.metaRunner,
        realizedProceedsUsd:0,realizedCostBasisUsd:0,buyTxFeeUsd:buyFeeUsd,runnerProfitStage:0});
      this.saveState();c.state="BOUGHT";
      log.scan({name:c.token.name,symbol:c.token.symbol,priceUsd:snap.priceUsd,score:c.score,confidence:c.dataConfidence,status:isFlame?"🔥 AUTO BOUGHT":"🟢 BOUGHT",
        reason:`$${actualCostUsd.toFixed(2)} incl buy tx fee≈$${buyFeeUsd.toFixed(4)} | route ${routeQuality.toFixed(1)}% | CA:${c.token.address} | tx ${result.signature}`});
      void this.notifier.send({title:`${isFlame?"🔥":"🐱"} BOUGHT $${c.token.symbol}`,message:`${c.token.name} ($${c.token.symbol}) | $${actualCostUsd.toFixed(2)} | Score ${c.score}/100 | Entry $${actualEntryPrice.toPrecision(6)}`,priority:"high",tags:["chart_with_upwards_trend"]});
    }catch(e){
      c.state="FAILED";c.decisionReason=`BUY FAILED: ${e instanceof Error?e.message:String(e)}`;
      log.error(`${isFlame?"[🔥 FLAME BUY FAILED]":"[BUY FAILED]"} ${c.token.name} | Score:${Math.round(c.score)} | ${c.decisionReason}`);
    }finally{this.busy.delete(c.token.address);}
  }

  private async executableExit(p:Position,dexPrice:number):Promise<ExecutableExit|null>{
    if(p.paper)return null;
    const bal=await this.wallet.tokenBalanceRaw(p.mint),amountRaw=bal.amount>0n?bal.amount:p.tokenAmountRaw;if(amountRaw<=0n)return null;
    const [quote,solUsd]=await Promise.all([this.jupiter.sellQuoteSol(p.mint,amountRaw),this.solPrice.get()]);
    const estimatedFeeUsd=config.estimatedNetworkFeeSol*solUsd;
    const outUsd=Math.max(0,quote.outSol*solUsd-estimatedFeeUsd);
    const pnlPct=p.entryUsd>0?((outUsd-p.entryUsd)/p.entryUsd)*100:0;
    const dexImpliedUsd=p.entryUsd*(dexPrice/p.entryPriceUsd),valueRatio=dexImpliedUsd>0?outUsd/dexImpliedUsd:1;
    p.highExecutablePnlPct=Math.max(p.highExecutablePnlPct??pnlPct,pnlPct);p.lastExecutablePnlPct=pnlPct;p.lastExecutableUsd=outUsd;p.lastExecutableQuoteAt=Date.now();
    return{amountRaw,outSol:quote.outSol,outUsd,pnlPct,dexImpliedUsd,valueRatio};
  }

  private rememberExit(p:Position,price:number,pnlPct:number){
    this.closedTracks.push({mint:p.mint,name:p.name,symbol:p.symbol,entryPriceUsd:p.entryPriceUsd,exitPriceUsd:price,exitPnlPct:pnlPct,closedAt:Date.now(),logged:new Set(),socialAccounts:p.socialAccountsAtBuy??[]});
    this.closedTracks=this.closedTracks.filter(x=>Date.now()-x.closedAt<=65*60000);
  }

  private async trackClosedTrades(){
    if(!this.closedTracks.length)return;const due=this.closedTracks.filter(x=>[5,15,30,60].some(m=>Date.now()-x.closedAt>=m*60000&&!x.logged.has(m)));if(!due.length)return;
    const market=await this.dex.batch([...new Set(due.map(x=>x.mint))]);
    for(const x of due){const price=market.get(x.mint)?.priceUsd;if(!price)continue;for(const m of[5,15,30,60]){if(Date.now()-x.closedAt>=m*60000&&!x.logged.has(m)){x.logged.add(m);const fromEntry=((price-x.entryPriceUsd)/x.entryPriceUsd)*100,afterExit=((price-x.exitPriceUsd)/x.exitPriceUsd)*100;const cls=x.exitPnlPct<0&&afterExit>20?"EARLY EXIT":x.exitPnlPct<0&&afterExit<0?"GOOD STOP":"FOLLOW-UP";if([15,30,60].includes(m)&&x.socialAccounts.length)socialPerformance.record(x.socialAccounts,fromEntry);log.info(`[EXIT REVIEW ${m}m] ${x.name} ($${x.symbol}) | exit P/L ${x.exitPnlPct>=0?"+":""}${x.exitPnlPct.toFixed(1)}% | now vs entry ${fromEntry>=0?"+":""}${fromEntry.toFixed(1)}% | since exit ${afterExit>=0?"+":""}${afterExit.toFixed(1)}% | ${cls}`);}}}
  }

  private async sell(p:Position,reason:string,currentPrice?:number,expected?:ExecutableExit|null,fractionCurrent=1){
    if(this.busy.has(p.mint))return;this.busy.add(p.mint);
    try{
      fractionCurrent=Math.max(.0001,Math.min(1,fractionCurrent));
      const originalEntry=p.originalEntryUsd??p.entryUsd;
      if(p.paper){
        const price=currentPrice??p.entryPriceUsd,fullValue=p.entryUsd*(price/p.entryPriceUsd),outUsd=fullValue*fractionCurrent,costBasis=p.entryUsd*fractionCurrent;
        const tranchePnl=costBasis>0?((outUsd-costBasis)/costBasis)*100:0;
        p.realizedProceedsUsd=(p.realizedProceedsUsd??0)+outUsd;p.realizedCostBasisUsd=(p.realizedCostBasisUsd??0)+costBasis;p.entryUsd=Math.max(0,p.entryUsd-costBasis);
        if(fractionCurrent>=.999||p.entryUsd<=.01){const totalPnl=((p.realizedProceedsUsd??0)-originalEntry)/originalEntry*100;this.positions.delete(p.mint);this.lastExitAt=Date.now();this.rememberExit(p,price,totalPnl);log.info(`[SELL] ${p.name} ($${p.symbol}) | 💰 PAPER SOLD | ${reason} | NET P/L ${totalPnl>=0?"+":""}${totalPnl.toFixed(1)}%`);}else{log.info(`[SELL] ${p.name} ($${p.symbol}) | 🪙 PAPER PARTIAL ${(fractionCurrent*100).toFixed(0)}% | ${reason} | tranche ${tranchePnl>=0?"+":""}${tranchePnl.toFixed(1)}%`);}this.saveState();return;
      }

      const before=await this.wallet.tokenBalanceRaw(p.mint);if(before.amount<=0n){log.warn(`[SELL] ${p.name} ($${p.symbol}) | wallet token balance already zero; closing stale position`);this.positions.delete(p.mint);this.lastExitAt=Date.now();this.saveState();return;}
      let amount=fractionCurrent>=.999?before.amount:(before.amount*BigInt(Math.floor(fractionCurrent*1_000_000)))/1_000_000n;if(amount<=0n)amount=before.amount;
      const costBasisBefore=p.entryUsd;
      const result=await this.jupiter.swap(p.mint,SOL_MINT,amount);
      const [solUsd,sellFeeLamports,after]=await Promise.all([this.solPrice.get(),this.wallet.transactionFeeLamports(result.signature),this.wallet.tokenBalanceRaw(p.mint)]);
      const grossUsd=(Number(result.outRaw)/LAMPORTS_PER_SOL)*solUsd,sellFeeUsd=(sellFeeLamports/LAMPORTS_PER_SOL)*solUsd,netOutUsd=Math.max(0,grossUsd-sellFeeUsd);
      const soldRaw=before.amount>after.amount?before.amount-after.amount:result.inRaw;
      const soldFraction=before.amount>0n?Number(soldRaw*1_000_000n/before.amount)/1_000_000:1;
      const soldPct=soldFraction*100,costBasisSold=costBasisBefore*soldFraction,tranchePnlPct=costBasisSold>0?((netOutUsd-costBasisSold)/costBasisSold)*100:0;
      p.realizedProceedsUsd=(p.realizedProceedsUsd??0)+netOutUsd;p.realizedCostBasisUsd=(p.realizedCostBasisUsd??0)+costBasisSold;p.entryUsd=Math.max(0,costBasisBefore-costBasisSold);p.tokenAmountRaw=after.amount;p.lastExecutableUsd=undefined;
      const effectivelyClosed=after.amount===0n||soldPct>=99.5;
      const totalRealizedNet=(p.realizedProceedsUsd??0)-(p.realizedCostBasisUsd??0),totalPnlPct=originalEntry>0?totalRealizedNet/originalEntry*100:0;
      if(effectivelyClosed){this.positions.delete(p.mint);this.lastExitAt=Date.now();this.rememberExit(p,currentPrice??p.entryPriceUsd,totalPnlPct);} 
      const rugLike=tranchePnlPct<=-config.rugExitPct||(expected&&expected.valueRatio<config.minExecutableValueRatio),label=effectivelyClosed?(rugLike?"🚨 RUG/LIQUIDITY EXIT":"💰 SOLD"):"🪙 PARTIAL PROFIT";
      log.info(`[SELL] ${p.name} ($${p.symbol}) | ${label} | ${reason} | sold ${soldPct.toFixed(1)}% | gross $${grossUsd.toFixed(2)} | tx fee $${sellFeeUsd.toFixed(4)} | NET $${netOutUsd.toFixed(2)} | tranche P/L ${tranchePnlPct>=0?"+":""}${tranchePnlPct.toFixed(1)}% | cumulative realized $${totalRealizedNet>=0?"+":""}${totalRealizedNet.toFixed(2)} | tx ${result.signature}`);
      if(effectivelyClosed)void this.notifier.send({title:`${rugLike?"🚨 RUG EXIT":"💰 SOLD"} $${p.symbol}`,message:`${p.name} | ${reason} | Net $${netOutUsd.toFixed(2)} | Total realized ${totalPnlPct>=0?"+":""}${totalPnlPct.toFixed(1)}%`,priority:"max",tags:[totalPnlPct>=0?"moneybag":"warning"]});
      this.saveState();
    }catch(e){const msg=e instanceof Error?e.message:String(e);log.error(`[SELL] ${p.name} ($${p.symbol}) | ⚠️ SELL FAILED — POSITION RETAINED | ${msg}`);void this.notifier.send({title:`⚠️ SELL FAILED $${p.symbol}`,message:`${p.name} | Position retained + will retry | ${msg} | CA ${p.mint}`,priority:"max",tags:["warning"]});}
    finally{this.busy.delete(p.mint);}
  }

  private logCurrentTrade(p:Position,price:number,index:number,total:number,executable?:ExecutableExit|null){
    const chartPnl=((price-p.entryPriceUsd)/p.entryPriceUsd)*100,peakPnl=((p.highPriceUsd-p.entryPriceUsd)/p.entryPriceUsd)*100,ageSec=Math.floor((Date.now()-p.openedAt)/1000),mm=Math.floor(ageSec/60).toString().padStart(2,"0"),ss=(ageSec%60).toString().padStart(2,"0");
    const chartValue=p.entryUsd*(price/p.entryPriceUsd),score=p.scoreAtBuy==null?"?":`${p.scoreAtBuy}/100`,real=executable?` | ExitNow:$${executable.outUsd.toFixed(2)} | REAL P/L:${executable.pnlPct>=0?"+":""}${executable.pnlPct.toFixed(1)}% | Exit/Dex:${(executable.valueRatio*100).toFixed(0)}%`:"";
    const realized=(p.realizedProceedsUsd??0)-(p.realizedCostBasisUsd??0),stage=p.runnerProfitStage??0;
    log.info(`[CURRENT TRADE ${index}/${total}] ${p.paper?"🧪 PAPER HOLDING":"🟢 HOLDING"} | ${p.name} ($${p.symbol}) | Entry:$${p.entryPriceUsd.toPrecision(6)} | Current:$${price.toPrecision(6)} | RemainingBasis:$${p.entryUsd.toFixed(2)} | ChartValue≈$${chartValue.toFixed(2)} | Chart P/L:${chartPnl>=0?"+":""}${chartPnl.toFixed(1)}%${real} | Peak:${peakPnl>=0?"+":""}${peakPnl.toFixed(1)}% | Realized:$${realized>=0?"+":""}${realized.toFixed(2)} | RunnerStage:${stage}/2 | Held:${mm}:${ss} | BuyScore:${score} | CA:${p.mint}`);
  }

  async monitorPositions(){
    const now=Date.now();await this.trackClosedTrades();
    if(config.walletReconciliationEnabled&&config.liveTrading&&now%120000<config.positionPollMs)await this.reconcileWalletPositions();
    const positions=[...this.positions.values()];if(!positions.length){if(now-this.lastIdleStatusAt>=config.idlePositionStatusIntervalMs){this.lastIdleStatusAt=now;log.info(`[OPEN POSITIONS] 0 | 💤 Waiting for runner`);}return;}
    const shouldLogStatus=now-this.lastStatusAt>=config.positionStatusIntervalMs;if(shouldLogStatus)this.lastStatusAt=now;
    const market=await this.dex.batch(positions.map(p=>p.mint));let index=0;
    for(const p of positions){index++;try{
      const s:any=market.get(p.mint),price=s?.priceUsd;if(!price)continue;p.highPriceUsd=Math.max(p.highPriceUsd,price);
      const chartPnl=((price-p.entryPriceUsd)/p.entryPriceUsd)*100,chartDrawdown=((price-p.highPriceUsd)/p.highPriceUsd)*100,ageMin=(Date.now()-p.openedAt)/60000,ageSec=(Date.now()-p.openedAt)/1000;
      const buys=s?.buys1m??s?.buys5m??0,sells=s?.sells1m??s?.sells5m??0,momentumRatio=buys/Math.max(1,sells),momentumPrice=s?.priceChange1mPct??s?.priceChange5mPct??0;
      const momentumStrong=momentumRatio>=config.strongMomentumBuySellRatio&&momentumPrice>=config.strongMomentumMinPrice5mPct;

      if(p.paper){
        if(shouldLogStatus)this.logCurrentTrade(p,price,index,positions.length);
        const stage=p.runnerProfitStage??0;
        if(chartPnl<=-config.hardStopLossPct)await this.sell(p,`HARD STOP ${chartPnl.toFixed(1)}%`,price);
        else if(ageSec<=config.earlyFailureWindowSec&&chartPnl<=-config.earlyFailureLossPct&&!momentumStrong)await this.sell(p,`EARLY FAILURE ${chartPnl.toFixed(1)}%`,price);
        else if(chartPnl<=-config.softStopLossPct&&!momentumStrong)await this.sell(p,`MOMENTUM STOP ${chartPnl.toFixed(1)}%`,price);
        else if(stage===0&&chartPnl>=config.runnerFirstTakeProfitPct&&momentumStrong){const before=p.realizedCostBasisUsd??0;await this.sell(p,`RUNNER TP1 +${chartPnl.toFixed(1)}% → bank ${config.runnerFirstSellPct}%`,price,null,config.runnerFirstSellPct/100);if((p.realizedCostBasisUsd??0)>before){p.runnerProfitStage=1;this.saveState();}}
        else if(stage===1&&chartPnl>=config.runnerSecondTakeProfitPct&&momentumStrong){const before=p.realizedCostBasisUsd??0;const frac=config.runnerSecondSellOriginalPct/(100-config.runnerFirstSellPct);await this.sell(p,`RUNNER TP2 +${chartPnl.toFixed(1)}% → leave 20% moon bag`,price,null,frac);if((p.realizedCostBasisUsd??0)>before){p.runnerProfitStage=2;this.saveState();}}
        else if(stage===2&&chartPnl>=config.moonBagTakeProfitPct)await this.sell(p,`🌙 MOON BAG +${chartPnl.toFixed(1)}% → +200% target hit`,price);
        else if(stage===0&&chartPnl>=config.takeProfitPct&&!momentumStrong)await this.sell(p,`TAKE PROFIT +${chartPnl.toFixed(1)}% | runner momentum faded`,price);
        else if(chartPnl>=config.profitProtectArmPct&&chartDrawdown<=-(stage===2?config.moonBagTrailingStopPct:config.trailingStopPct))await this.sell(p,`PROFIT PROTECT ${chartDrawdown.toFixed(1)}% from high`,price);
        else if(ageMin>=config.maxPositionAgeMin&&!momentumStrong)await this.sell(p,`TIME EXIT ${ageMin.toFixed(1)}m | momentum weak`,price);
        continue;
      }

      const previousExecutableUsd=p.lastExecutableUsd,executable=await this.executableExit(p,price);if(!executable){if(shouldLogStatus)this.logCurrentTrade(p,price,index,positions.length,null);continue;}
      const peakExecutable=p.highExecutablePnlPct??executable.pnlPct,executableDrawdown=peakExecutable-executable.pnlPct,quoteDropPct=previousExecutableUsd&&previousExecutableUsd>0?((previousExecutableUsd-executable.outUsd)/previousExecutableUsd)*100:0,stage=p.runnerProfitStage??0;
      if(shouldLogStatus)this.logCurrentTrade(p,price,index,positions.length,executable);

      if(executable.valueRatio<config.minExecutableValueRatio)await this.sell(p,`LIQUIDITY COLLAPSE | executable ${(executable.valueRatio*100).toFixed(0)}% of chart value | REAL ${executable.pnlPct>=0?"+":""}${executable.pnlPct.toFixed(1)}%`,price,executable);
      else if(quoteDropPct>=config.executableQuoteDropPct)await this.sell(p,`FAST EXIT | executable value dropped ${quoteDropPct.toFixed(1)}% since last poll | REAL ${executable.pnlPct>=0?"+":""}${executable.pnlPct.toFixed(1)}%`,price,executable);
      else if(executable.pnlPct<=-config.hardStopLossPct)await this.sell(p,`${executable.pnlPct<=-config.rugExitPct?"RUG/LIQUIDITY ":""}HARD STOP REAL ${executable.pnlPct.toFixed(1)}%`,price,executable);
      else if(ageSec<=config.earlyFailureWindowSec&&executable.pnlPct<=-config.earlyFailureLossPct&&!momentumStrong)await this.sell(p,`🚨 EARLY FAILURE REAL ${executable.pnlPct.toFixed(1)}% | B/S ${momentumRatio.toFixed(2)}x | momentum ${momentumPrice.toFixed(1)}%`,price,executable);
      else if(executable.pnlPct<=-config.softStopLossPct&&!momentumStrong)await this.sell(p,`MOMENTUM STOP REAL ${executable.pnlPct.toFixed(1)}% | B/S ${momentumRatio.toFixed(2)}x | momentum ${momentumPrice.toFixed(1)}%`,price,executable);
      else if(stage===0&&executable.pnlPct>=config.runnerFirstTakeProfitPct&&momentumStrong){const before=p.realizedCostBasisUsd??0;await this.sell(p,`🏃 RUNNER TP1 REAL +${executable.pnlPct.toFixed(1)}% → bank ${config.runnerFirstSellPct}%`,price,executable,config.runnerFirstSellPct/100);if((p.realizedCostBasisUsd??0)>before){p.runnerProfitStage=1;this.saveState();}}
      else if(stage===1&&executable.pnlPct>=config.runnerSecondTakeProfitPct&&momentumStrong){const before=p.realizedCostBasisUsd??0;const frac=config.runnerSecondSellOriginalPct/(100-config.runnerFirstSellPct);await this.sell(p,`🚀 RUNNER TP2 REAL +${executable.pnlPct.toFixed(1)}% → bank another ${config.runnerSecondSellOriginalPct}% original; 20% moon bag remains`,price,executable,frac);if((p.realizedCostBasisUsd??0)>before){p.runnerProfitStage=2;this.saveState();}}
      else if(stage===2&&executable.pnlPct>=config.moonBagTakeProfitPct)await this.sell(p,`🌙 MOON BAG TARGET REAL +${executable.pnlPct.toFixed(1)}% → sell final 20%`,price,executable);
      else if(stage===0&&executable.pnlPct>=config.takeProfitPct&&!momentumStrong)await this.sell(p,`TAKE PROFIT REAL +${executable.pnlPct.toFixed(1)}% | runner momentum faded`,price,executable);
      else if(peakExecutable>=config.profitProtectArmPct&&executableDrawdown>=(stage===2?config.moonBagTrailingStopPct:config.trailingStopPct))await this.sell(p,`${stage===2?"🌙 MOON BAG PROTECT":"PROFIT PROTECT"} | REAL peak +${peakExecutable.toFixed(1)}% → +${executable.pnlPct.toFixed(1)}%`,price,executable);
      else if(ageMin>=config.maxPositionAgeMin&&!momentumStrong)await this.sell(p,`TIME EXIT ${ageMin.toFixed(1)}m | momentum weak | REAL ${executable.pnlPct>=0?"+":""}${executable.pnlPct.toFixed(1)}%`,price,executable);
      this.saveState();
    }catch(e){log.warn(`[POSITION ERROR] ${p.name}: ${e instanceof Error?e.message:String(e)}`);}}
  }
}
