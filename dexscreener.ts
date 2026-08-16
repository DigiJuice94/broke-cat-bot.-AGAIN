import { Snapshot } from "./types.ts";
import { config } from "./config.ts";
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

  private choosePair(pairs: any[]) {
    return pairs.sort((a, b) => (n(b?.liquidity?.usd) ?? 0) - (n(a?.liquidity?.usd) ?? 0))[0];
  }

  async batch(addresses: string[]): Promise<Map<string, Partial<Snapshot>>> {
    const out = new Map<string, Partial<Snapshot>>();
    const now = Date.now();
    const unique = [...new Set(addresses)].slice(0, 30);
    const missing: string[] = [];

    for (const address of unique) {
      const cached = this.cache.get(address);
      if (cached && now - cached.at < config.dexCacheMs) out.set(address, cached.value);
      else missing.push(address);
    }
    if (!missing.length) return out;

    try {
      // DEX Screener supports up to 30 comma-separated token addresses in one request.
      const url = `https://api.dexscreener.com/tokens/v1/solana/${missing.map(encodeURIComponent).join(",")}`;
      const raw = await getJson(url, {}, config.dexTimeoutMs);
      const pairs = Array.isArray(raw) ? raw : Array.isArray(raw?.pairs) ? raw.pairs : [];
      const grouped = new Map<string, any[]>();
      for (const p of pairs) {
        for (const address of [p?.baseToken?.address, p?.quoteToken?.address]) {
          if (!address || !missing.includes(address)) continue;
          const arr = grouped.get(address) ?? [];
          arr.push(p);
          grouped.set(address, arr);
        }
      }

      for (const address of missing) {
        const pair = this.choosePair(grouped.get(address) ?? []);
        if (!pair) continue;
        const value: Partial<Snapshot> = {
          priceUsd: n(pair.priceUsd),
          liquidityUsd: n(pair.liquidity?.usd),
          marketCapUsd: n(pair.marketCap, pair.fdv),
          volume5mUsd: n(pair.volume?.m5),
          buys5m: n(pair.txns?.m5?.buys),
          sells5m: n(pair.txns?.m5?.sells),
          priceChange5mPct: n(pair.priceChange?.m5),
          dexPairAddress: pair.pairAddress,
          dexId: pair.dexId,
        };
        this.cache.set(address, { at: now, value });
        out.set(address, value);
      }
    } catch (e) {
      log.warn(`[DEX] batch enrichment failed: ${e instanceof Error ? e.message : String(e)}`);
    }
    return out;
  }
}
