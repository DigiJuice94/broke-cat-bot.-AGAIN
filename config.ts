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
  birdeyeSnapshotCacheMs: num("BIRDEYE_SNAPSHOT_CACHE_MS", 30_000),
  birdeyeDeepCandidates: num("BIRDEYE_DEEP_CANDIDATES", 6),

  jupiterApiKey: process.env.JUPITER_API_KEY ?? "",

  ntfyServer: process.env.NTFY_SERVER ?? "https://ntfy.sh",
  ntfyTopic: process.env.NTFY_TOPIC ?? "",
  ntfyToken: process.env.NTFY_TOKEN ?? "",
  ntfyTimeoutMs: num("NTFY_TIMEOUT_MS", 5_000),

  dexCacheMs: num("DEX_CACHE_MS", 8_000),
  dexTimeoutMs: num("DEX_TIMEOUT_MS", 6_000),

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
  takeProfitPct: num("TAKE_PROFIT_PCT", 45),
  stopLossPct: num("STOP_LOSS_PCT", 18),
  trailingStopPct: num("TRAILING_STOP_PCT", 12),
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
export const LAMPORTS_PER_SOL = 1_000_000_000;
