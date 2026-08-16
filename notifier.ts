import { config } from "./config.ts";
import { log } from "./log.ts";

type NotifyOptions = {
  title: string;
  message: string;
  priority?: "min" | "low" | "default" | "high" | "max";
  tags?: string[];
};

export class Notifier {
  get enabled() {
    return Boolean(config.ntfyTopic);
  }

  async send({ title, message, priority = "default", tags = [] }: NotifyOptions) {
    if (!this.enabled) return;
    const base = config.ntfyServer.replace(/\/$/, "");
    const url = `${base}/${encodeURIComponent(config.ntfyTopic)}`;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), config.ntfyTimeoutMs);
    try {
      const headers: Record<string, string> = {
        "Content-Type": "text/plain; charset=utf-8",
        "Title": title,
        "Priority": priority,
      };
      if (tags.length) headers["Tags"] = tags.join(",");
      if (config.ntfyToken) headers["Authorization"] = `Bearer ${config.ntfyToken}`;

      const res = await fetch(url, {
        method: "POST",
        headers,
        body: message,
        signal: controller.signal,
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
    } catch (e) {
      // Alerts are never allowed to interrupt trading.
      log.warn(`[NTFY] alert failed: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      clearTimeout(timeout);
    }
  }
}
