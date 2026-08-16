import { config, SOL_MINT } from "./config.js";
import { SwapOrder } from "./types.js";
import { getJson, postJson } from "./http.js";
import { WalletService } from "../wallet.js";

const BASE = "https://api.jup.ag/swap/v2";
const headers = () => ({ "x-api-key": config.jupiterApiKey, accept: "application/json" });

export class Jupiter {
  constructor(private wallet: WalletService) {}

  async order(inputMint: string, outputMint: string, amountRaw: bigint, withTransaction: boolean): Promise<SwapOrder> {
    if (!config.jupiterApiKey) throw new Error("Missing JUPITER_API_KEY");
    const q = new URLSearchParams({ inputMint, outputMint, amount: amountRaw.toString() });
    if (withTransaction && this.wallet.address) q.set("taker", this.wallet.address);
    return await getJson(`${BASE}/order?${q}`, headers(), 10_000) as SwapOrder;
  }

  async canBuyAndSell(mint: string, solLamports = 5_000_000n): Promise<{buy:boolean;sell:boolean;quality:number;buyOutRaw?:bigint}> {
    try {
      const buy = await this.order(SOL_MINT, mint, solLamports, false);
      const out = BigInt(buy.outAmount || "0");
      if (out <= 0n) return { buy: false, sell: false, quality: 0 };
      try {
        const sell = await this.order(mint, SOL_MINT, out, false);
        const back = BigInt(sell.outAmount || "0");
        const quality = Number(back * 10000n / solLamports) / 100;
        return { buy: true, sell: back > 0n, quality: Math.max(0, Math.min(100, quality)), buyOutRaw: out };
      } catch { return { buy: true, sell: false, quality: 20, buyOutRaw: out }; }
    } catch { return { buy: false, sell: false, quality: 0 }; }
  }

  async swap(inputMint: string, outputMint: string, amountRaw: bigint): Promise<{signature:string;inRaw:bigint;outRaw:bigint}> {
    if (!config.liveTrading) throw new Error("LIVE_TRADING=false");
    if (!this.wallet.address) throw new Error("Wallet is not configured");
    const order = await this.order(inputMint, outputMint, amountRaw, true);
    if (!order.transaction) throw new Error(`No executable Jupiter transaction: ${order.errorCode ?? "?"} ${order.errorMessage ?? ""}`);
    const signedTransaction = this.wallet.signBase64Transaction(order.transaction);
    const result = await postJson(`${BASE}/execute`, { signedTransaction, requestId: order.requestId }, headers(), 25_000);
    if (result.status !== "Success" || Number(result.code) !== 0) throw new Error(`Jupiter execute failed: ${JSON.stringify(result)}`);
    return {
      signature: result.signature,
      inRaw: BigInt(result.totalInputAmount ?? amountRaw.toString()),
      outRaw: BigInt(result.totalOutputAmount ?? order.outAmount)
    };
  }
}
