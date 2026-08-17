# Broke Cat Bot v2.1.0 — Real Exit Protection

**Primary change:** exits no longer trust chart/DEX price alone. Every LIVE position is valued using a full-position Jupiter token→SOL quote, and that executable value drives profit-taking, stop-losses, trailing protection, and rug/liquidity-collapse detection.

## New default exit behavior

```env
TAKE_PROFIT_PCT=30
STOP_LOSS_PCT=15
TRAILING_STOP_PCT=8
PROFIT_PROTECT_ARM_PCT=15
EXECUTABLE_QUOTE_DROP_PCT=20
MIN_EXECUTABLE_VALUE_RATIO=0.65
RUG_EXIT_PCT=45
```

- **+30% REAL P/L:** take profit.
- **-15% REAL P/L:** cut the loss.
- **Profit protection:** once the executable P/L reaches +15%, an 8-point giveback from the executable peak exits the trade.
- **Fast-exit protection:** if the actual quoted sell value falls 20% or more between polls, exit immediately.
- **Liquidity-collapse protection:** if Jupiter says the position is worth less than 65% of what the chart price implies, exit immediately and label it as liquidity collapse.
- **Sell confirmation:** a failed sell keeps the position live. After execution the bot re-reads the token balance and only removes a fully/near-fully closed position. Partial exits remain tracked.
- **Logs now separate `Chart P/L` from `REAL P/L` and show `ExitNow`**, so a coin can never be called a +47% take profit when the executable exit value is actually near zero.

> These controls can reduce damage from a collapsing route, but they cannot guarantee an exit if liquidity disappears before a transaction can execute.

---

# Broke Cat Bot v2.0.1 — Axiom-Style Discovery

**Primary change:** popular-runner discovery now starts with Mobula Pulse HTTP configured to mimic an Axiom-style Solana trending view. DEX Screener is demoted to enrichment/fallback, while Birdeye still provides its trending/new-listing and deep finalist data.

## New required variable for the new discovery lane

```env
MOBULA_API_KEY=your_mobula_key
```

Create a Mobula production API key and put it only in Railway Variables. The bot uses `POST https://api.mobula.io/api/2/pulse`; it does **not** scrape Axiom. If Mobula is unavailable or the key is missing, the bot continues with Birdeye + DEX fallback discovery.

## What the Axiom-style lane ranks

Two Solana views are requested together: top `volume_1h` runners and top `price_change_1h` runners. Mobula data can seed price, liquidity, market cap, recent buys/sells, organic flow, holders, top-10 concentration and bundler holdings before the normal Broke Cat observation/scoring process.

## Rank movement

By default, 12 of the 20 active-candidate slots are reserved for the highest Axiom-style Mobula signals, leaving room for Birdeye Trending / early launches. Repeated Mobula rankings are tracked. Logs can show rank movement such as `mobula-axiom-volume#8↑5`. Climbing rank increases scanner priority but never bypasses score/data/route requirements.

---

# Broke Cat Bot v1.5 — Trending Runners

## What changed
- Two discovery lanes: **🔥 Trending Runners** and **🐣 Early Runners**.
- Birdeye Trending is checked more often than New Listings by default.
- Fomo/Axiom adapter results (when configured) receive highest scanner priority.
- Older/previously dropped tokens can immediately re-enter observation when a trending source rediscovers them.
- Organic DEX momentum can promote a known token into the trending lane using 5m buys, buy/sell ratio, and price movement.
- Paid DEX boosts are now supplemental and carry very little score/priority weight.
- Existing v1.4.2 same-cycle finalist, full-data, SOL/USD failsafe, holding CA, ntfy, and sell logic remain intact.

Default knobs:
```env
BIRDEYE_TRENDING_INTERVAL_MS=120000
BIRDEYE_NEW_INTERVAL_MS=300000
TRENDING_REWATCH_COOLDOWN_MS=15000
MOMENTUM_MIN_BUYS_5M=20
MOMENTUM_MIN_BUY_SELL_RATIO=1.35
MOMENTUM_MIN_PRICE_5M_PCT=5
```

> Fomo and Axiom remain optional adapters because neither exposes a documented public trending API endpoint in the current public docs. If supported feed URLs are available, the existing `FOMO_TRENDING_URL` / `AXIOM_TRENDING_URL` variables feed directly into the high-priority trending lane.

---

# Broke Cat Bot v1.4.2.1 — Full Data + Price Failsafe

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

## v1.4.1 — Same-Cycle Finalist Verification
When freshly collected market data pushes a token across the configured BUY_SCORE, Broke Cat immediately runs missing Jupiter route and finalist deep checks in that same scan cycle. It no longer waits for the next observation tick just because the previous score was below threshold. The minimum observation-time, data-confidence, buy-route, and sell-route requirements are still enforced before READY/BUY.


## v1.4.2
- CURRENT TRADE / HOLDING logs now include the exact Solana contract address (`CA:<mint>`).


## v2.0.1 SOL/USD execution fix
- SOL/USD is refreshed in the background before a trade is ready.
- Primary source: Coinbase public exchange rates (no key).
- Fallback: DEX Screener.
- Jupiter is emergency-only for SOL/USD, preserving Jupiter capacity for route/execution calls.
- A recent cached SOL/USD value can be used for up to `SOL_USD_STALE_MS` when all live sources briefly fail.

- Jupiter requests are now serialized with 429 backoff (`JUPITER_MIN_INTERVAL_MS`, default 500ms).

## v2.2.0 — Meta Runner Intelligence

Broke Cat now combines four compact layers instead of buying random movement:

- **SOCIAL** — official X API watchlist for Ansem, sling, Cobie, CZ, PoorGoat and Pump.fun; detects direct token mentions, callout contract addresses, account overlap and live dominant META terms.
- **SMART MONEY** — Birdeye Top Traders enrichment on finalists using Solana wallet tags such as `smart_trader`, `sniper`, `insider`, `bundler`, and `dev`.
- **MARKET** — existing Birdeye/DEX/Mobula momentum remains the market backbone.
- **SAFETY** — sell route, route quality, holder concentration, bundle risk and suspicious trader cohorts.

When `X_BEARER_TOKEN` is configured, the final score is approximately **40% market + 40% social/narrative + 20% safety**. Strong cross-confirmed candidates are logged as **🟣 META RUNNER**. Pump.fun callouts are high-priority discovery signals, but they never bypass market/safety confirmation.

The exit system is now adaptive: a weak loser can exit around the soft-stop level while a temporary shakeout with strong buy pressure can survive until the hard stop. Full-position Jupiter executable-value protection remains the source of truth for live exits.

Closed trades are re-checked at **5m / 15m / 30m / 60m** after exit and logged as early-exit/good-stop follow-up data so future tuning can use actual outcomes.
