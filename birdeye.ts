import { config, SOL_MINT } from "./config.ts";
import { DiscoveredToken, Snapshot, SmartMoneySnapshot } from "./types.ts";
import { getJson } from "./http.ts";
import { RequestQueue } from "./requestQueue.ts";

const BASE = "https://public-api.birdeye.so";
const headers = () => ({ "X-API-KEY": config.birdeyeApiKey, "x-chain": "solana", accept: "application/json" });

interface CacheEntry { at: number; value: Partial<Snapshot> }
interface HolderCacheEntry { at:number; value: Partial<Snapshot> }

function arr(v: any): any[] {
  if (Array.isArray(v)) return v;
  for (const k of ["tokens", "items", "list", "data"]) if (Array.isArray(v?.[k])) return v[k];
  return [];
}
function n(...xs: any[]): number | undefined {
  for (const x of xs) {
    if (x === null || x === undefined || x === "") continue;
    const v = Number(x);
    if (Number.isFinite(v)) return v;
  }
  return undefined;
}
function tokenFrom(x: any, source: DiscoveredToken["source"], rank?: number): DiscoveredToken | null {
  const address = x.address ?? x.tokenAddress ?? x.mint ?? x.token_address;
  if (!address || address === SOL_MINT) return null;
  return {
    address, name: x.name ?? x.tokenName ?? "Unknown", symbol: x.symbol ?? x.tokenSymbol ?? "?",
    decimals: n(x.decimals), source, rank, discoveredAt: Date.now(),
    listedAt: n(x.creationTime, x.creation_time, x.listingUnixTime, x.listingTime, x.recent_listing_time),
    seed: {
      priceUsd: n(x.price, x.priceUsd, x.price_usd), liquidityUsd: n(x.liquidity, x.liquidityUsd, x.liquidity_usd),
      marketCapUsd: n(x.marketCap, x.market_cap, x.mc), volume1mUsd: n(x.v1mUSD, x.volume1mUSD, x.volume_1m_usd),
      volume5mUsd: n(x.v5mUSD, x.volume5mUSD, x.volume_5m_usd), buys1m: n(x.buy1m, x.buy_1m, x.buys1m),
      sells1m: n(x.sell1m, x.sell_1m, x.sells1m), priceChange1mPct: n(x.priceChange1mPercent, x.price_change_1m_percent, x.priceChange1m)
    }
  };
}
function errText(e: unknown): string {
  return (e instanceof Error ? e.message : String(e)).replace(/\s+/g, " ").slice(0, 220);
}

export class Birdeye {
  private queue = new RequestQueue("Birdeye", config.birdeyeMinIntervalMs, 2);
  private cache = new Map<string, CacheEntry>();
  private holderCache = new Map<string, HolderCacheEntry>();
  private cuCooldownUntil = 0;
  private cuWindowStartedAt = Date.now();
  private cuUsedThisHour = 0;
  private warnedCooldown = false;

  isCuAvailable() { return Date.now() >= this.cuCooldownUntil; }
  private refreshCuWindow() {
    if (Date.now() - this.cuWindowStartedAt >= 3_600_000) {
      this.cuWindowStartedAt = Date.now();
      this.cuUsedThisHour = 0;
    }
  }
  private canSpend(cost:number) {
    this.refreshCuWindow();
    return this.cuUsedThisHour + cost <= config.birdeyeCuBudgetPerHour;
  }
  private remainingBudget() {
    this.refreshCuWindow();
    return Math.max(0, config.birdeyeCuBudgetPerHour - this.cuUsedThisHour);
  }
  budgetText() { return `${this.cuUsedThisHour}/${config.birdeyeCuBudgetPerHour} CU/hr`; }
  private get(url: string, timeout = 8_000, cuCost = 20) {
    if (!this.isCuAvailable()) throw new Error(`Birdeye CU cooldown active until ${new Date(this.cuCooldownUntil).toISOString()}`);
    if (!this.canSpend(cuCost)) throw new Error(`Birdeye local CU budget reached (${this.budgetText()})`);
    this.cuUsedThisHour += cuCost;
    return this.queue.schedule(async () => {
      try { return await getJson(url, headers(), timeout); }
      catch (e) {
        const msg = errText(e).toLowerCase();
        if (msg.includes("compute units usage limit exceeded") || msg.includes("credit") && msg.includes("exceed")) {
          this.cuCooldownUntil = Date.now() + config.birdeyeCuCooldownMs;
          if (!this.warnedCooldown) {
            this.warnedCooldown = true;
            console.warn(`[BIRDEYE CU] quota unavailable — pausing Birdeye for ${Math.round(config.birdeyeCuCooldownMs/3600000)}h; DEX Screener remains active`);
          }
        }
        throw e;
      }
    });
  }

  async newListings(): Promise<DiscoveredToken[]> {
    if (!config.birdeyeApiKey) return [];
    const j = await this.get(`${BASE}/defi/v2/tokens/new_listing?limit=20&meme_platform_enabled=true`, 8_000, 30);
    return arr(j?.data ?? j).map((x, i) => tokenFrom(x, "birdeye-new", i + 1)).filter(Boolean) as DiscoveredToken[];
  }
  async trending(): Promise<DiscoveredToken[]> {
    if (!config.birdeyeApiKey) return [];
    const j = await this.get(`${BASE}/defi/token_trending?sort_by=rank&sort_type=asc&offset=0&limit=20`, 8_000, 40);
    return arr(j?.data ?? j).map((x, i) => tokenFrom(x, "birdeye-trending", n(x.rank, i + 1))).filter(Boolean) as DiscoveredToken[];
  }
  async memeMomentum(): Promise<DiscoveredToken[]> {
    if (!config.birdeyeApiKey) return [];
    const q = new URLSearchParams({ sort_by: "volume_1m_usd", sort_type: "desc", source: "all", offset: "0", limit: "20" });
    const j = await this.get(`${BASE}/defi/v3/token/meme/list?${q}`, 8_000, 50);
    return arr(j?.data ?? j).map((x, i) => tokenFrom(x, "birdeye-meme", i + 1)).filter(Boolean) as DiscoveredToken[];
  }

  async snapshot(address: string, seed?: Partial<Snapshot>): Promise<Partial<Snapshot>> {
    if (!config.birdeyeApiKey) return { ...seed, dataErrors: ["Birdeye key missing"] };
    if (!this.isCuAvailable()) return { ...seed, dataErrors: ["Birdeye CU cooldown"] };
    const cached = this.cache.get(address);
    if (cached && Date.now() - cached.at < config.birdeyeSnapshotCacheMs) return { ...seed, ...cached.value };

    const errors: string[] = [];
    let o: any = {};
    try {
      const j = await this.get(`${BASE}/defi/token_overview?address=${encodeURIComponent(address)}&frames=1m,5m`, 9_000, 20);
      o = j?.data ?? j ?? {};
    } catch (e) { errors.push(`overview: ${errText(e)}`); }

    let priceFallback: any = {};
    if (n(o.price, seed?.priceUsd) == null) {
      try {
        const j = await this.get(`${BASE}/defi/price?address=${encodeURIComponent(address)}&include_liquidity=true`, 7_000, 10);
        priceFallback = j?.data ?? j ?? {};
      } catch (e) { errors.push(`price: ${errText(e)}`); }
    }

    const value: Partial<Snapshot> = {
      priceUsd: n(o.price, priceFallback.value, priceFallback.price, seed?.priceUsd),
      liquidityUsd: n(o.liquidity, priceFallback.liquidity, seed?.liquidityUsd),
      marketCapUsd: n(o.marketCap, o.market_cap, o.mc, seed?.marketCapUsd),
      holderCount: n(o.holder, o.holderCount, o.holders, seed?.holderCount),
      volume1mUsd: n(o.v1mUSD, o.volume1mUSD, o.volume_1m_usd, seed?.volume1mUsd),
      volume5mUsd: n(o.v5mUSD, o.volume5mUSD, o.volume_5m_usd, seed?.volume5mUsd),
      buys1m: n(o.buy1m, o.buy_1m, o.buys1m, seed?.buys1m), sells1m: n(o.sell1m, o.sell_1m, o.sells1m, seed?.sells1m),
      trades1m: n(o.trade1m, o.trade_1m, o.trades1m, seed?.trades1m),
      priceChange1mPct: n(o.priceChange1mPercent, o.price_change_1m_percent, o.priceChange1m, seed?.priceChange1mPct),
      uniqueWallet1m: n(o.uniqueWallet1m, o.unique_wallet_1m, seed?.uniqueWallet1m),
      buyVolume1mUsd: n(o.vBuy1mUSD, o.buyVolume1mUSD, o.buy_volume_1m_usd, seed?.buyVolume1mUsd),
      sellVolume1mUsd: n(o.vSell1mUSD, o.sellVolume1mUSD, o.sell_volume_1m_usd, seed?.sellVolume1mUsd),
      dataErrors: errors
    };
    this.cache.set(address, { at: Date.now(), value });
    return { ...seed, ...value };
  }

  /** Expensive risk check reserved for near-buy finalists only. */
  async holderStats(address:string): Promise<Partial<Snapshot>> {
    if (!config.birdeyeApiKey || !this.isCuAvailable() || !this.canSpend(35)) return {};
    const cached = this.holderCache.get(address);
    if (cached && Date.now()-cached.at < config.birdeyeHolderCacheMs) return cached.value;
    try {
      const j = await this.get(`${BASE}/defi/v3/token/holder?address=${encodeURIComponent(address)}&offset=0&limit=10&mode=wallet&get_holder_infos=false`, 9_000, 35);
      const d = j?.data ?? j ?? {};
      const value:Partial<Snapshot> = {
        holderCount: n(d.holder, d.holderCount, d.holders),
        top10HolderPct: n(d.top10HoldPercent, d.top10HolderPercent, d.top10_holder_percent)
      };
      this.holderCache.set(address,{at:Date.now(),value});
      return value;
    } catch { return {}; }
  }

  async topTraderIntel(address:string): Promise<SmartMoneySnapshot> {
    const empty:SmartMoneySnapshot={checked:false,smartTraders:0,snipers:0,insiders:0,bundlers:0,devs:0,score:0};
    if(!config.birdeyeApiKey || !this.isCuAvailable() || !this.canSpend(35)) return empty;
    try {
      const q=new URLSearchParams({address,time_frame:"24h",sort_type:"desc",sort_by:"volume",offset:"0",limit:"10",wallet_tags:"smart_trader,sniper,insider,bundler,dev"});
      const j:any=await this.get(`${BASE}/defi/v2/tokens/top_traders?${q}`,9_000,35);
      const rows=arr(j?.data??j); let smart=0,sniper=0,insider=0,bundler=0,dev=0;
      for(const x of rows){const raw=x.walletTags??x.wallet_tags??x.tags??[];const tags=(Array.isArray(raw)?raw:String(raw).split(",")).map((z:any)=>String(z).toLowerCase());
        if(tags.some((z:string)=>z.includes("smart_trader")||z==="smart"))smart++;if(tags.some((z:string)=>z.includes("sniper")))sniper++;if(tags.some((z:string)=>z.includes("insider")))insider++;if(tags.some((z:string)=>z.includes("bundler")))bundler++;if(tags.some((z:string)=>z==="dev"||z.includes("developer")))dev++;}
      const score=Math.max(0,Math.min(100,smart*18+Math.min(20,rows.length*2)-sniper*6-insider*12-bundler*8-dev*10));
      return {checked:true,smartTraders:smart,snipers:sniper,insiders:insider,bundlers:bundler,devs:dev,score};
    } catch { return empty; }
  }

  async solPriceUsd(): Promise<number> {
    const j = await this.get(`${BASE}/defi/price?address=${SOL_MINT}`);
    const d = j?.data ?? j;
    const price = n(d?.value, d?.price, d?.priceUsd);
    if (!price) throw new Error("Could not read SOL price from Birdeye");
    return price;
  }
}
