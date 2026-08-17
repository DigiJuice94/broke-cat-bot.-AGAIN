import "dotenv/config";

const num = (key: string, fallback: number) => {
  const v = Number(process.env[key]);
  return Number.isFinite(v) ? v : fallback;
};
const bool = (key: string, fallback: boolean) => {
  const v = process.env[key];
  if (v == null) return fallback;
  return ["1", "true", "yes", "on"].includes(v.toLowerCase());
};

export const config = {
  birdeyeApiKey: process.env.BIRDEYE_API_KEY ?? "",
  birdeyeMinIntervalMs: num("BIRDEYE_MIN_INTERVAL_MS", 1_100),
  birdeyeSnapshotCacheMs: num("BIRDEYE_SNAPSHOT_CACHE_MS", 90_000),
  birdeyeDeepCandidates: num("BIRDEYE_DEEP_CANDIDATES", 4),
  birdeyeDeepMinScore: num("BIRDEYE_DEEP_MIN_SCORE", 45),
  birdeyeHolderCandidates: num("BIRDEYE_HOLDER_CANDIDATES", 2),
  birdeyeHolderMinScore: num("BIRDEYE_HOLDER_MIN_SCORE", 68),
  birdeyeHolderCacheMs: num("BIRDEYE_HOLDER_CACHE_MS", 300_000),
  birdeyeCuBudgetPerHour: num("BIRDEYE_CU_BUDGET_PER_HOUR", 1_800),
  birdeyeCuCooldownMs: num("BIRDEYE_CU_COOLDOWN_MS", 21_600_000),
  birdeyeNewIntervalMs: num("BIRDEYE_NEW_INTERVAL_MS", 300_000),
  birdeyeTrendingIntervalMs: num("BIRDEYE_TRENDING_INTERVAL_MS", 120_000),
  birdeyeMemeIntervalMs: num("BIRDEYE_MEME_INTERVAL_MS", 0),

  // Mobula Pulse gives us an Axiom-style trending universe without scraping Axiom.
  mobulaApiKey: process.env.MOBULA_API_KEY ?? "",
  mobulaPulseUrl: process.env.MOBULA_PULSE_URL ?? "https://api.mobula.io/api/2/pulse",
  mobulaTrendingIntervalMs: num("MOBULA_TRENDING_INTERVAL_MS", 15_000),
  mobulaTimeoutMs: num("MOBULA_TIMEOUT_MS", 8_000),
  mobulaTrendingLimit: num("MOBULA_TRENDING_LIMIT", 30),
  mobulaActiveSlots: num("MOBULA_ACTIVE_SLOTS", 12),
  mobulaMinVolume1hUsd: num("MOBULA_MIN_VOLUME_1H_USD", 5_000),
  mobulaMinLiquidityUsd: num("MOBULA_MIN_LIQUIDITY_USD", 1_500),
  mobulaMinPriceChange1hPct: num("MOBULA_MIN_PRICE_CHANGE_1H_PCT", 5),

  jupiterApiKey: process.env.JUPITER_API_KEY ?? "",
  jupiterMinIntervalMs: num("JUPITER_MIN_INTERVAL_MS", 500),
  jupiterMaxRetries: num("JUPITER_MAX_RETRIES", 2),

  ntfyServer: process.env.NTFY_SERVER ?? "https://ntfy.sh",
  ntfyTopic: process.env.NTFY_TOPIC ?? "",
  ntfyToken: process.env.NTFY_TOKEN ?? "",
  ntfyTimeoutMs: num("NTFY_TIMEOUT_MS", 5_000),

  dexCacheMs: num("DEX_CACHE_MS", 8_000),
  dexTimeoutMs: num("DEX_TIMEOUT_MS", 6_000),
  dexDiscoveryIntervalMs: num("DEX_DISCOVERY_INTERVAL_MS", 15_000),
  minActiveCandidates: num("MIN_ACTIVE_CANDIDATES", 10),
  rewatchCooldownMs: num("REWATCH_COOLDOWN_MS", 60_000),
  knownRetentionMs: num("KNOWN_RETENTION_MS", 1_800_000),
  trendingRewatchCooldownMs: num("TRENDING_REWATCH_COOLDOWN_MS", 15_000),
  momentumMinBuys5m: num("MOMENTUM_MIN_BUYS_5M", 20),
  momentumMinBuySellRatio: num("MOMENTUM_MIN_BUY_SELL_RATIO", 1.35),
  momentumMinPrice5mPct: num("MOMENTUM_MIN_PRICE_5M_PCT", 5),

  routeDeepCandidates: num("ROUTE_DEEP_CANDIDATES", 4),
  bundleDeepCandidates: num("BUNDLE_DEEP_CANDIDATES", 3),

  rpcUrl: process.env.SOLANA_RPC_URL ?? "https://api.mainnet-beta.solana.com",
  privateKey: process.env.BS58_PRIVATE_KEY ?? "",
  liveTrading: bool("LIVE_TRADING", false),
  discoveryIntervalMs: num("DISCOVERY_INTERVAL_MS", 15_000),
  observationTickMs: num("OBSERVATION_TICK_MS", 10_000),
  minObservationMs: num("MIN_OBSERVATION_MS", 30_000),
  maxObservationMs: num("MAX_OBSERVATION_MS", 90_000),
  maxActiveCandidates: num("MAX_ACTIVE_CANDIDATES", 20),
  promoteScore: num("PROMOTE_SCORE", 55),
  buyScore: num("BUY_SCORE", 78),
  minDataConfidence: num("MIN_DATA_CONFIDENCE", 70),
  minPositionUsd: num("MIN_POSITION_USD", 2),
  solFeeReserve: num("SOL_FEE_RESERVE", 0.015),
  solUsdCacheMs: num("SOL_USD_CACHE_MS", 120_000),
  solUsdStaleMs: num("SOL_USD_STALE_MS", 300_000),
  solUsdRefreshMs: num("SOL_USD_REFRESH_MS", 45_000),
  solUsdTimeoutMs: num("SOL_USD_TIMEOUT_MS", 5_000),
  solUsdLogIntervalMs: num("SOL_USD_LOG_INTERVAL_MS", 300_000),
  // Exit protection is based on the executable Jupiter sell quote, not just the chart price.
  takeProfitPct: num("TAKE_PROFIT_PCT", 30),
  stopLossPct: num("STOP_LOSS_PCT", 15),
  trailingStopPct: num("TRAILING_STOP_PCT", 8),
  profitProtectArmPct: num("PROFIT_PROTECT_ARM_PCT", 15),
  executableQuoteDropPct: num("EXECUTABLE_QUOTE_DROP_PCT", 20),
  minExecutableValueRatio: num("MIN_EXECUTABLE_VALUE_RATIO", 0.65),
  rugExitPct: num("RUG_EXIT_PCT", 45),
  maxPositionAgeMin: num("MAX_POSITION_AGE_MIN", 12),
  positionPollMs: num("POSITION_POLL_MS", 5_000),
  positionStatusIntervalMs: num("POSITION_STATUS_INTERVAL_MS", 5_000),
  idlePositionStatusIntervalMs: num("IDLE_POSITION_STATUS_INTERVAL_MS", 30_000),
  axiomTrendingUrl: process.env.AXIOM_TRENDING_URL ?? "",
  axiomApiKey: process.env.AXIOM_TRENDING_API_KEY ?? "",
  fomoTrendingUrl: process.env.FOMO_TRENDING_URL ?? "",
  fomoApiKey: process.env.FOMO_TRENDING_API_KEY ?? "",
  bundleApiUrl: process.env.BUNDLE_API_URL ?? "",
  bundleApiKey: process.env.BUNDLE_API_KEY ?? "",
  requireSellRoute: bool("REQUIRE_SELL_ROUTE", true),
};

export const SOL_MINT = "So11111111111111111111111111111111111111112";
export const USDC_MINT = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
export const LAMPORTS_PER_SOL = 1_000_000_000;
