import { Birdeye } from "../birdeye.js";
import { Jupiter } from "../jupiter.js";
import { config, LAMPORTS_PER_SOL, SOL_MINT } from "./config.js";
import { Candidate, Position } from "./types.js";
import { log } from "../log.js";
import { choosePositionUsd } from "./sizing.js";
import { WalletService } from "../wallet.js";

export class Trader {
  readonly positions = new Map<string, Position>();
  private busy = new Set<string>();

  constructor(private wallet: WalletService, private birdeye: Birdeye, private jupiter: Jupiter) {}

  async buy(c: Candidate) {
    if (this.busy.has(c.token.address) || this.positions.has(c.token.address)) return;
    this.busy.add(c.token.address);
    try {
      const snap = c.snapshots.at(-1)!;
      const [solBalance, solUsd] = await Promise.all([this.wallet.solBalance(), this.birdeye.solPriceUsd()]);
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
      if (!config.liveTrading) {
        c.state = "BOUGHT";
        log.scan({ name:c.token.name,symbol:c.token.symbol,priceUsd:snap.priceUsd,score:c.score,confidence:c.dataConfidence,status:"🧪 PAPER BUY",reason:`would buy $${usd.toFixed(2)} (${sol.toFixed(5)} SOL)` });
        return;
      }
      const result = await this.jupiter.swap(SOL_MINT, c.token.address, lamports);
      const tokenInfo = await this.wallet.tokenBalanceRaw(c.token.address);
      const raw = tokenInfo.amount > 0n ? tokenInfo.amount : result.outRaw;
      const decimals = tokenInfo.decimals || c.token.decimals || 6;
      const entryPrice = snap.priceUsd ?? (usd / (Number(raw) / 10 ** decimals));
      this.positions.set(c.token.address, {
        mint:c.token.address,name:c.token.name,symbol:c.token.symbol,decimals,tokenAmountRaw:raw,
        entrySolLamports:result.inRaw,entryUsd:usd,entryPriceUsd:entryPrice,openedAt:Date.now(),highPriceUsd:entryPrice,
        signature:result.signature
      });
      c.state = "BOUGHT";
      log.scan({ name:c.token.name,symbol:c.token.symbol,priceUsd:snap.priceUsd,score:c.score,confidence:c.dataConfidence,status:"✅ BOUGHT",reason:`$${usd.toFixed(2)} | tx ${result.signature}` });
    } catch (e) {
      c.state = "FAILED"; c.decisionReason = `BUY FAILED: ${e instanceof Error ? e.message : String(e)}`;
      log.error(`[BUY FAILED] ${c.token.name}`, c.decisionReason);
    } finally { this.busy.delete(c.token.address); }
  }

  private async sell(p: Position, reason: string) {
    if (this.busy.has(p.mint)) return;
    this.busy.add(p.mint);
    try {
      const bal = await this.wallet.tokenBalanceRaw(p.mint);
      const amount = bal.amount > 0n ? bal.amount : p.tokenAmountRaw;
      if (amount <= 0n) { this.positions.delete(p.mint); return; }
      const result = await this.jupiter.swap(p.mint, SOL_MINT, amount);
      const solOut = Number(result.outRaw) / LAMPORTS_PER_SOL;
      const solUsd = await this.birdeye.solPriceUsd();
      const outUsd = solOut * solUsd;
      const pnlPct = ((outUsd - p.entryUsd) / p.entryUsd) * 100;
      this.positions.delete(p.mint);
      log.info(`[SELL] ${p.name} ($${p.symbol}) | ${reason} | received≈$${outUsd.toFixed(2)} | P/L ${pnlPct.toFixed(1)}% | tx ${result.signature}`);
    } catch (e) { log.error(`[SELL FAILED] ${p.name}: ${e instanceof Error ? e.message : String(e)}`); }
    finally { this.busy.delete(p.mint); }
  }

  async monitorPositions() {
    if (!config.liveTrading) return;
    for (const p of [...this.positions.values()]) {
      try {
        const s = await this.birdeye.snapshot(p.mint);
        const price = s.priceUsd;
        if (!price) continue;
        p.highPriceUsd = Math.max(p.highPriceUsd, price);
        const pnl = ((price-p.entryPriceUsd)/p.entryPriceUsd)*100;
        const drawdown = ((price-p.highPriceUsd)/p.highPriceUsd)*100;
        const ageMin = (Date.now()-p.openedAt)/60000;
        log.info(`[POSITION] ${p.name} ($${p.symbol}) | Price:$${price.toPrecision(5)} | P/L:${pnl.toFixed(1)}% | High:$${p.highPriceUsd.toPrecision(5)} | Age:${ageMin.toFixed(1)}m`);
        if (pnl >= config.takeProfitPct) await this.sell(p, `TAKE PROFIT ${pnl.toFixed(1)}%`);
        else if (pnl <= -config.stopLossPct) await this.sell(p, `STOP LOSS ${pnl.toFixed(1)}%`);
        else if (pnl > 8 && drawdown <= -config.trailingStopPct) await this.sell(p, `TRAILING EXIT ${drawdown.toFixed(1)}% from high`);
        else if (ageMin >= config.maxPositionAgeMin) await this.sell(p, `TIME EXIT ${ageMin.toFixed(1)}m`);
      } catch (e) { log.warn(`[POSITION ERROR] ${p.name}: ${e instanceof Error ? e.message : String(e)}`); }
    }
  }
}
