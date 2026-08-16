# Broke Cat Bot v1.4 — Full Data + Price Failsafe

This update combines the discovery-refill fix with richer Birdeye enrichment and a redundant SOL/USD oracle.

## Data flow

**DEX Screener always-on discovery/watch** → **Birdeye enrichment for promising candidates** → **Birdeye holder concentration for near-buy finalists** → **Jupiter route/execution**.

### What changed

- DEX Screener still keeps the active candidate pool full and handles repetitive price/liquidity/volume/buy-sell monitoring.
- Birdeye New Listings defaults to every 3 minutes and Trending every 5 minutes.
- Birdeye Token Overview can enrich the top 4 candidates once their DEX-built score reaches 45+.
- Birdeye holder concentration is reserved for the top 2 near-buy candidates at score 68+ and is cached for 5 minutes.
- A local Birdeye budget defaults to 1,800 CU/hour so a paid allowance cannot be accidentally burned at the old rate.
- Birdeye remote-quota cooldown remains: if the provider says the CU allowance is exhausted, DEX Screener keeps the bot scanning.
- Scoring now uses Birdeye buy-vs-sell volume, unique wallets, liquidity quality, holder growth, and top-10 concentration when those fields are available.

## SOL/USD failsafe

Position sizing no longer depends on a single DEX Screener lookup:

1. Jupiter SOL → USDC quote (primary)
2. DEX Screener SOL/USD (fallback)
3. Recent last-good cached SOL/USD for up to 5 minutes (last resort)

A temporary DEX Screener SOL-price failure should therefore no longer produce `BUY FAILED: Could not read SOL/USD from DEX Screener` when Jupiter or a recent cached price is available.

## Recommended Railway values

The defaults are already built in, but these can be set explicitly:

```env
DEX_DISCOVERY_INTERVAL_MS=15000
BIRDEYE_CU_BUDGET_PER_HOUR=1800
BIRDEYE_SNAPSHOT_CACHE_MS=90000
BIRDEYE_DEEP_CANDIDATES=4
BIRDEYE_DEEP_MIN_SCORE=45
BIRDEYE_HOLDER_CANDIDATES=2
BIRDEYE_HOLDER_MIN_SCORE=68
BIRDEYE_HOLDER_CACHE_MS=300000
BIRDEYE_NEW_INTERVAL_MS=180000
BIRDEYE_TRENDING_INTERVAL_MS=300000
BIRDEYE_MEME_INTERVAL_MS=0
SOL_USD_CACHE_MS=60000
SOL_USD_STALE_MS=300000
```

Existing keys and wallet variables do not change. Keep `LIVE_TRADING=false` until the new logs show healthy discovery, Birdeye enrichment, route checks, and paper buys/sells.
