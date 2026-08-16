import { config } from "./config.ts";
import { log } from "./log.ts";
import { RequestQueue } from "./requestQueue.ts";

interface CacheEntry<T> { at: number; value: T }
export interface HeliusSnapshot {
  holderCount?: number; top10HolderPct?: number; chainTx10s?: number; chainTx30s?: number; chainTx1m?: number;
  uniqueWallet1m?: number; heliusStatus: "ok" | "partial" | "off" | "error" | "skipped"; heliusErrors?: string[];
}

export class Helius {
  private queue = new RequestQueue("Helius", config.heliusMinIntervalMs, 2);
  private holderCache = new Map<string, CacheEntry<Pick<HeliusSnapshot, "holderCount" | "top10HolderPct">>>();
  private activityCache = new Map<string, CacheEntry<Pick<HeliusSnapshot, "chainTx10s" | "chainTx30s" | "chainTx1m" | "uniqueWallet1m">>>();
  get enabled() { return Boolean(config.heliusApiKey); }
  private get url() { return `https://mainnet.helius-rpc.com/?api-key=${encodeURIComponent(config.heliusApiKey)}`; }

  private rpc<T>(method: string, params: unknown): Promise<T> {
    return this.queue.schedule(async () => {
      if (!this.enabled) throw new Error("HELIUS_API_KEY missing");
      const ctl = new AbortController();
      const timer = setTimeout(() => ctl.abort(), config.heliusTimeoutMs);
      try {
        const r = await fetch(this.url, { method: "POST", headers: { "content-type": "application/json" },
          body: JSON.stringify({ jsonrpc: "2.0", id: `${method}-${Date.now()}`, method, params }), signal: ctl.signal });
        if (!r.ok) throw new Error(`${method} HTTP ${r.status}`);
        const body = await r.json() as { result?: T; error?: { code?: number; message?: string } };
        if (body.error) throw new Error(`${method} ${body.error.code ?? ""} ${body.error.message ?? "RPC error"}`.trim());
        if (body.result == null) throw new Error(`${method} returned no result`);
        return body.result;
      } finally { clearTimeout(timer); }
    });
  }

  private async holderStats(mint: string) {
    const cached = this.holderCache.get(mint);
    if (cached && Date.now() - cached.at < config.heliusHolderCacheMs) return cached.value;
    // Sequential through the central queue: no three-call burst.
    const accounts = await this.rpc<{ total?: number }>("getTokenAccounts", { mint, page: 1, limit: 1 });
    const largest = await this.rpc<{ value?: Array<{ amount?: string }> }>("getTokenLargestAccounts", [mint]);
    const supply = await this.rpc<{ value?: { amount?: string } }>("getTokenSupply", [mint]);
    const totalSupply = BigInt(supply.value?.amount ?? "0");
    let top10HolderPct: number | undefined;
    if (totalSupply > 0n) {
      const top10 = (largest.value ?? []).slice(0, 10).reduce((sum, x) => sum + BigInt(x.amount ?? "0"), 0n);
      top10HolderPct = Number((top10 * 1_000_000n) / totalSupply) / 10_000;
    }
    const value = { holderCount: accounts.total, top10HolderPct };
    this.holderCache.set(mint, { at: Date.now(), value });
    return value;
  }

  private async activity(mint: string) {
    const cached = this.activityCache.get(mint);
    if (cached && Date.now() - cached.at < config.heliusActivityCacheMs) return cached.value;
    const nowSec = Math.floor(Date.now() / 1000), since = nowSec - 65;
    const sig = await this.rpc<{ data?: Array<{ blockTime?: number }> }>("getTransactionsForAddress", [mint, {
      transactionDetails: "signatures", sortOrder: "desc", limit: config.heliusActivityLimit, commitment: "confirmed",
      filters: { blockTime: { gte: since }, status: "succeeded" },
    }]);
    const rows = sig.data ?? [];
    const age = (t?: number) => t == null ? Infinity : nowSec - t;
    const chainTx10s = rows.filter(x => age(x.blockTime) <= 10).length;
    const chainTx30s = rows.filter(x => age(x.blockTime) <= 30).length;
    const chainTx1m = rows.filter(x => age(x.blockTime) <= 60).length;
    const value = { chainTx10s, chainTx30s, chainTx1m, uniqueWallet1m: undefined as number | undefined };
    this.activityCache.set(mint, { at: Date.now(), value });
    return value;
  }

  async snapshot(mint: string, includeHolders = false): Promise<HeliusSnapshot> {
    if (!this.enabled) return { heliusStatus: "off" };
    const errors: string[] = [];
    const out: HeliusSnapshot = { heliusStatus: "ok" };
    try { Object.assign(out, await this.activity(mint)); } catch (e) { errors.push(e instanceof Error ? e.message : String(e)); }
    if (includeHolders) {
      try { Object.assign(out, await this.holderStats(mint)); } catch (e) { errors.push(e instanceof Error ? e.message : String(e)); }
    }
    if (errors.length) {
      out.heliusErrors = errors; out.heliusStatus = Object.keys(out).length > 2 ? "partial" : "error";
      if (errors.some(x => /429/.test(x))) log.warn(`[HELIUS] ${mint.slice(0, 6)}… rate limited after queue/backoff`);
    }
    return out;
  }
}
