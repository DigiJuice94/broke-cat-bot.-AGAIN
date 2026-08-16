# Broke Cat Bot v1.3.5 — CU Saver

This update fixes the Birdeye Compute Unit drain without making Birdeye disappear from the strategy.

## New data flow

**DEX Screener (always on)** → discover attention signals + bulk price/liquidity/volume/buys/sells → observe acceleration → **Birdeye only for scarce high-value checks** → Jupiter route → BUY / NO BUY.

### What changed

- DEX Screener latest token profiles + latest/top boosts are now the continuous no-key discovery layer.
- DEX Screener continues to bulk-enrich up to 30 watchlist token addresses per request.
- Birdeye New Listings is supplemental and defaults to once every 90 minutes.
- Birdeye Trending defaults to once every 6 hours.
- Birdeye Meme List is disabled by default because it costs extra CUs and overlaps with our other discovery.
- Birdeye Token Overview only runs on the top 2 candidates **after** their DEX-built score reaches 65+.
- Birdeye overview cache increased to 2 minutes.
- A Birdeye `Compute units usage limit exceeded` response triggers a 6-hour Birdeye cooldown. The bot keeps scanning with DEX Screener instead of repeatedly throwing 400 errors.
- Open-position price monitoring moved from Birdeye to DEX Screener. This removes repeated Birdeye overview calls while a trade is held.
- SOL/USD used for position sizing and P/L is now read from a high-liquidity Solana SOL/USDC DEX Screener pair and cached for 60 seconds.
- ntfy phone alerts, contract-address buy logs, current-trade heartbeat, score emojis, paper trades, and sell statuses remain.

## Why this saves so many CUs

The prior version could repeatedly call Birdeye discovery and Token Overview while scanning and while monitoring positions. v1.3.5 makes DEX Screener the heartbeat and Birdeye a scarce premium check.

## Railway

No new API key is required. Existing variables still work. These CU Saver values are optional because these are already the defaults:

```env
DEX_DISCOVERY_INTERVAL_MS=30000
DEX_CACHE_MS=8000
BIRDEYE_SNAPSHOT_CACHE_MS=120000
BIRDEYE_DEEP_CANDIDATES=2
BIRDEYE_DEEP_MIN_SCORE=65
BIRDEYE_NEW_INTERVAL_MS=5400000
BIRDEYE_TRENDING_INTERVAL_MS=21600000
BIRDEYE_MEME_INTERVAL_MS=0
BIRDEYE_CU_COOLDOWN_MS=21600000
```

For testing keep:

```env
LIVE_TRADING=false
```

Your existing `BIRDEYE_API_KEY` can remain in Railway. If the current Birdeye monthly quota is already exhausted, v1.3.5 will automatically fall back to DEX Screener discovery/watch until Birdeye becomes usable again.

## Important

DEX Screener profiles/boosts are **attention signals**, not automatic buy signals. They only put coins into the candidate pool. The bot still requires its own runner score, data confidence, observation window, and Jupiter route checks before buying.
