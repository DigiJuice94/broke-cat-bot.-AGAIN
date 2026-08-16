import { Birdeye } from "./birdeye.ts";
import { getAxiomTrending, getFomoTrending } from "./trendingFeed.ts";
import { bundleRisk } from "./bundle.ts";
import { Jupiter } from "./jupiter.ts";
import { config } from "./config.ts";
import { Candidate, DiscoveredToken, Snapshot } from "./types.ts";
import { log } from "./log.ts";
import { scoreCandidate } from "./scoring.ts";

export class Scanner {
  readonly candidates = new Map<string, Candidate>();
  private lastDiscovery = 0;

  constructor(private birdeye: Birdeye, private jupiter: Jupiter, private onReady: (c: Candidate) => Promise<void>) {}

  private add(t: DiscoveredToken) {
    const existing = this.candidates.get(t.address);
    if (existing) {
      existing.sources.add(t.source);
      existing.lastSeenAt = Date.now();
      if (t.rank != null) existing.trendingRanks[t.source] = t.rank;
      if (existing.token.name === "Unknown" && t.name !== "Unknown") existing.token.name = t.name;
      if (existing.token.symbol === "?" && t.symbol !== "?") existing.token.symbol = t.symbol;
      if (existing.token.decimals == null && t.decimals != null) existing.token.decimals = t.decimals;
      if (t.seed) existing.token.seed = { ...(existing.token.seed ?? {}), ...Object.fromEntries(Object.entries(t.seed).filter(([,v]) => v !== undefined)) };
      return;
    }
    if ([...this.candidates.values()].filter(c => !["DROPPED","BOUGHT","FAILED"].includes(c.state)).length >= config.maxActiveCandidates) return;
    this.candidates.set(t.address, {
      token: t, firstSeenAt: Date.now(), lastSeenAt: Date.now(), sources: new Set([t.source]),
      trendingRanks: t.rank == null ? {} : { [t.source]: t.rank }, snapshots: [], score: 0,
      dataConfidence: 0, state: "WATCHING", collecting: false
    });
  }

  private async discover() {
    // Trending sources are intentionally queried/ingested first so they win scarce candidate slots.
    const results = await Promise.allSettled([
      getAxiomTrending(), getFomoTrending(), this.birdeye.trending(),
      this.birdeye.newListings(), this.birdeye.memeMomentum()
    ]);
    for (const r of results) if (r.status === "fulfilled") for (const t of r.value) this.add(t);
    const active = [...this.candidates.values()].filter(c => !["DROPPED","BOUGHT","FAILED"].includes(c.state)).length;
    log.info(`[DISCOVERY] active candidates=${active} total-known=${this.candidates.size}`);
  }

  private rankText(c: Candidate) {
    return Object.entries(c.trendingRanks).map(([k,v]) => `${k}#${v}`).join(",");
  }

  private async collect(c: Candidate) {
    if (c.collecting || ["DROPPED","BOUGHT","FAILED"].includes(c.state)) return;
    c.collecting = true;
    try {
      const [market, bundle, route] = await Promise.all([
        this.birdeye.snapshot(c.token.address, c.token.seed),
        bundleRisk(c.token.address),
        this.jupiter.canBuyAndSell(c.token.address)
      ]);
      const snap: Snapshot = {
        at: Date.now(), ...market,
        bundleRisk: bundle.risk,
        bundleStatus: bundle.status === "ok" ? "ok" : bundle.status === "error" ? "error" : "unknown",
        buyRoute: route.buy, sellRoute: route.sell, routeQuality: route.quality
      };
      c.snapshots.push(snap);
      if (c.snapshots.length > 12) c.snapshots.shift();
      const scored = scoreCandidate(c);
      c.score = scored.score; c.dataConfidence = scored.confidence; c.decisionReason = scored.reason;
      const age = Date.now() - c.firstSeenAt;
      if (age >= config.minObservationMs && c.score >= config.buyScore && c.dataConfidence >= config.minDataConfidence && snap.buyRoute && (!config.requireSellRoute || snap.sellRoute)) {
        c.state = "READY";
      } else if (age >= config.maxObservationMs) {
        c.state = "DROPPED";
        c.decisionReason = `NO BUY: observation ended at score ${Math.round(c.score)} / data ${Math.round(c.dataConfidence)}%`;
      } else if (c.score >= config.promoteScore) c.state = "DEVELOPING";
      else c.state = "WATCHING";

      if (snap.dataErrors?.length && snap.priceUsd == null) {
        log.warn(`[DATA] ${c.token.name} (${c.token.symbol}) | ${snap.dataErrors.join(" | ")}`);
      }

      log.scan({
        name: c.token.name, symbol: c.token.symbol, priceUsd: snap.priceUsd,
        score: c.score, confidence: c.dataConfidence,
        status: c.state === "READY" ? "✅ READY" : c.state === "DROPPED" ? "❌ NO BUY" : `⏳ ${c.state}`,
        reason: c.decisionReason, sources: [...c.sources], rankText: this.rankText(c)
      });

      if (c.state === "READY") await this.onReady(c);
    } catch (e) {
      log.warn(`[SCAN ERROR] ${c.token.name} ${c.token.address}: ${e instanceof Error ? e.message : String(e)}`);
    } finally { c.collecting = false; }
  }

  async tick() {
    const now = Date.now();
    if (now - this.lastDiscovery >= config.discoveryIntervalMs) {
      this.lastDiscovery = now;
      await this.discover();
    }
    const active = [...this.candidates.values()]
      .filter(c => !["DROPPED","BOUGHT","FAILED"].includes(c.state))
      .sort((a,b) => {
        const pri = (x:Candidate) => (x.sources.has("axiom")?3:0)+(x.sources.has("fomo")?3:0)+(x.sources.has("birdeye-trending")?2:0)+x.score/100;
        return pri(b)-pri(a);
      });
    await Promise.all(active.map(c => this.collect(c)));
  }
}
