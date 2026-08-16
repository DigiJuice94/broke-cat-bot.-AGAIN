# Broke Cat Bot v1.2 — Data Efficiency

v1.2 changes the scanner from "deep-poll every candidate" to a priority funnel.

## Data pipeline
1. Axiom/Fomo adapters + Birdeye trending/new/meme discover candidates.
2. DEX Screener bulk-enriches up to the whole 20-token watchlist in one request.
3. Birdeye REST is centrally queued, cached, and reserved for the strongest candidates.
4. Helius RPC is centrally queued and cached. Activity is used on finalists; holder concentration is an even deeper check.
5. Jupiter route checks are deferred until a candidate is approaching entry quality.

## Why
This prevents the 20-candidate x multiple-API-call burst that caused repeated HTTP 429 responses.

## Important
Keep `LIVE_TRADING=false` until the logs show stable prices, varying scores, data confidence, and no sustained 429 storm.

## New optional Railway variables
The defaults are already coded; only add these if you want to tune pacing:
- BIRDEYE_MIN_INTERVAL_MS=1100
- BIRDEYE_SNAPSHOT_CACHE_MS=30000
- BIRDEYE_DEEP_CANDIDATES=6
- HELIUS_MIN_INTERVAL_MS=175
- HELIUS_ACTIVITY_CACHE_MS=15000
- HELIUS_HOLDER_CACHE_MS=60000
- HELIUS_DEEP_CANDIDATES=4
- DEX_CACHE_MS=8000
- ROUTE_DEEP_CANDIDATES=4
- BUNDLE_DEEP_CANDIDATES=3

No DEX Screener API key is required by this build.
