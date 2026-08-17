import { config } from "./config.ts";
import { DiscoveredToken, Snapshot } from "./types.ts";
import { postJson } from "./http.ts";
import { log } from "./log.ts";

const n=(...xs:any[]):number|undefined=>{for(const x of xs){if(x===null||x===undefined||x==="")continue;const v=Number(x);if(Number.isFinite(v))return v;}return undefined;};

function rowsForView(raw:any, view:string):any[]{
  const candidates=[raw?.[view],raw?.data?.[view],raw?.views?.[view],raw?.data?.views?.[view],raw?.result?.[view],raw?.data?.result?.[view]];
  for(const c of candidates){
    if(Array.isArray(c)) return c;
    if(Array.isArray(c?.data)) return c.data;
    if(Array.isArray(c?.tokens)) return c.tokens;
    if(Array.isArray(c?.items)) return c.items;
  }
  // Defensive fallback: some API envelopes return an array of named view objects.
  const arrays=[raw?.data,raw?.views,raw?.result];
  for(const a of arrays){
    if(!Array.isArray(a))continue;
    const found=a.find((x:any)=>x?.name===view||x?.view===view||x?.viewName===view);
    if(Array.isArray(found?.data))return found.data;
    if(Array.isArray(found?.tokens))return found.tokens;
    if(Array.isArray(found?.items))return found.items;
  }
  return [];
}

function toToken(row:any, source:DiscoveredToken["source"], rank:number):DiscoveredToken|null{
  const t=row?.token??row?.asset??row;
  const address=t?.address??row?.address??row?.tokenAddress??row?.token_address;
  if(!address)return null;
  const top10=n(t?.top10HoldingsPercentage,row?.top10HoldingsPercentage,row?.top_10_holdings_percentage);
  const bundlers=n(t?.bundlersHoldingsPercentage,row?.bundlersHoldingsPercentage,row?.bundlers_holdings_percentage);
  const seed:Partial<Snapshot>={
    priceUsd:n(row?.latest_price,row?.latestPrice,t?.price),
    liquidityUsd:n(t?.liquidity,row?.liquidity),
    marketCapUsd:n(row?.market_cap,row?.latest_market_cap,t?.marketCap,t?.market_cap),
    volume1mUsd:n(row?.organic_volume_1min,row?.volume_1min),
    volume5mUsd:n(row?.organic_volume_5min,row?.volume_5min),
    buys1m:n(row?.organic_buys_1min,row?.buys_1min),
    sells1m:n(row?.organic_sells_1min,row?.sells_1min),
    buys5m:n(row?.organic_buys_5min,row?.buys_5min),
    sells5m:n(row?.organic_sells_5min,row?.sells_5min),
    buyVolume1mUsd:n(row?.organic_volume_buy_1min,row?.volume_buy_1min),
    sellVolume1mUsd:n(row?.organic_volume_sell_1min,row?.volume_sell_1min),
    priceChange1mPct:n(row?.price_change_1min,row?.priceChange1min),
    priceChange5mPct:n(row?.price_change_5min,row?.priceChange5min),
    uniqueWallet1m:n(row?.organic_buyers_1min,row?.buyers_1min),
    holderCount:n(t?.holdersCount,row?.holdersCount,row?.holders_count),
    top10HolderPct:top10,
    bundleRisk:bundlers,
  };
  return {
    address,
    name:t?.name??row?.name??"Unknown",
    symbol:t?.symbol??row?.symbol??"?",
    decimals:n(t?.decimals,row?.decimals),
    source,
    rank,
    discoveredAt:Date.now(),
    listedAt: t?.createdAt ? Date.parse(t.createdAt) : row?.created_at ? Date.parse(row.created_at) : undefined,
    seed,
  };
}

export class MobulaAxiomDiscovery {
  private lastFetch=0;
  private cached:DiscoveredToken[]=[];
  private warnedMissing=false;

  enabled(){return Boolean(config.mobulaApiKey);}

  async trending():Promise<DiscoveredToken[]>{
    if(!this.enabled()){
      if(!this.warnedMissing){this.warnedMissing=true;log.warn("MOBULA_API_KEY missing — Axiom-style trending lane disabled; fallback discovery remains active.");}
      return [];
    }
    const now=Date.now();
    if(this.cached.length && now-this.lastFetch<config.mobulaTrendingIntervalMs)return this.cached;
    this.lastFetch=now;
    const lim=Math.max(5,Math.min(50,config.mobulaTrendingLimit));
    const payload={
      assetMode:true,
      views:[
        {
          name:"axiom-volume",
          chainId:["solana:solana"],
          sortBy:"volume_1h",
          sortOrder:"desc",
          limit:lim,
          filters:{
            volume_1h:{gte:config.mobulaMinVolume1hUsd},
            liquidity:{gte:config.mobulaMinLiquidityUsd},
            dexscreener_listed:true
          }
        },
        {
          name:"axiom-price",
          chainId:["solana:solana"],
          sortBy:"price_change_1h",
          sortOrder:"desc",
          limit:Math.min(20,lim),
          filters:{
            price_change_1h:{gte:config.mobulaMinPriceChange1hPct},
            volume_1h:{gte:Math.max(1000,config.mobulaMinVolume1hUsd/2)},
            liquidity:{gte:config.mobulaMinLiquidityUsd},
            dexscreener_listed:true
          }
        }
      ]
    };
    try{
      const raw=await postJson(config.mobulaPulseUrl,payload,{Authorization:config.mobulaApiKey,accept:"application/json"},config.mobulaTimeoutMs);
      const out:DiscoveredToken[]=[];
      const seen=new Set<string>();
      const add=(rows:any[],source:DiscoveredToken["source"])=>rows.forEach((r,i)=>{const t=toToken(r,source,i+1);if(t&&!seen.has(`${source}:${t.address}`)){seen.add(`${source}:${t.address}`);out.push(t);}});
      add(rowsForView(raw,"axiom-volume"),"mobula-axiom-volume");
      add(rowsForView(raw,"axiom-price"),"mobula-axiom-price");
      if(!out.length)log.warn("[MOBULA] Pulse returned no Axiom-style tokens; verify plan/key or response shape.");
      else log.info(`[MOBULA] Axiom-style trending: ${out.length} ranked signals received`);
      this.cached=out;
      return out;
    }catch(e){
      log.warn(`[MOBULA] Axiom-style trending unavailable: ${e instanceof Error?e.message:String(e)}`);
      return this.cached;
    }
  }
}
