import { log } from "./log.ts";

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

export class RequestQueue {
  private chain: Promise<unknown> = Promise.resolve();
  private lastStart = 0;
  private backoffUntil = 0;

  constructor(private name: string, private minIntervalMs: number, private maxRetries = 2) {}

  schedule<T>(fn: () => Promise<T>): Promise<T> {
    const run = async (): Promise<T> => {
      const now = Date.now();
      const waitForRate = Math.max(0, this.lastStart + this.minIntervalMs - now);
      const waitForBackoff = Math.max(0, this.backoffUntil - now);
      const wait = Math.max(waitForRate, waitForBackoff);
      if (wait > 0) await sleep(wait);
      this.lastStart = Date.now();

      let attempt = 0;
      while (true) {
        try {
          return await fn();
        } catch (e) {
          const msg = e instanceof Error ? e.message : String(e);
          const rateLimited = /(^|\s)429(\s|$)|too many requests/i.test(msg);
          if (!rateLimited || attempt >= this.maxRetries) throw e;
          attempt += 1;
          const backoff = Math.min(8_000, 1_000 * (2 ** attempt)) + Math.floor(Math.random() * 350);
          this.backoffUntil = Date.now() + backoff;
          log.warn(`[RATE] ${this.name} 429 — backing off ${backoff}ms (retry ${attempt}/${this.maxRetries})`);
          await sleep(backoff);
          this.lastStart = Date.now();
        }
      }
    };

    const result = this.chain.then(run, run) as Promise<T>;
    this.chain = result.then(() => undefined, () => undefined);
    return result;
  }
}
