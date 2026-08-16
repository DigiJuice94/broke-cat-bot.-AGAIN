# v1.3.3 Buy Contract Address

Every PAPER BUY and live BOUGHT log now prints the exact Solana token mint/contract address. Copy that address into DEX Screener, Birdeye, Axiom, Jupiter, or a Solana explorer to find the exact token. No scoring, scanner, sizing, or sell logic was changed.

## v1.3.2 Sell Status
- Successful completed exits log `💰 SOLD`.
- Failed exits log `⚠️ SELL FAILED`.
- Trading/scoring logic otherwise unchanged from v1.3.

# Broke Cat Bot v1.3 — Simple Efficient

v1.3 removes Helius from the active scanner and scoring path. The bot now focuses on a simple pipeline:

**Discover → DEX Screener bulk enrichment → Birdeye deep checks → observe acceleration → Jupiter finalist route check → BUY / NO BUY**

## Data sources

- **DEX Screener:** efficient bulk price, liquidity, volume, price change, buys/sells.
- **Birdeye:** discovery/trending plus deeper market/holder data for prioritized candidates.
- **Axiom/Fomo adapters:** optional trending-priority sources when URLs/API access are available.
- **Jupiter:** route verification and swap execution only.
- **Helius:** removed. No Helius key is required.

## Score display

Railway logs now show a visual score band:

- 🔴 0–49 weak
- 🟠 50–64 watch
- 🟡 65–77 developing
- 🟢 78–89 buy-quality
- 🔥 90–100 elite runner

Example:

`[SCAN] CAT ($CAT) | Price:$0.000021 | Score:🟢 84/100 | Data:92% | ⏳ DEVELOPING`

## Scoring philosophy

The score is based on market strength and what changes while the bot is watching:

- buy/sell pressure
- price momentum
- volume level
- buy acceleration between snapshots
- volume acceleration between snapshots
- price acceleration between snapshots
- holder growth when available
- trending-source priority
- holder concentration and bundle-risk deductions

**Data % is confidence/completeness, not the score.** A coin can have 95% data and still deserve a low score.

## Railway

Keep `LIVE_TRADING=false` until logs and route behavior are verified.

Required/primary variables:

```env
BIRDEYE_API_KEY=
JUPITER_API_KEY=
BS58_PRIVATE_KEY=
SOLANA_RPC_URL=https://api.mainnet-beta.solana.com
LIVE_TRADING=false
```

Useful tuning defaults:

```env
BIRDEYE_MIN_INTERVAL_MS=1100
BIRDEYE_SNAPSHOT_CACHE_MS=30000
BIRDEYE_DEEP_CANDIDATES=6
DEX_CACHE_MS=8000
DEX_TIMEOUT_MS=6000
ROUTE_DEEP_CANDIDATES=4
BUNDLE_DEEP_CANDIDATES=3
DISCOVERY_INTERVAL_MS=15000
OBSERVATION_TICK_MS=10000
MIN_OBSERVATION_MS=30000
MAX_OBSERVATION_MS=90000
MAX_ACTIVE_CANDIDATES=20
PROMOTE_SCORE=55
BUY_SCORE=78
MIN_DATA_CONFIDENCE=70
MIN_POSITION_USD=2
SOL_FEE_RESERVE=0.015
REQUIRE_SELL_ROUTE=true
```

Old `HELIUS_*` Railway variables may be deleted, but leaving them there will not affect v1.3 because the code no longer reads them.


## v1.3.2 Current Trade
- Adds `[CURRENT TRADE]` heartbeat for every open position.
- Shows HOLDING/PAPER HOLDING, entry, current price, original position size, estimated current value, P/L, peak P/L, time held, and score at buy.
- Shows `[OPEN POSITIONS] 0 | 💤 Waiting for runner` when idle.
- Paper buys now create simulated positions and run through the same TP/SL/trailing/time exit logic, ending with `💰 PAPER SOLD`.
- Successful live exits remain `💰 SOLD`; failed live exits remain `⚠️ SELL FAILED`.
