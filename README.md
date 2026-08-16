## v1.0.1 Railway import-path fix

Flat GitHub layout with TypeScript-local imports corrected for direct `tsx index.ts` execution.

# Broke Cat Bot v1.0 — Clean Core

A fresh Solana early-runner bot architecture built around **data collection over raw scan speed**.

## Core philosophy

**Discover attention → patiently collect data → make a confident decision → execute quickly → exit quickly.**

This version does not reject a coin merely because optional bundle data is missing. Missing data reduces `Data Confidence`; executable buy/sell routes remain important execution checks.

## What v1 includes

- Birdeye new-token discovery
- Birdeye trending-token priority feed
- Birdeye meme-token momentum discovery
- Optional Axiom trending JSON adapter
- Optional Fomo trending JSON adapter
- 30–90 second candidate observation window by default
- Up to 20 candidates gathering data concurrently
- Current coin **name, symbol, price, score, data confidence and decision in every scan log**
- Market data, holder concentration and short-window activity collection
- Optional bundle-risk adapter
- Jupiter buy + reverse-sell route verification before entry
- Dynamic position sizing with a $2 minimum and **no configured maximum trade cap**
- Full Solana wallet signing through a private key stored only in environment variables
- Small SOL transaction reserve (default `0.015 SOL`)
- Current Jupiter `/swap/v2/order` + `/execute` integration
- Live position monitoring
- Take-profit, stop-loss, trailing-exit and time-exit controls
- Railway-ready start command
- `LIVE_TRADING=false` by default so the first deployment can be observed safely

## Scanner output

Example:

```text
[SCAN] Broke Cat ($BCAT) | Price:$0.0000182 | Score:88/100 | Data:91% | ⏳ DEVELOPING | Sources:birdeye-new+axiom | Trend:axiom#8 | buy pressure 3.4x
```

Final decisions are explicit:

```text
✅ BOUGHT
❌ NO BUY
🧪 PAPER BUY
❌ BUY FAILED
```

## Railway setup

1. Upload this folder/repository to Railway.
2. Add the variables from `.env.example` to Railway **Variables**.
3. Add at minimum:
   - `BIRDEYE_API_KEY`
   - `JUPITER_API_KEY`
   - `SOLANA_RPC_URL`
   - `BS58_PRIVATE_KEY`
4. Leave `LIVE_TRADING=false` for the first run.
5. Confirm that coin names, prices, scores, confidence and route checks are appearing.
6. Set `LIVE_TRADING=true` only when you want the bot to sign real swaps.

## Trust Wallet / wallet key

The bot does not connect to the Trust Wallet UI. It loads the **same Solana account** from its exported private key. `BS58_PRIVATE_KEY` accepts either:

- a base58 Solana secret key, or
- a JSON byte array such as `[12,34,...]`.

**Never put the private key in GitHub, README files, screenshots, or source code.** Put it only in Railway Variables / `.env`.

## Position sizing

There is no `MAX_POSITION_USD` or `MAX_POSITION_PCT` setting in v1.

The bot calculates:

```text
spendable SOL = wallet SOL - SOL_FEE_RESERVE
```

It then chooses a fraction of that spendable balance from Runner Score, Data Confidence, route quality and multi-trending confirmation. The configured minimum is `$2`.

## Trending priority

Trending status affects **which coins get scanner attention first**. It does not automatically increase a coin into a buy.

Priority sources:

1. Axiom + Fomo overlap
2. Axiom or Fomo trending
3. Birdeye trending
4. Birdeye new listing / meme momentum

Axiom documents a Trending section, but v1 intentionally does not scrape its website. If you have a legitimate JSON/API/proxy feed, set `AXIOM_TRENDING_URL`.

Fomo is handled the same way through `FOMO_TRENDING_URL` because a stable public ranking API has not been assumed.

Expected optional feed shape:

```json
[
  {"address":"TOKEN_MINT","name":"Coin Name","symbol":"COIN","rank":4}
]
```

or:

```json
{"tokens":[{"address":"TOKEN_MINT","name":"Coin Name","symbol":"COIN","rank":4}]}
```

## Bundle adapter

Set `BUNDLE_API_URL` to a service you trust. You can use `{mint}` in the URL:

```text
https://example.com/token/{mint}/bundles
```

or the bot appends `?address=<mint>`.

Recognized risk fields include `riskScore`, `risk`, `bundlePercent`, and `bundledPercent`.

If no bundle service is configured, bundle status is `UNKNOWN`. That lowers confidence rather than instantly rejecting every coin.

## Default exit behavior

- Take profit: `+45%`
- Stop loss: `-18%`
- Trailing exit: `12%` from the high after the trade is at least +8%
- Maximum position age: `12 minutes`

All are environment variables. These are implementation defaults, not guarantees of profit.

## Important limitation in v1

The bot has working adapters for Birdeye and Jupiter. **Axiom, Fomo and bundle feeds require an endpoint/API source to be configured**; v1 does not fake those values or scrape private web sessions. This keeps the trading engine independent so those sources can be added without rewriting the scanner.

## Commands

```bash
npm install
npm run check
npm start
```

## Security

A private-key trading bot can move funds controlled by that key. Use a dedicated bot wallet, keep the key in Railway Variables, and never expose it in logs or source control.


## Flat GitHub upload
This package is intentionally flat. Upload all files in this folder directly to the GitHub repo root. Railway starts `index.ts` from the root.

## v1.0.2 Data Enrichment Fix
- Token Overview is now the primary Birdeye enrichment source.
- `/defi/price` is used as a price/liquidity fallback.
- Discovery-feed market fields seed the first snapshot instead of being discarded.
- Birdeye endpoint errors are printed as `[DATA] ...` warnings when price is unavailable.
- Runner score is separated from Jupiter route availability. Routes remain hard execution gates.
- Data confidence now reflects actual market-data completeness rather than false/true route booleans.
