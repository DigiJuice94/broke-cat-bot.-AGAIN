import { config } from "./config.ts";
import { DexScreener } from "./dexscreener.ts";
import { Jupiter } from "./jupiter.ts";
import { getJson } from "./http.ts";
import { log } from "./log.ts";

type SolPriceSource = "Coinbase" | "DEX Screener" | "Jupiter";

export class SolPriceService {
  private cached?: { at:number; value:number; source:SolPriceSource };
  private timer?: NodeJS.Timeout;
  private refreshing?: Promise<number>;

  constructor(private dex:DexScreener, private jupiter:Jupiter) {}

  private async coinbasePrice(): Promise<number> {
    const raw = await getJson("https://api.coinbase.com/v2/exchange-rates?currency=SOL", {}, config.solUsdTimeoutMs);
    const value = Number(raw?.data?.rates?.USD);
    if (!Number.isFinite(value) || value <= 0) throw new Error("Coinbase SOL/USD unavailable");
    return value;
  }

  private remember(value:number, source:SolPriceSource) {
    this.cached = { at:Date.now(), value, source };
    return value;
  }

  private async refreshNow(): Promise<number> {
    if (this.refreshing) return this.refreshing;
    this.refreshing = (async () => {
      let coinbaseErr = "";
      let dexErr = "";
      let jupiterErr = "";
      try {
        const value = await this.coinbasePrice();
        const prior = this.cached;
        this.remember(value, "Coinbase");
        if (!prior || Date.now()-prior.at >= config.solUsdLogIntervalMs || prior.source !== "Coinbase") {
          log.info(`[SOL PRICE] $${value.toFixed(2)} | Coinbase | cache refreshed`);
        }
        return value;
      } catch (e) { coinbaseErr = e instanceof Error ? e.message : String(e); }

      try {
        const value = await this.dex.solPriceUsd();
        this.remember(value, "DEX Screener");
        log.warn(`[SOL PRICE] Coinbase unavailable; using DEX Screener $${value.toFixed(2)}`);
        return value;
      } catch (e) { dexErr = e instanceof Error ? e.message : String(e); }

      // Jupiter is intentionally LAST so route-rate limits don't block sizing.
      try {
        const value = await this.jupiter.solPriceUsd();
        this.remember(value, "Jupiter");
        log.warn(`[SOL PRICE] Coinbase/DEX unavailable; emergency Jupiter fallback $${value.toFixed(2)}`);
        return value;
      } catch (e) { jupiterErr = e instanceof Error ? e.message : String(e); }

      if (this.cached && Date.now()-this.cached.at <= config.solUsdStaleMs) {
        log.warn(`[SOL PRICE] live sources unavailable; using cached ${this.cached.source} $${this.cached.value.toFixed(2)} age=${Math.round((Date.now()-this.cached.at)/1000)}s`);
        return this.cached.value;
      }
      throw new Error(`SOL/USD unavailable (Coinbase: ${coinbaseErr}; DEX: ${dexErr}; Jupiter: ${jupiterErr})`);
    })().finally(() => { this.refreshing = undefined; });
    return this.refreshing;
  }

  async get(): Promise<number> {
    if (this.cached && Date.now()-this.cached.at <= config.solUsdCacheMs) return this.cached.value;
    return this.refreshNow();
  }

  async warm(): Promise<void> {
    try { await this.refreshNow(); }
    catch (e) { log.warn(`[SOL PRICE] warmup failed: ${e instanceof Error ? e.message : String(e)}`); }
  }

  start() {
    if (this.timer) return;
    void this.warm();
    this.timer = setInterval(() => { void this.warm(); }, config.solUsdRefreshMs);
    this.timer.unref?.();
  }
}
