import { DiscoveredToken, Snapshot } from "./types.ts";
import { config, SOL_MINT } from "./config.ts";
import { getJson } from "./http.ts";
import { log } from "./log.ts";

interface CacheEntry { at: number; value: Partial<Snapshot> }

const n = (...xs: unknown[]): number | undefined => {
  for (const x of xs) {
    if (x === null || x === undefined || x === "") continue;
    const v = Number(x);
    if (Number.isFinite(v)) return v;
  }
  return undefined;
};

export class DexScreener {
  private cache = new Map<string, CacheEntry>();
  private solUsdCache?: { at:number; value:number };

  private choosePair(pairs: any[], address?: string) {
    const relevant = address ? pairs.filter(p => p?.baseToken?.address === address || p?.quoteToken?.address === address) : pairs;
    return relevant.sort((a, b) => (n(b?.liquidity?.usd) ?? 0) - (n(a?.liquidity?.usd) ?? 0))[0];
  }

  /**
   * Always-on, no-key discovery. DEX Screener's latest profiles/boost feeds are
   * intentionally used as attention signals, not automatic buy signals.
   */
  async discover(): Promise<DiscoveredToken[]> {
    const feeds: Array<{url:string; source:DiscoveredToken["source"]}> = [
      { url:"https://api.dexscreener.com/token-profiles/latest/v1", source:"dex-profile" },
      { url:"https://api.dexscreener.com/token-boosts/latest/v1", source:"dex-boost" },
      { url:"https://api.dexscreener.com/token-boosts/top/v1", source:"dex-boost-top" },
    ];
    const settled = await Promise.allSettled(feeds.map(f => getJson(f.url, {}, config.dexTimeoutMs)));
    const seen = new Set<string>();
    const tokens: DiscoveredToken[] = [];
    for (let fi=0; fi<settled.length; fi++) {
      const r = settled[fi]; if (r.status !== "fulfilled") continue;
      const rows = Array.isArray(r.value) ? r.value : [];
      let rank = 0;
      for (const row of rows) {
        if (row?.chainId !== "solana") continue;
        const address = row?.tokenAddress; if (!address || address === SOL_MINT || seen.has(address)) continue;
        seen.add(address); rank++;
        tokens.push({ address, name:"Unknown", symbol:"?", source:feeds[fi].source, rank, discoveredAt:Date.now() });
        if (tokens.length >= 30) break;
      }
      if (tokens.length >= 30) break;
    }

    // Hydrate names/symbols and market seed in one DEX batch call.
    if (tokens.length) {
      const enriched = await this.batch(tokens.map(t=>t.address));
      for (const t of tokens) {
        const e = enriched.get(t.address) as any;
        if (!e) continue;
        if (e.tokenName) t.name = e.tokenName;
        if (e.tokenSymbol) t.symbol = e.tokenSymbol;
        t.seed = e;
      }
    }
    return tokens;
  }

  async batch(addresses: string[]): Promise<Map<string, Partial<Snapshot> & {tokenName?:string;tokenSymbol?:string}>> {
    const out = new Map<string, Partial<Snapshot> & {tokenName?:string;tokenSymbol?:string}>();
    const now = Date.now();
    const unique = [...new Set(addresses)].slice(0, 30);
    const missing: string[] = [];

    for (const address of unique) {
      const cached = this.cache.get(address);
      if (cached && now - cached.at < config.dexCacheMs) out.set(address, cached.value as any);
      else missing.push(address);
    }
    if (!missing.length) return out;

    try {
      const url = `https://api.dexscreener.com/tokens/v1/solana/${missing.map(encodeURIComponent).join(",")}`;
      const raw = await getJson(url, {}, config.dexTimeoutMs);
      const pairs = Array.isArray(raw) ? raw : Array.isArray(raw?.pairs) ? raw.pairs : [];
      const grouped = new Map<string, any[]>();
      for (const p of pairs) {
        for (const address of [p?.baseToken?.address, p?.quoteToken?.address]) {
          if (!address || !missing.includes(address)) continue;
          const a = grouped.get(address) ?? []; a.push(p); grouped.set(address, a);
        }
      }

      for (const address of missing) {
        const pair = this.choosePair(grouped.get(address) ?? [], address);
        if (!pair) continue;
        const token = pair?.baseToken?.address === address ? pair.baseToken : pair?.quoteToken?.address === address ? pair.quoteToken : undefined;
        // priceUsd describes the base token. For discovered candidates we normally
        // expect the candidate as base. Avoid assigning the wrong price if it is quote.
        const priceUsd = pair?.baseToken?.address === address ? n(pair.priceUsd) : undefined;
        const value: Partial<Snapshot> & {tokenName?:string;tokenSymbol?:string} = {
          priceUsd,
          liquidityUsd: n(pair.liquidity?.usd),
          marketCapUsd: pair?.baseToken?.address === address ? n(pair.marketCap, pair.fdv) : undefined,
          volume5mUsd: n(pair.volume?.m5),
          buys5m: n(pair.txns?.m5?.buys),
          sells5m: n(pair.txns?.m5?.sells),
          priceChange5mPct: pair?.baseToken?.address === address ? n(pair.priceChange?.m5) : undefined,
          dexPairAddress: pair.pairAddress,
          dexId: pair.dexId,
          tokenName: token?.name,
          tokenSymbol: token?.symbol,
        } as any;
        this.cache.set(address, { at: now, value });
        out.set(address, value);
      }
    } catch (e) {
      log.warn(`[DEX] batch enrichment failed: ${e instanceof Error ? e.message : String(e)}`);
    }
    return out;
  }

  /** Free SOL/USD fallback so position sizing/exits do not consume Birdeye CUs. */
  async solPriceUsd(): Promise<number> {
    if (this.solUsdCache && Date.now()-this.solUsdCache.at < 60_000) return this.solUsdCache.value;
    const raw = await getJson("https://api.dexscreener.com/latest/dex/search?q=SOL%2FUSDC", {}, config.dexTimeoutMs);
    const pairs = Array.isArray(raw?.pairs) ? raw.pairs : [];
    const candidates = pairs.filter((p:any)=>p?.chainId==="solana" && p?.baseToken?.address===SOL_MINT && n(p?.priceUsd));
    const pair = this.choosePair(candidates);
    const price = n(pair?.priceUsd);
    if (!price) throw new Error("Could not read SOL/USD from DEX Screener");
    this.solUsdCache={at:Date.now(),value:price};
    return price;
  }
}
