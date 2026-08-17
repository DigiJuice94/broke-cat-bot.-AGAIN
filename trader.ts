import { Jupiter } from "./jupiter.ts";
import { config, LAMPORTS_PER_SOL, SOL_MINT } from "./config.ts";
import { Candidate, Position } from "./types.ts";
import { log } from "./log.ts";
import { choosePositionUsd } from "./sizing.ts";
import { WalletService } from "./wallet.ts";
import { Notifier } from "./notifier.ts";
import { DexScreener } from "./dexscreener.ts";
import { SolPriceService } from "./solPrice.ts";
import { socialPerformance } from "./socialPerformance.ts";

type ClosedTrack={mint:string;name:string;symbol:string;entryPriceUsd:number;exitPriceUsd:number;exitPnlPct:number;closedAt:number;logged:Set<number>;socialAccounts:string[]};

type ExecutableExit = {
  amountRaw: bigint;
  outSol: number;
  outUsd: number;
  pnlPct: number;
  dexImpliedUsd: number;
  valueRatio: number;
};

export class Trader {
  readonly positions = new Map<string, Position>();
  private busy = new Set<string>();
  private lastStatusAt = 0;
  private lastIdleStatusAt = 0;
  private notifier = new Notifier();
  private dex = new DexScreener();
  private solPrice: SolPriceService;
  private closedTracks:ClosedTrack[]=[];

  constructor(private wallet: WalletService, private jupiter: Jupiter) {
    this.solPrice = new SolPriceService(this.dex, this.jupiter);
    this.solPrice.start();
  }

  async warmSolPrice() { await this.solPrice.warm(); }

  async buy(c: Candidate) {
    if (this.busy.has(c.token.address) || this.positions.has(c.token.address)) return;
    this.busy.add(c.token.address);
    try {
      const snap = c.snapshots.at(-1)!;
      const [solBalance, solUsd] = await Promise.all([this.wallet.solBalance(), this.solPrice.get()]);
      const spendableSol = Math.max(0, solBalance - config.solFeeReserve);
      const spendableUsd = spendableSol * solUsd;
      const usd = choosePositionUsd({
        score: c.score, confidence: c.dataConfidence, spendableUsd,
        routeQuality: snap.routeQuality ?? 50,
        multiTrend: c.sources.has("axiom") && c.sources.has("fomo")
      });
      if (usd < config.minPositionUsd) {
        c.state = "FAILED"; c.decisionReason = `NO BUY: spendable balance below $${config.minPositionUsd}`;
        log.scan({ name:c.token.name,symbol:c.token.symbol,priceUsd:snap.priceUsd,score:c.score,confidence:c.dataConfidence,status:"❌ NO BUY",reason:c.decisionReason });
        return;
      }
      const sol = Math.min(spendableSol, usd / solUsd);
      const lamports = BigInt(Math.floor(sol * LAMPORTS_PER_SOL));
      const entryPrice = snap.priceUsd;
      if (!entryPrice || entryPrice <= 0) throw new Error("entry price unavailable");

      if (!config.liveTrading) {
        this.positions.set(c.token.address, {
          mint:c.token.address,name:c.token.name,symbol:c.token.symbol,decimals:c.token.decimals || 6,
          tokenAmountRaw:0n,entrySolLamports:lamports,entryUsd:usd,entryPriceUsd:entryPrice,
          openedAt:Date.now(),highPriceUsd:entryPrice,scoreAtBuy:c.score,confidenceAtBuy:c.dataConfidence,paper:true,socialAccountsAtBuy:snap.social?.keyAccounts??[],metaRunnerAtBuy:c.metaRunner
        });
        c.state = "BOUGHT";
        log.scan({ name:c.token.name,symbol:c.token.symbol,priceUsd:snap.priceUsd,score:c.score,confidence:c.dataConfidence,status:"🧪 PAPER BUY",reason:`would buy $${usd.toFixed(2)} (${sol.toFixed(5)} SOL) | Contract:${c.token.address} | now tracking paper position` });
        void this.notifier.send({
          title: `🐱 PAPER BUY $${c.token.symbol}`,
          message: `${c.token.name} ($${c.token.symbol}) | $${usd.toFixed(2)} | Score ${c.score}/100 | Entry $${entryPrice.toPrecision(6)} | Contract ${c.token.address}`,
          priority: "default", tags: ["chart_with_upwards_trend"]
        });
        return;
      }

      const result = await this.jupiter.swap(SOL_MINT, c.token.address, lamports);
      const tokenInfo = await this.wallet.tokenBalanceRaw(c.token.address);
      const raw = tokenInfo.amount > 0n ? tokenInfo.amount : result.outRaw;
      const decimals = tokenInfo.decimals || c.token.decimals || 6;
      const actualEntryPrice = snap.priceUsd ?? (usd / (Number(raw) / 10 ** decimals));
      this.positions.set(c.token.address, {
        mint:c.token.address,name:c.token.name,symbol:c.token.symbol,decimals,tokenAmountRaw:raw,
        entrySolLamports:result.inRaw,entryUsd:usd,entryPriceUsd:actualEntryPrice,openedAt:Date.now(),highPriceUsd:actualEntryPrice,
        signature:result.signature,scoreAtBuy:c.score,confidenceAtBuy:c.dataConfidence,paper:false,socialAccountsAtBuy:snap.social?.keyAccounts??[],metaRunnerAtBuy:c.metaRunner
      });
      c.state = "BOUGHT";
      log.scan({ name:c.token.name,symbol:c.token.symbol,priceUsd:snap.priceUsd,score:c.score,confidence:c.dataConfidence,status:"🟢 BOUGHT",reason:`$${usd.toFixed(2)} | Contract:${c.token.address} | tx ${result.signature}` });
      void this.notifier.send({
        title: `🐱 BOUGHT $${c.token.symbol}`,
        message: `${c.token.name} ($${c.token.symbol}) | $${usd.toFixed(2)} | Score ${c.score}/100 | Entry $${actualEntryPrice.toPrecision(6)} | Contract ${c.token.address}`,
        priority: "high", tags: ["chart_with_upwards_trend"]
      });
    } catch (e) {
      c.state = "FAILED"; c.decisionReason = `BUY FAILED: ${e instanceof Error ? e.message : String(e)}`;
      log.error(`[BUY FAILED] ${c.token.name}`, c.decisionReason);
    } finally { this.busy.delete(c.token.address); }
  }

  /**
   * The chart price is not the exit price on a thin meme coin. This quotes the ENTIRE
   * wallet position through Jupiter and treats that value as the real P/L used by exits.
   */
  private async executableExit(p: Position, dexPrice: number): Promise<ExecutableExit | null> {
    if (p.paper) return null;
    const bal = await this.wallet.tokenBalanceRaw(p.mint);
    const amountRaw = bal.amount > 0n ? bal.amount : p.tokenAmountRaw;
    if (amountRaw <= 0n) return null;

    const [quote, solUsd] = await Promise.all([
      this.jupiter.sellQuoteSol(p.mint, amountRaw),
      this.solPrice.get()
    ]);
    const outUsd = quote.outSol * solUsd;
    const pnlPct = p.entryUsd > 0 ? ((outUsd - p.entryUsd) / p.entryUsd) * 100 : 0;
    const dexImpliedUsd = p.entryUsd * (dexPrice / p.entryPriceUsd);
    const valueRatio = dexImpliedUsd > 0 ? outUsd / dexImpliedUsd : 1;

    p.highExecutablePnlPct = Math.max(p.highExecutablePnlPct ?? pnlPct, pnlPct);
    p.lastExecutablePnlPct = pnlPct;
    p.lastExecutableUsd = outUsd;
    p.lastExecutableQuoteAt = Date.now();

    return { amountRaw, outSol: quote.outSol, outUsd, pnlPct, dexImpliedUsd, valueRatio };
  }

  private rememberExit(p:Position, price:number, pnlPct:number){
    this.closedTracks.push({mint:p.mint,name:p.name,symbol:p.symbol,entryPriceUsd:p.entryPriceUsd,exitPriceUsd:price,exitPnlPct:pnlPct,closedAt:Date.now(),logged:new Set(),socialAccounts:p.socialAccountsAtBuy??[]});
    this.closedTracks=this.closedTracks.filter(x=>Date.now()-x.closedAt<=65*60000);
  }

  private async trackClosedTrades(){
    if(!this.closedTracks.length)return; const due=this.closedTracks.filter(x=>[5,15,30,60].some(m=>Date.now()-x.closedAt>=m*60000&&!x.logged.has(m))); if(!due.length)return;
    const market=await this.dex.batch([...new Set(due.map(x=>x.mint))]);
    for(const x of due){const price=market.get(x.mint)?.priceUsd;if(!price)continue;for(const m of [5,15,30,60]){if(Date.now()-x.closedAt>=m*60000&&!x.logged.has(m)){x.logged.add(m);const fromEntry=((price-x.entryPriceUsd)/x.entryPriceUsd)*100;const afterExit=((price-x.exitPriceUsd)/x.exitPriceUsd)*100;const cls=x.exitPnlPct<0&&afterExit>20?"EARLY EXIT":x.exitPnlPct<0&&afterExit<0?"GOOD STOP":"FOLLOW-UP";if([15,30,60].includes(m)&&x.socialAccounts.length)socialPerformance.record(x.socialAccounts,fromEntry);log.info(`[EXIT REVIEW ${m}m] ${x.name} ($${x.symbol}) | exit P/L ${x.exitPnlPct>=0?"+":""}${x.exitPnlPct.toFixed(1)}% | now vs entry ${fromEntry>=0?"+":""}${fromEntry.toFixed(1)}% | since exit ${afterExit>=0?"+":""}${afterExit.toFixed(1)}% | ${cls}${x.socialAccounts.length?` | Social:${x.socialAccounts.join(",")}`:""}`);}}}
  }

  private async sell(p: Position, reason: string, currentPrice?: number, expected?: ExecutableExit | null) {
    if (this.busy.has(p.mint)) return;
    this.busy.add(p.mint);
    try {
      if (p.paper) {
        const price = currentPrice ?? p.entryPriceUsd;
        const outUsd = p.entryUsd * (price / p.entryPriceUsd);
        const pnlPct = ((outUsd - p.entryUsd) / p.entryUsd) * 100;
        this.positions.delete(p.mint);
        this.rememberExit(p,price,pnlPct);
        log.info(`[SELL] ${p.name} ($${p.symbol}) | 💰 PAPER SOLD | ${reason} | value≈$${outUsd.toFixed(2)} | P/L ${pnlPct>=0?"+":""}${pnlPct.toFixed(1)}%`);
        void this.notifier.send({
          title: `💰 PAPER SOLD $${p.symbol}`,
          message: `${p.name} ($${p.symbol}) | ${reason} | Value $${outUsd.toFixed(2)} | P/L ${pnlPct>=0?"+":""}${pnlPct.toFixed(1)}%`,
          priority: "default", tags: [pnlPct >= 0 ? "moneybag" : "warning"]
        });
        return;
      }

      // Re-read the actual wallet amount immediately before execution; never sell a stale stored amount.
      const before = await this.wallet.tokenBalanceRaw(p.mint);
      const amount = before.amount > 0n ? before.amount : (expected?.amountRaw ?? p.tokenAmountRaw);
      if (amount <= 0n) {
        log.warn(`[SELL] ${p.name} ($${p.symbol}) | token balance already zero; removing stale position`);
        this.positions.delete(p.mint);
        return;
      }

      const result = await this.jupiter.swap(p.mint, SOL_MINT, amount);
      const solOut = Number(result.outRaw) / LAMPORTS_PER_SOL;
      const solUsd = await this.solPrice.get();
      const outUsd = solOut * solUsd;
      const pnlPct = ((outUsd - p.entryUsd) / p.entryUsd) * 100;

      // Verify the token actually left the wallet before declaring SOLD.
      const after = await this.wallet.tokenBalanceRaw(p.mint);
      const soldRaw = before.amount > after.amount ? before.amount - after.amount : result.inRaw;
      const soldFraction = before.amount > 0n ? Number(soldRaw * 10_000n / before.amount) / 100 : 100;
      const effectivelyClosed = after.amount === 0n || soldFraction >= 99.5;

      if (effectivelyClosed) { this.positions.delete(p.mint); this.rememberExit(p,currentPrice??p.entryPriceUsd,pnlPct); }
      else {
        p.tokenAmountRaw = after.amount;
        log.warn(`[SELL] ${p.name} ($${p.symbol}) | ⚠️ PARTIAL EXIT ${soldFraction.toFixed(2)}% | ${reason} | remaining raw ${after.amount.toString()} | tx ${result.signature}`);
      }

      const rugLike = pnlPct <= -config.rugExitPct || (expected && expected.valueRatio < config.minExecutableValueRatio);
      const label = rugLike ? "🚨 RUG/LIQUIDITY EXIT" : "💰 SOLD";
      log.info(`[SELL] ${p.name} ($${p.symbol}) | ${label} | ${reason} | received≈$${outUsd.toFixed(2)} (${solOut.toFixed(6)} SOL) | REAL P/L ${pnlPct>=0?"+":""}${pnlPct.toFixed(1)}% | sold ${soldFraction.toFixed(2)}% | tx ${result.signature}`);
      void this.notifier.send({
        title: `${rugLike ? "🚨 RUG EXIT" : "💰 SOLD"} $${p.symbol}`,
        message: `${p.name} ($${p.symbol}) | ${reason} | Received $${outUsd.toFixed(2)} | REAL P/L ${pnlPct>=0?"+":""}${pnlPct.toFixed(1)}%`,
        priority: "max", tags: [pnlPct >= 0 ? "moneybag" : "warning"]
      });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      // Critical: a failed sell NEVER removes the position. It remains live for the next retry.
      log.error(`[SELL] ${p.name} ($${p.symbol}) | ⚠️ SELL FAILED — POSITION RETAINED | ${msg}`);
      void this.notifier.send({
        title: `⚠️ SELL FAILED $${p.symbol}`,
        message: `${p.name} ($${p.symbol}) | Position retained + will retry | ${msg} | Contract ${p.mint}`,
        priority: "max", tags: ["warning"]
      });
    }
    finally { this.busy.delete(p.mint); }
  }

  private logCurrentTrade(p: Position, price: number, index: number, total: number, executable?: ExecutableExit | null) {
    const chartPnl = ((price-p.entryPriceUsd)/p.entryPriceUsd)*100;
    const peakPnl = ((p.highPriceUsd-p.entryPriceUsd)/p.entryPriceUsd)*100;
    const ageSec = Math.floor((Date.now()-p.openedAt)/1000);
    const mm = Math.floor(ageSec/60).toString().padStart(2,"0");
    const ss = (ageSec%60).toString().padStart(2,"0");
    const chartValue = p.entryUsd * (price/p.entryPriceUsd);
    const status = p.paper ? "🧪 PAPER HOLDING" : "🟢 HOLDING";
    const score = p.scoreAtBuy == null ? "?" : `${p.scoreAtBuy}/100`;
    const real = executable
      ? ` | ExitNow:$${executable.outUsd.toFixed(2)} | REAL P/L:${executable.pnlPct>=0?"+":""}${executable.pnlPct.toFixed(1)}% | Exit/Dex:${(executable.valueRatio*100).toFixed(0)}%`
      : "";
    log.info(`[CURRENT TRADE ${index}/${total}] ${status} | ${p.name} ($${p.symbol}) | Entry:$${p.entryPriceUsd.toPrecision(6)} | Current:$${price.toPrecision(6)} | Position:$${p.entryUsd.toFixed(2)} | ChartValue≈$${chartValue.toFixed(2)} | Chart P/L:${chartPnl>=0?"+":""}${chartPnl.toFixed(1)}%${real} | Peak:${peakPnl>=0?"+":""}${peakPnl.toFixed(1)}% | Held:${mm}:${ss} | BuyScore:${score} | CA:${p.mint}`);
  }

  async monitorPositions() {
    const now = Date.now();
    await this.trackClosedTrades();
    const positions = [...this.positions.values()];
    if (!positions.length) {
      if (now-this.lastIdleStatusAt >= config.idlePositionStatusIntervalMs) {
        this.lastIdleStatusAt = now;
        log.info(`[OPEN POSITIONS] 0 | 💤 Waiting for runner`);
      }
      return;
    }

    const shouldLogStatus = now-this.lastStatusAt >= config.positionStatusIntervalMs;
    if (shouldLogStatus) this.lastStatusAt = now;

    const market = await this.dex.batch(positions.map(p=>p.mint));
    let index = 0;
    for (const p of positions) {
      index++;
      try {
        const s = market.get(p.mint);
        const price = s?.priceUsd;
        if (!price) continue;
        p.highPriceUsd = Math.max(p.highPriceUsd, price);
        const chartPnl = ((price-p.entryPriceUsd)/p.entryPriceUsd)*100;
        const chartDrawdown = ((price-p.highPriceUsd)/p.highPriceUsd)*100;
        const ageMin = (Date.now()-p.openedAt)/60000;
        const buys=s?.buys1m??s?.buys5m??0, sells=s?.sells1m??s?.sells5m??0;
        const momentumRatio=buys/Math.max(1,sells);
        const momentumPrice=s?.priceChange1mPct??s?.priceChange5mPct??0;
        const momentumStrong=momentumRatio>=config.strongMomentumBuySellRatio && momentumPrice>=config.strongMomentumMinPrice5mPct;

        if (p.paper) {
          if (shouldLogStatus) this.logCurrentTrade(p, price, index, positions.length);
          if (chartPnl >= config.takeProfitPct) await this.sell(p, `TAKE PROFIT ${chartPnl.toFixed(1)}%`, price);
          else if (chartPnl <= -config.hardStopLossPct) await this.sell(p, `HARD STOP ${chartPnl.toFixed(1)}%`, price);
          else if (chartPnl <= -config.softStopLossPct && !momentumStrong) await this.sell(p, `MOMENTUM STOP ${chartPnl.toFixed(1)}% | B/S ${momentumRatio.toFixed(2)}x`, price);
          else if (chartPnl >= config.profitProtectArmPct && chartDrawdown <= -config.trailingStopPct) await this.sell(p, `PROFIT PROTECT ${chartDrawdown.toFixed(1)}% from high`, price);
          else if (ageMin >= config.maxPositionAgeMin) await this.sell(p, `TIME EXIT ${ageMin.toFixed(1)}m`, price);
          continue;
        }

        // LIVE positions: Jupiter's full-position sell quote is the source of truth for exit P/L.
        const previousExecutableUsd = p.lastExecutableUsd;
        const executable = await this.executableExit(p, price);
        if (!executable) {
          if (shouldLogStatus) this.logCurrentTrade(p, price, index, positions.length, null);
          continue;
        }

        const peakExecutable = p.highExecutablePnlPct ?? executable.pnlPct;
        const executableDrawdown = peakExecutable - executable.pnlPct;
        const quoteDropPct = previousExecutableUsd && previousExecutableUsd > 0
          ? ((previousExecutableUsd - executable.outUsd) / previousExecutableUsd) * 100
          : 0;
        if (shouldLogStatus) this.logCurrentTrade(p, price, index, positions.length, executable);

        // 1) The route has detached from the chart: treat this as a rug/liquidity emergency.
        if (executable.valueRatio < config.minExecutableValueRatio) {
          await this.sell(p, `LIQUIDITY COLLAPSE | executable ${(executable.valueRatio*100).toFixed(0)}% of chart value | chart ${chartPnl>=0?"+":""}${chartPnl.toFixed(1)}% vs REAL ${executable.pnlPct>=0?"+":""}${executable.pnlPct.toFixed(1)}%`, price, executable);
        }
        // 2) A very fast drop in actual sellable value gets out before the normal stop catches up.
        else if (quoteDropPct >= config.executableQuoteDropPct) {
          await this.sell(p, `FAST EXIT | executable value dropped ${quoteDropPct.toFixed(1)}% since last poll | REAL ${executable.pnlPct>=0?"+":""}${executable.pnlPct.toFixed(1)}%`, price, executable);
        }
        // 3) Take profit earlier, using what Jupiter can actually return—not the displayed token price.
        else if (executable.pnlPct >= config.takeProfitPct) {
          await this.sell(p, `TAKE PROFIT REAL +${executable.pnlPct.toFixed(1)}%`, price, executable);
        }
        // 4) Cut losers earlier on executable value.
        else if (executable.pnlPct <= -config.hardStopLossPct) {
          const rug = executable.pnlPct <= -config.rugExitPct ? "RUG/LIQUIDITY " : "";
          await this.sell(p, `${rug}HARD STOP REAL ${executable.pnlPct.toFixed(1)}%`, price, executable);
        }
        else if (executable.pnlPct <= -config.softStopLossPct && !momentumStrong) {
          await this.sell(p, `MOMENTUM STOP REAL ${executable.pnlPct.toFixed(1)}% | B/S ${momentumRatio.toFixed(2)}x | price momentum ${momentumPrice.toFixed(1)}%`, price, executable);
        }
        // 5) Once +15% real profit exists, allow only an 8-point giveback from the executable peak.
        else if (peakExecutable >= config.profitProtectArmPct && executableDrawdown >= config.trailingStopPct) {
          await this.sell(p, `PROFIT PROTECT | REAL peak +${peakExecutable.toFixed(1)}% → +${executable.pnlPct.toFixed(1)}%`, price, executable);
        }
        else if (ageMin >= config.maxPositionAgeMin) {
          await this.sell(p, `TIME EXIT ${ageMin.toFixed(1)}m | REAL ${executable.pnlPct>=0?"+":""}${executable.pnlPct.toFixed(1)}%`, price, executable);
        }
      } catch (e) { log.warn(`[POSITION ERROR] ${p.name}: ${e instanceof Error ? e.message : String(e)}`); }
    }
  }
}
