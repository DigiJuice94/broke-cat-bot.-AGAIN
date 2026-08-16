const price = (n?: number) => n == null ? "?" : n >= 1 ? `$${n.toFixed(4)}` : `$${n.toPrecision(5)}`;

export const log = {
  info: (...x: unknown[]) => console.log(new Date().toISOString(), ...x),
  warn: (...x: unknown[]) => console.warn(new Date().toISOString(), ...x),
  error: (...x: unknown[]) => console.error(new Date().toISOString(), ...x),
  scan(data: {
    name: string; symbol: string; priceUsd?: number; score: number; confidence: number;
    status: string; reason?: string; sources?: string[]; rankText?: string;
  }) {
    const src = data.sources?.length ? ` Sources:${data.sources.join("+")}` : "";
    const rank = data.rankText ? ` Trend:${data.rankText}` : "";
    console.log(
      `${new Date().toISOString()} [SCAN] ${data.name} ($${data.symbol}) | Price:${price(data.priceUsd)} | Score:${Math.round(data.score)}/100 | Data:${Math.round(data.confidence)}% | ${data.status}${src}${rank}${data.reason ? ` | ${data.reason}` : ""}`
    );
  }
};
