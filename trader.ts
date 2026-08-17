import { Jupiter } from "./jupiter.ts";
import { config, LAMPORTS_PER_SOL, SOL_MINT } from "./config.ts";
import { Candidate, Position } from "./types.ts";
import { log } from "./log.ts";
import { choosePositionUsd } from "./sizing.ts";
import { WalletService } from "./wallet.ts";
import { Notifier } from "./notifier.ts";
import { DexScreener } from "./dexscreener.ts";
import { SolPriceService } from "./solPrice.ts";

export class Trader {
  readonly positions = new Map<string, Position>();
  private busy = new Set<string>();
  private lastStatusAt = 0;
  private lastIdleStatusAt = 0;
  private notifier = new Notifier();
  private dex = new DexScreener();
  private solPrice: SolPriceService;

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
          openedAt:Date.now(),highPriceUsd:entryPrice,scoreAtBuy:c.score,confidenceAtBuy:c.dataConfidence,paper:true
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
        signature:result.signature,scoreAtBuy:c.score,confidenceAtBuy:c.dataConfidence,paper:false
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

  private async sell(p: Position, reason: string, currentPrice?: number) {
    if (this.busy.has(p.mint)) return;
    this.busy.add(p.mint);
    try {
      if (p.paper) {
        const price = currentPrice ?? p.entryPriceUsd;
        const outUsd = p.entryUsd * (price / p.entryPriceUsd);
        const pnlPct = ((outUsd - p.entryUsd) / p.entryUsd) * 100;
        this.positions.delete(p.mint);
        log.info(`[SELL] ${p.name} ($${p.symbol}) | 💰 PAPER SOLD | ${reason} | value≈$${outUsd.toFixed(2)} | P/L ${pnlPct>=0?"+":""}${pnlPct.toFixed(1)}%`);
        void this.notifier.send({
          title: `💰 PAPER SOLD $${p.symbol}`,
          message: `${p.name} ($${p.symbol}) | ${reason} | Value $${outUsd.toFixed(2)} | P/L ${pnlPct>=0?"+":""}${pnlPct.toFixed(1)}%`,
          priority: "default", tags: [pnlPct >= 0 ? "moneybag" : "warning"]
        });
        return;
      }
      const bal = await this.wallet.tokenBalanceRaw(p.mint);
      const amount = bal.amount > 0n ? bal.amount : p.tokenAmountRaw;
      if (amount <= 0n) { this.positions.delete(p.mint); return; }
      const result = await this.jupiter.swap(p.mint, SOL_MINT, amount);
      const solOut = Number(result.outRaw) / LAMPORTS_PER_SOL;
      const solUsd = await this.solPrice.get();
      const outUsd = solOut * solUsd;
      const pnlPct = ((outUsd - p.entryUsd) / p.entryUsd) * 100;
      this.positions.delete(p.mint);
      log.info(`[SELL] ${p.name} ($${p.symbol}) | 💰 SOLD | ${reason} | received≈$${outUsd.toFixed(2)} | P/L ${pnlPct>=0?"+":""}${pnlPct.toFixed(1)}% | tx ${result.signature}`);
      void this.notifier.send({
        title: `💰 SOLD $${p.symbol}`,
        message: `${p.name} ($${p.symbol}) | ${reason} | Received $${outUsd.toFixed(2)} | P/L ${pnlPct>=0?"+":""}${pnlPct.toFixed(1)}%`,
        priority: "high", tags: [pnlPct >= 0 ? "moneybag" : "warning"]
      });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      log.error(`[SELL] ${p.name} ($${p.symbol}) | ⚠️ SELL FAILED | ${msg}`);
      void this.notifier.send({
        title: `⚠️ SELL FAILED $${p.symbol}`,
        message: `${p.name} ($${p.symbol}) | ${msg} | Contract ${p.mint}`,
        priority: "max", tags: ["warning"]
      });
    }
    finally { this.busy.delete(p.mint); }
  }

  private logCurrentTrade(p: Position, price: number, index: number, total: number) {
    const pnl = ((price-p.entryPriceUsd)/p.entryPriceUsd)*100;
    const peakPnl = ((p.highPriceUsd-p.entryPriceUsd)/p.entryPriceUsd)*100;
    const ageSec = Math.floor((Date.now()-p.openedAt)/1000);
    const mm = Math.floor(ageSec/60).toString().padStart(2,"0");
    const ss = (ageSec%60).toString().padStart(2,"0");
    const currentValue = p.entryUsd * (price/p.entryPriceUsd);
    const status = p.paper ? "🧪 PAPER HOLDING" : "🟢 HOLDING";
    const score = p.scoreAtBuy == null ? "?" : `${p.scoreAtBuy}/100`;
    log.info(`[CURRENT TRADE ${index}/${total}] ${status} | ${p.name} ($${p.symbol}) | Entry:$${p.entryPriceUsd.toPrecision(6)} | Current:$${price.toPrecision(6)} | Position:$${p.entryUsd.toFixed(2)} | Value≈$${currentValue.toFixed(2)} | P/L:${pnl>=0?"+":""}${pnl.toFixed(1)}% | Peak:${peakPnl>=0?"+":""}${peakPnl.toFixed(1)}% | Held:${mm}:${ss} | BuyScore:${score} | CA:${p.mint}`);
  }

  async monitorPositions() {
    const now = Date.now();
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
        const pnl = ((price-p.entryPriceUsd)/p.entryPriceUsd)*100;
        const drawdown = ((price-p.highPriceUsd)/p.highPriceUsd)*100;
        const ageMin = (Date.now()-p.openedAt)/60000;
        if (shouldLogStatus) this.logCurrentTrade(p, price, index, positions.length);
        if (pnl >= config.takeProfitPct) await this.sell(p, `TAKE PROFIT ${pnl.toFixed(1)}%`, price);
        else if (pnl <= -config.stopLossPct) await this.sell(p, `STOP LOSS ${pnl.toFixed(1)}%`, price);
        else if (pnl > 8 && drawdown <= -config.trailingStopPct) await this.sell(p, `TRAILING EXIT ${drawdown.toFixed(1)}% from high`, price);
        else if (ageMin >= config.maxPositionAgeMin) await this.sell(p, `TIME EXIT ${ageMin.toFixed(1)}m`, price);
      } catch (e) { log.warn(`[POSITION ERROR] ${p.name}: ${e instanceof Error ? e.message : String(e)}`); }
    }
  }
}
