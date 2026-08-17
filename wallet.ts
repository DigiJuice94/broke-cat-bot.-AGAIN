import bs58 from "bs58";
import { Connection, Keypair, PublicKey, VersionedTransaction } from "@solana/web3.js";
import { getAssociatedTokenAddressSync, TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID } from "@solana/spl-token";
import { config, LAMPORTS_PER_SOL } from "./config.ts";

export class WalletService {
  readonly connection = new Connection(config.rpcUrl, "confirmed");
  readonly keypair: Keypair | null;

  constructor() {
    this.keypair = this.loadKeypair(config.privateKey);
  }

  private loadKeypair(raw: string): Keypair | null {
    if (!raw.trim()) return null;
    try {
      const s = raw.trim();
      const bytes = s.startsWith("[") ? new Uint8Array(JSON.parse(s)) : bs58.decode(s);
      return Keypair.fromSecretKey(bytes);
    } catch (e) {
      throw new Error(`Invalid BS58_PRIVATE_KEY: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  get address(): string | null { return this.keypair?.publicKey.toBase58() ?? null; }

  async solBalance(): Promise<number> {
    if (!this.keypair) return 0;
    return (await this.connection.getBalance(this.keypair.publicKey, "confirmed")) / LAMPORTS_PER_SOL;
  }

  async tokenBalanceRaw(mint: string): Promise<{amount: bigint; decimals: number}> {
    if (!this.keypair) return { amount: 0n, decimals: 0 };
    const mintPk = new PublicKey(mint);
    const ata = getAssociatedTokenAddressSync(mintPk, this.keypair.publicKey, true);
    try {
      const b = await this.connection.getTokenAccountBalance(ata, "confirmed");
      return { amount: BigInt(b.value.amount), decimals: b.value.decimals };
    } catch { return { amount: 0n, decimals: 0 }; }
  }

  async tokenHoldingsRaw(): Promise<Array<{mint:string;amount:bigint;decimals:number}>> {
    if (!this.keypair) return [];
    const groups = await Promise.all([
      this.connection.getParsedTokenAccountsByOwner(this.keypair.publicKey, { programId: TOKEN_PROGRAM_ID }, "confirmed"),
      this.connection.getParsedTokenAccountsByOwner(this.keypair.publicKey, { programId: TOKEN_2022_PROGRAM_ID }, "confirmed")
    ]);
    const out:Array<{mint:string;amount:bigint;decimals:number}>=[];
    for (const row of groups.flatMap(g=>g.value)) {
      const info:any = (row.account.data as any).parsed?.info;
      const amount = BigInt(info?.tokenAmount?.amount ?? "0");
      if (amount <= 0n) continue;
      out.push({ mint:String(info.mint), amount, decimals:Number(info?.tokenAmount?.decimals ?? 0) });
    }
    return out;
  }

  async transactionFeeLamports(signature: string): Promise<number> {
    for (let i=0;i<4;i++) {
      try {
        const tx = await this.connection.getTransaction(signature, { commitment:"confirmed", maxSupportedTransactionVersion:0 });
        if (tx?.meta?.fee != null) return tx.meta.fee;
      } catch {}
      await new Promise(r=>setTimeout(r, 400));
    }
    return 0;
  }

  signBase64Transaction(txBase64: string): string {
    if (!this.keypair) throw new Error("Wallet private key not configured");
    const tx = VersionedTransaction.deserialize(Buffer.from(txBase64, "base64"));
    tx.sign([this.keypair]);
    return Buffer.from(tx.serialize()).toString("base64");
  }
}
