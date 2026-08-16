import { config } from "./config.ts";
import { log } from "./log.ts";

interface CacheEntry<T> { at: number; value: T }

export interface HeliusSnapshot {
  holderCount?: number;
  top10HolderPct?: number;
  chainTx10s?: number;
  chainTx30s?: number;
  chainTx1m?: number;
  uniqueWallet1m?: number;
  heliusStatus: "ok" | "partial" | "off" | "error";
  heliusErrors?: string[];
}

export class Helius {
  private holderCache = new Map<string, CacheEntry<Pick<HeliusSnapshot, "holderCount" | "top10HolderPct">>>();

  get enabled() { return Boolean(config.heliusApiKey); }
  private get url() { return `https://mainnet.helius-rpc.com/?api-key=${encodeURIComponent(config.heliusApiKey)}`; }

  private async rpc<T>(method: string, params: unknown): Promise<T> {
    if (!this.enabled) throw new Error("HELIUS_API_KEY missing");
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), config.heliusTimeoutMs);
    try {
      const r = await fetch(this.url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: `${method}-${Date.now()}`, method, params }),
        signal: ctl.signal,
      });
      if (!r.ok) throw new Error(`${method} HTTP ${r.status}`);
      const body = await r.json() as { result?: T; error?: { code?: number; message?: string } };
      if (body.error) throw new Error(`${method} ${body.error.code ?? ""} ${body.error.message ?? "RPC error"}`.trim());
      if (body.result == null) throw new Error(`${method} returned no result`);
      return body.result;
    } finally {
      clearTimeout(timer);
    }
  }

  private async holderStats(mint: string) {
    const cached = this.holderCache.get(mint);
    if (cached && Date.now() - cached.at < config.heliusHolderCacheMs) return cached.value;

    const [accounts, largest, supply] = await Promise.all([
      this.rpc<{ total?: number }>("getTokenAccounts", { mint, page: 1, limit: 1 }),
      this.rpc<{ value?: Array<{ amount?: string }> }>("getTokenLargestAccounts", [mint]),
      this.rpc<{ value?: { amount?: string } }>("getTokenSupply", [mint]),
    ]);

    const totalSupply = BigInt(supply.value?.amount ?? "0");
    let top10HolderPct: number | undefined;
    if (totalSupply > 0n) {
      const top10 = (largest.value ?? []).slice(0, 10).reduce((sum, x) => sum + BigInt(x.amount ?? "0"), 0n);
      // Preserve precision safely for a percentage without converting the whole supply to Number first.
      top10HolderPct = Number((top10 * 1_000_000n) / totalSupply) / 10_000;
    }
    const value = { holderCount: accounts.total, top10HolderPct };
    this.holderCache.set(mint, { at: Date.now(), value });
    return value;
  }

  private async activity(mint: string) {
    const nowSec = Math.floor(Date.now() / 1000);
    const since = nowSec - 65;
    const sig = await this.rpc<{ data?: Array<{ blockTime?: number; signature?: string }> }>(
      "getTransactionsForAddress",
      [mint, {
        transactionDetails: "signatures",
        sortOrder: "desc",
        limit: config.heliusActivityLimit,
        commitment: "confirmed",
        filters: { blockTime: { gte: since }, status: "succeeded" },
      }]
    );
    const rows = sig.data ?? [];
    const age = (t?: number) => t == null ? Infinity : nowSec - t;
    const chainTx10s = rows.filter(x => age(x.blockTime) <= 10).length;
    const chainTx30s = rows.filter(x => age(x.blockTime) <= 30).length;
    const chainTx1m = rows.filter(x => age(x.blockTime) <= 60).length;

    let uniqueWallet1m: number | undefined;
    // Full transaction reads cost more. Only spend those credits when the token is showing real activity.
    if (chainTx1m >= config.heliusUniqueWalletMinTx) {
      try {
        const full = await this.rpc<{ data?: Array<{ blockTime?: number; transaction?: { message?: { accountKeys?: Array<string | { pubkey?: string }> } } }> }>(
          "getTransactionsForAddress",
          [mint, {
            transactionDetails: "full",
            encoding: "jsonParsed",
            maxSupportedTransactionVersion: 0,
            sortOrder: "desc",
            limit: Math.min(config.heliusActivityLimit, 50),
            commitment: "confirmed",
            filters: { blockTime: { gte: since }, status: "succeeded" },
          }]
        );
        const wallets = new Set<string>();
        for (const tx of full.data ?? []) {
          if (age(tx.blockTime) > 60) continue;
          const first = tx.transaction?.message?.accountKeys?.[0];
          const key = typeof first === "string" ? first : first?.pubkey;
          if (key) wallets.add(key);
        }
        uniqueWallet1m = wallets.size;
      } catch (e) {
        // Activity counts are still useful if the expensive full lookup is unavailable/rate-limited.
        log.warn(`[HELIUS] unique-wallet sample failed for ${mint.slice(0, 6)}…: ${e instanceof Error ? e.message : String(e)}`);
      }
    }
    return { chainTx10s, chainTx30s, chainTx1m, uniqueWallet1m };
  }

  async snapshot(mint: string): Promise<HeliusSnapshot> {
    if (!this.enabled) return { heliusStatus: "off" };
    const errors: string[] = [];
    const [holders, activity] = await Promise.allSettled([this.holderStats(mint), this.activity(mint)]);
    const out: HeliusSnapshot = { heliusStatus: "ok" };
    if (holders.status === "fulfilled") Object.assign(out, holders.value);
    else errors.push(holders.reason instanceof Error ? holders.reason.message : String(holders.reason));
    if (activity.status === "fulfilled") Object.assign(out, activity.value);
    else errors.push(activity.reason instanceof Error ? activity.reason.message : String(activity.reason));
    if (errors.length) {
      out.heliusErrors = errors;
      out.heliusStatus = holders.status === "rejected" && activity.status === "rejected" ? "error" : "partial";
    }
    return out;
  }
}
