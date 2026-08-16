import { config } from "./config.js";
import { getJson } from "./http.js";

export async function bundleRisk(address: string): Promise<{status:"ok"|"unknown"|"error"; risk?:number}> {
  if (!config.bundleApiUrl) return { status: "unknown" };
  try {
    const url = config.bundleApiUrl.includes("{mint}")
      ? config.bundleApiUrl.replace("{mint}", encodeURIComponent(address))
      : `${config.bundleApiUrl}${config.bundleApiUrl.includes("?") ? "&" : "?"}address=${encodeURIComponent(address)}`;
    const headers: Record<string,string> = { accept: "application/json" };
    if (config.bundleApiKey) headers.authorization = `Bearer ${config.bundleApiKey}`;
    const j = await getJson(url, headers, 9000);
    const d = j?.data ?? j;
    let risk = Number(d?.riskScore ?? d?.risk ?? d?.bundlePercent ?? d?.bundledPercent);
    if (!Number.isFinite(risk)) return { status: "unknown" };
    if (risk <= 1) risk *= 100;
    return { status: "ok", risk: Math.max(0, Math.min(100, risk)) };
  } catch { return { status: "error" }; }
}
