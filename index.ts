import { Birdeye } from "./birdeye.ts";
import { Jupiter } from "./jupiter.ts";
import { config } from "./config.ts";
import { Scanner } from "./scanner.ts";
import { Trader } from "./trader.ts";
import { WalletService } from "./wallet.ts";
import { log } from "./log.ts";
const sleep=(ms:number)=>new Promise(r=>setTimeout(r,ms));

async function main(){
  const wallet=new WalletService(),birdeye=new Birdeye(),jupiter=new Jupiter(wallet),trader=new Trader(wallet,birdeye,jupiter);
  const scanner=new Scanner(birdeye,jupiter,c=>trader.buy(c));
  log.info("🐱 BROKE CAT BOT v1.3 — SIMPLE EFFICIENT");
  log.info(`Mode: ${config.liveTrading?"🔴 LIVE":"🟡 PAPER / SCAN"}`); log.info(`Wallet: ${wallet.address??"NOT CONFIGURED"}`);
  log.info(`Observation: ${config.minObservationMs/1000}-${config.maxObservationMs/1000}s | Buy score ≥${config.buyScore} | Data ≥${config.minDataConfidence}%`);
  log.info(`Data stack: DEX Screener batch + Birdeye queued/cache + Jupiter finalists`);
  log.info(`Birdeye pacing: ${config.birdeyeMinIntervalMs}ms | deep top ${config.birdeyeDeepCandidates} | routes top ${config.routeDeepCandidates}`);
  log.info(`Sizing: dynamic, minimum $${config.minPositionUsd}, NO MAX POSITION CAP | SOL reserve ${config.solFeeReserve}`);
  if(!config.birdeyeApiKey)log.warn("BIRDEYE_API_KEY missing — Birdeye discovery/deep enrichment unavailable.");
  if(!config.jupiterApiKey)log.warn("JUPITER_API_KEY missing — route verification/trading unavailable.");
  if(config.liveTrading&&!wallet.address)throw new Error("LIVE_TRADING=true but wallet private key is missing");
  let lastPositionPoll=0;
  while(true){try{await scanner.tick();}catch(e){log.error("[LOOP]",e);}if(Date.now()-lastPositionPoll>=config.positionPollMs){lastPositionPoll=Date.now();try{await trader.monitorPositions();}catch(e){log.error("[POSITIONS]",e);}}await sleep(config.observationTickMs);}
}
main().catch(e=>{console.error(e);process.exit(1);});
