const price = (n?: number) => n == null ? "?" : n >= 1 ? `$${n.toFixed(4)}` : `$${n.toPrecision(5)}`;

export const log = {
  info: (...x: unknown[]) => console.log(new Date().toISOString(), ...x),
  warn: (...x: unknown[]) => console.warn(new Date().toISOString(), ...x),
  error: (...x: unknown[]) => console.error(new Date().toISOString(), ...x),
  scan(data: {
    name: string; symbol: string; priceUsd?: number; score: number; confidence: number;
    status: string; reason?: string; sources?: string[]; rankText?: string;
    details?: { buys1m?: number; sells1m?: number; volume1mUsd?: number; liquidityUsd?: number; holderCount?: number; uniqueWallet1m?: number; chainTx10s?: number; chainTx30s?: number; chainTx1m?: number; top10HolderPct?: number; heliusStatus?: string };
  }) {
    const src = data.sources?.length ? ` Sources:${data.sources.join("+")}` : "";
    const rank = data.rankText ? ` Trend:${data.rankText}` : "";
    const d = data.details;
    const detail = d ? ` | 1m B/S:${d.buys1m ?? "?"}/${d.sells1m ?? "?"} Vol:${d.volume1mUsd == null ? "?" : `$${Math.round(d.volume1mUsd)}`} Liq:${d.liquidityUsd == null ? "?" : `$${Math.round(d.liquidityUsd)}`} Holders:${d.holderCount ?? "?"} HeliusTx:10s=${d.chainTx10s ?? "?"},30s=${d.chainTx30s ?? "?"},1m=${d.chainTx1m ?? "?"} Wallets:${d.uniqueWallet1m ?? "?"} Top10:${d.top10HolderPct == null ? "?" : `${d.top10HolderPct.toFixed(1)}%`} Helius:${d.heliusStatus ?? "off"}` : "";
    console.log(
      `${new Date().toISOString()} [SCAN] ${data.name} ($${data.symbol}) | Price:${price(data.priceUsd)} | Score:${Math.round(data.score)}/100 | Data:${Math.round(data.confidence)}% | ${data.status}${src}${rank}${detail}${data.reason ? ` | ${data.reason}` : ""}`
    );
  }
};
