import { config } from "./config.ts";
import { DiscoveredToken, FeedSource } from "./types.ts";
import { getJson } from "./http.ts";

function normalize(j: any, source: FeedSource): DiscoveredToken[] {
  const rows = Array.isArray(j) ? j : (j?.tokens ?? j?.data?.tokens ?? j?.data ?? j?.items ?? []);
  if (!Array.isArray(rows)) return [];
  return rows.map((x: any, i: number) => {
    const address = x.address ?? x.mint ?? x.tokenAddress ?? x.token_address;
    if (!address) return null;
    return {
      address,
      name: x.name ?? x.tokenName ?? "Unknown",
      symbol: x.symbol ?? x.tokenSymbol ?? "?",
      decimals: Number.isFinite(Number(x.decimals)) ? Number(x.decimals) : undefined,
      source,
      rank: Number.isFinite(Number(x.rank)) ? Number(x.rank) : i + 1,
      discoveredAt: Date.now()
    } as DiscoveredToken;
  }).filter(Boolean) as DiscoveredToken[];
}

async function read(url: string, key: string, source: FeedSource) {
  if (!url) return [];
  const headers: Record<string,string> = { accept: "application/json" };
  if (key) headers.authorization = `Bearer ${key}`;
  try { return normalize(await getJson(url, headers), source); }
  catch { return []; }
}

export const getAxiomTrending = () => read(config.axiomTrendingUrl, config.axiomApiKey, "axiom");
export const getFomoTrending = () => read(config.fomoTrendingUrl, config.fomoApiKey, "fomo");
