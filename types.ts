export type FeedSource = "birdeye-new" | "birdeye-trending" | "birdeye-meme" | "axiom" | "fomo";

export interface DiscoveredToken {
  address: string;
  name: string;
  symbol: string;
  decimals?: number;
  source: FeedSource;
  rank?: number;
  discoveredAt: number;
  listedAt?: number;
  seed?: Partial<Snapshot>;
}

export interface Snapshot {
  at: number;
  priceUsd?: number;
  liquidityUsd?: number;
  marketCapUsd?: number;
  holderCount?: number;
  volume1mUsd?: number;
  volume5mUsd?: number;
  buys1m?: number;
  sells1m?: number;
  buys5m?: number;
  sells5m?: number;
  trades1m?: number;
  uniqueWallet1m?: number;
  buyVolume1mUsd?: number;
  sellVolume1mUsd?: number;
  priceChange1mPct?: number;
  priceChange5mPct?: number;
  top10HolderPct?: number;
  bundleRisk?: number;
  bundleStatus: "ok" | "unknown" | "pending" | "error" | "skipped";
  buyRoute: boolean;
  sellRoute: boolean;
  routeQuality?: number;
  dexPairAddress?: string;
  dexId?: string;
  dataErrors?: string[];
}

export interface Candidate {
  token: DiscoveredToken;
  firstSeenAt: number;
  lastSeenAt: number;
  sources: Set<FeedSource>;
  trendingRanks: Partial<Record<FeedSource, number>>;
  snapshots: Snapshot[];
  score: number;
  dataConfidence: number;
  state: "WATCHING" | "DEVELOPING" | "READY" | "BOUGHT" | "DROPPED" | "FAILED";
  decisionReason?: string;
  collecting: boolean;
}

export interface Position {
  mint: string;
  name: string;
  symbol: string;
  decimals: number;
  tokenAmountRaw: bigint;
  entrySolLamports: bigint;
  entryUsd: number;
  entryPriceUsd: number;
  openedAt: number;
  highPriceUsd: number;
  signature?: string;
}

export interface SwapOrder {
  transaction: string | null;
  requestId: string;
  inAmount?: string;
  outAmount: string;
  router?: string;
  mode?: string;
  feeBps?: number;
  feeMint?: string;
  errorCode?: number;
  errorMessage?: string;
}
