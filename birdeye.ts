import { config, SOL_MINT } from "./config.ts";
import { DiscoveredToken, Snapshot } from "./types.ts";
import { getJson } from "./http.ts";

const BASE = "https://public-api.birdeye.so";
const headers = () => ({ "X-API-KEY": config.birdeyeApiKey, "x-chain": "solana", accept: "application/json" });

function arr(v: any): any[] {
  if (Array.isArray(v)) return v;
  for (const k of ["tokens", "items", "list", "data"]) if (Array.isArray(v?.[k])) return v[k];
  return [];
}
function n(...xs: any[]): number | undefined {
  for (const x of xs) { const v = Number(x); if (Number.isFinite(v)) return v; }
}
function tokenFrom(x: any, source: DiscoveredToken["source"], rank?: number): DiscoveredToken | null {
  const address = x.address ?? x.tokenAddress ?? x.mint ?? x.token_address;
  if (!address || address === SOL_MINT) return null;
  return {
    address,
    name: x.name ?? x.tokenName ?? "Unknown",
    symbol: x.symbol ?? x.tokenSymbol ?? "?",
    decimals: n(x.decimals),
    source,
    rank,
    discoveredAt: Date.now(),
    listedAt: n(x.creationTime, x.creation_time, x.listingUnixTime, x.listingTime, x.recent_listing_time)?.valueOf()
  };
}

export class Birdeye {
  async newListings(): Promise<DiscoveredToken[]> {
    if (!config.birdeyeApiKey) return [];
    const j = await getJson(`${BASE}/defi/v2/tokens/new_listing?limit=20&meme_platform_enabled=true`, headers());
    return arr(j?.data ?? j).map((x, i) => tokenFrom(x, "birdeye-new", i)).filter(Boolean) as DiscoveredToken[];
  }

  async trending(): Promise<DiscoveredToken[]> {
    if (!config.birdeyeApiKey) return [];
    const j = await getJson(`${BASE}/defi/token_trending?sort_by=rank&sort_type=asc&offset=0&limit=20`, headers());
    return arr(j?.data ?? j).map((x, i) => tokenFrom(x, "birdeye-trending", n(x.rank, i))).filter(Boolean) as DiscoveredToken[];
  }

  async memeMomentum(): Promise<DiscoveredToken[]> {
    if (!config.birdeyeApiKey) return [];
    // High recent activity is discovery only; deep scoring happens separately.
    const q = new URLSearchParams({ sort_by: "volume_1m_usd", sort_type: "desc", source: "all", offset: "0", limit: "20" });
    const j = await getJson(`${BASE}/defi/v3/token/meme/list?${q}`, headers());
    return arr(j?.data ?? j).map((x, i) => tokenFrom(x, "birdeye-meme", i)).filter(Boolean) as DiscoveredToken[];
  }

  async snapshot(address: string): Promise<Partial<Snapshot>> {
    if (!config.birdeyeApiKey) return {};
    const [market, overview, holders] = await Promise.allSettled([
      getJson(`${BASE}/defi/v3/token/market-data?address=${encodeURIComponent(address)}`, headers()),
      getJson(`${BASE}/defi/token_overview?address=${encodeURIComponent(address)}&frames=1m,5m`, headers()),
      getJson(`${BASE}/defi/v3/token/holder?address=${encodeURIComponent(address)}&offset=0&limit=20&mode=wallet&get_holder_infos=false`, headers())
    ]);
    const m = market.status === "fulfilled" ? (market.value?.data ?? market.value ?? {}) : {};
    const o = overview.status === "fulfilled" ? (overview.value?.data ?? overview.value ?? {}) : {};
    const h = holders.status === "fulfilled" ? (holders.value?.data ?? holders.value ?? {}) : {};
    return {
      priceUsd: n(m.price, m.priceUsd, o.price),
      liquidityUsd: n(m.liquidity, m.liquidityUsd, o.liquidity),
      marketCapUsd: n(m.marketCap, m.market_cap, o.mc, o.marketCap),
      holderCount: n(m.holder, m.holderCount, o.holder),
      volume1mUsd: n(o.v1mUSD, o.volume1mUSD, o.volume_1m_usd, o.volume1m),
      volume5mUsd: n(o.v5mUSD, o.volume5mUSD, o.volume_5m_usd, o.volume5m),
      buys1m: n(o.buy1m, o.buy_1m, o.buys1m, o.trade1mBuy),
      sells1m: n(o.sell1m, o.sell_1m, o.sells1m, o.trade1mSell),
      trades1m: n(o.trade1m, o.trade_1m, o.trades1m),
      priceChange1mPct: n(o.priceChange1mPercent, o.price_change_1m_percent, o.priceChange1m),
      top10HolderPct: n(h.top10HoldPercent, h.top10HolderPercent, m.top10HoldPercent)
    };
  }

  async solPriceUsd(): Promise<number> {
    const j = await getJson(`${BASE}/defi/v3/token/market-data?address=${SOL_MINT}`, headers());
    const d = j?.data ?? j;
    const p = n(d?.price, d?.priceUsd);
    if (!p) throw new Error("Could not read SOL price from Birdeye");
    return p;
  }
}
