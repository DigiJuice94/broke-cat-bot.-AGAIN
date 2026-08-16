const price=(n?:number)=>n==null?"?":n>=1?`$${n.toFixed(4)}`:`$${n.toPrecision(5)}`;
export const log={
  info:(...x:unknown[])=>console.log(new Date().toISOString(),...x),warn:(...x:unknown[])=>console.warn(new Date().toISOString(),...x),error:(...x:unknown[])=>console.error(new Date().toISOString(),...x),
  scan(data:{name:string;symbol:string;priceUsd?:number;score:number;confidence:number;status:string;reason?:string;sources?:string[];rankText?:string;details?:{
    buys1m?:number;sells1m?:number;buys5m?:number;sells5m?:number;volume1mUsd?:number;volume5mUsd?:number;liquidityUsd?:number;holderCount?:number;uniqueWallet1m?:number;
    chainTx10s?:number;chainTx30s?:number;chainTx1m?:number;top10HolderPct?:number;heliusStatus?:string;deep?:string}}){
    const src=data.sources?.length?` Sources:${data.sources.join("+")}`:"",rank=data.rankText?` Trend:${data.rankText}`:"",d=data.details;
    const buys=d?.buys1m??d?.buys5m,sells=d?.sells1m??d?.sells5m,flowWindow=(d?.buys1m!=null||d?.sells1m!=null)?"1m":"5m";
    const vol=d?.volume1mUsd??d?.volume5mUsd;
    const detail=d?` | B/S(${flowWindow}):${buys??"?"}/${sells??"?"} Vol:${vol==null?"?":`$${Math.round(vol)}`} Liq:${d.liquidityUsd==null?"?":`$${Math.round(d.liquidityUsd)}`} Holders:${d.holderCount??"?"} HeliusTx:10s=${d.chainTx10s??"?"},30s=${d.chainTx30s??"?"},1m=${d.chainTx1m??"?"} Top10:${d.top10HolderPct==null?"?":`${d.top10HolderPct.toFixed(1)}%`} Helius:${d.heliusStatus??"off"}${d.deep?` Deep:${d.deep}`:""}`:"";
    console.log(`${new Date().toISOString()} [SCAN] ${data.name} ($${data.symbol}) | Price:${price(data.priceUsd)} | Score:${Math.round(data.score)}/100 | Data:${Math.round(data.confidence)}% | ${data.status}${src}${rank}${detail}${data.reason?` | ${data.reason}`:""}`);
  }
};
