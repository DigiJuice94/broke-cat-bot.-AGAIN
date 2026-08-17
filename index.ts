import { Birdeye } from "./birdeye.ts";
import { Jupiter } from "./jupiter.ts";
import { config } from "./config.ts";
import { Scanner } from "./scanner.ts";
import { Trader } from "./trader.ts";
import { WalletService } from "./wallet.ts";
import { log } from "./log.ts";
const sleep=(ms:number)=>new Promise(r=>setTimeout(r,ms));

async function main(){
  const wallet=new WalletService(),birdeye=new Birdeye(),jupiter=new Jupiter(wallet),trader=new Trader(wallet,jupiter);
  const scanner=new Scanner(birdeye,jupiter,c=>trader.buy(c));
  log.info("🐱 BROKE CAT BOT v2.2.0 — META RADAR + SMART MONEY + ADAPTIVE EXITS");
  log.info(`Mode: ${config.liveTrading?"🔴 LIVE":"🟡 PAPER / SCAN"}`); log.info(`Wallet: ${wallet.address??"NOT CONFIGURED"}`);
  log.info(`Observation: ${config.minObservationMs/1000}-${config.maxObservationMs/1000}s | Buy score ≥${config.buyScore} | Data ≥${config.minDataConfidence}%`);
  log.info(`Discovery: Social watchlist + Mobula Axiom-style + Birdeye + DEX | META RUNNER aware`);
  log.info(`Social: ${config.xBearerToken?"OPTIONAL X CONFIGURED":"OFF — no X funding/token required"} | watchlist Ansem, sling, Cobie, CZ, PoorGoat, Pump.fun | 40/40/20 only while X is actually responding`);
  log.info(`Exits: adaptive soft -${config.softStopLossPct}% when momentum fails | hard -${config.hardStopLossPct}% | executable Jupiter protection stays active`);
  log.info(`Mobula Axiom-style: ${config.mobulaApiKey?"ON":"OFF — add MOBULA_API_KEY"} | interval ${Math.round(config.mobulaTrendingIntervalMs/1000)}s`);
  log.info(`Birdeye: new ${Math.round(config.birdeyeNewIntervalMs/60000)}m | trending ${Math.round(config.birdeyeTrendingIntervalMs/60000)}m | deep top ${config.birdeyeDeepCandidates} at score ≥${config.birdeyeDeepMinScore} | CU budget ${config.birdeyeCuBudgetPerHour}/hr`);
  log.info(`Sizing: dynamic, minimum $${config.minPositionUsd}, NO MAX POSITION CAP | SOL reserve ${config.solFeeReserve}`);
  log.info(`SOL/USD: background cache | Coinbase → DEX Screener → Jupiter emergency fallback | refresh ${Math.round(config.solUsdRefreshMs/1000)}s`);
  if(!config.xBearerToken)log.warn("X_BEARER_TOKEN missing — expected/OK. Social/meta layer is skipped and scoring automatically reweights to 80% market / 20% safety.");
  if(!config.mobulaApiKey)log.warn("MOBULA_API_KEY missing — popular Axiom-style runner discovery unavailable; bot will use fallbacks.");
  if(!config.birdeyeApiKey)log.warn("BIRDEYE_API_KEY missing — Birdeye discovery/deep enrichment unavailable.");
  if(!config.jupiterApiKey)log.warn("JUPITER_API_KEY missing — route verification/trading unavailable.");
  if(config.liveTrading&&!wallet.address)throw new Error("LIVE_TRADING=true but wallet private key is missing");
  await trader.warmSolPrice();
  let lastPositionPoll=0;
  while(true){try{await scanner.tick();}catch(e){log.error("[LOOP]",e);}if(Date.now()-lastPositionPoll>=config.positionPollMs){lastPositionPoll=Date.now();try{await trader.monitorPositions();}catch(e){log.error("[POSITIONS]",e);}}await sleep(config.observationTickMs);}
}
main().catch(e=>{console.error(e);process.exit(1);});
