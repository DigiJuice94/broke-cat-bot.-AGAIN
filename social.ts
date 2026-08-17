import { config } from "./config.ts";
import { DiscoveredToken, SocialIntelSnapshot } from "./types.ts";
import { log } from "./log.ts";
import { socialPerformance } from "./socialPerformance.ts";

const STOP = new Set(["the","and","for","with","this","that","from","your","you","are","was","have","has","will","just","but","not","all","our","out","new","now","into","its","they","their","about","https","http","com","www","token","coin","crypto","solana","pump","fun"]);
const WATCH = [
  {username:"blknoiz06", label:"Ansem", weight:1.15},
  {username:"slingoorio", label:"sling", weight:1.00},
  {username:"cobie", label:"Cobie", weight:1.20},
  {username:"cz_binance", label:"CZ", weight:1.15},
  {username:"PoorGoat", label:"PoorGoat", weight:1.00},
  {username:"Pumpfun", label:"Pump.fun", weight:1.25},
];

type XPost={id:string;text:string;author_id?:string;created_at?:string;public_metrics?:{like_count?:number;retweet_count?:number;reply_count?:number;quote_count?:number}};
type StoredPost=XPost & {username:string;label:string;baseWeight:number;fetchedAt:number};

const clamp=(v:number,a=0,b=100)=>Math.max(a,Math.min(b,v));
const norm=(s:string)=>s.toLowerCase().replace(/[^a-z0-9$]+/g," ").trim();

export class SocialIntel {
  private posts:StoredPost[]=[];
  private lastPoll=0;
  private meta:string[]=[];
  private newestId="";
  private operational=false;
  private consecutiveFailures=0;
  configured(){return Boolean(config.xBearerToken);}
  enabled(){return this.configured() && this.operational;}
  watchlist(){return WATCH.map(x=>x.label).join(", ");}
  currentMeta(){return this.meta;}

  private engagement(p:XPost){const m=p.public_metrics??{};return (m.like_count??0)+(m.retweet_count??0)*3+(m.reply_count??0)*2+(m.quote_count??0)*4;}
  private computeMeta(){
    const counts=new Map<string,number>(); const now=Date.now();
    for(const p of this.posts){const ageMin=Math.max(1,(now-p.fetchedAt)/60000);const decay=Math.max(.2,1-ageMin/config.socialLookbackMin);const words=norm(p.text).split(/\s+/).filter(w=>w.length>=4&&!STOP.has(w)&&!w.startsWith("http")&&!/^\d+$/.test(w));
      for(const w of new Set(words))counts.set(w,(counts.get(w)??0)+p.baseWeight*decay);}
    this.meta=[...counts.entries()].sort((a,b)=>b[1]-a[1]).slice(0,config.metaTopTerms).map(([w])=>w);
  }

  async poll(){
    if(!this.configured()||Date.now()-this.lastPoll<config.socialPollMs)return;
    this.lastPoll=Date.now();
    const query=`(${WATCH.map(x=>`from:${x.username}`).join(" OR ")}) -is:retweet`;
    const q=new URLSearchParams({query,"tweet.fields":"created_at,public_metrics,author_id","expansions":"author_id","user.fields":"username,verified","max_results":"100"});
    if(this.newestId)q.set("since_id",this.newestId);
    try{
      const r=await fetch(`https://api.x.com/2/tweets/search/recent?${q}`,{headers:{Authorization:`Bearer ${config.xBearerToken}`},signal:AbortSignal.timeout(config.socialTimeoutMs)});
      if(!r.ok)throw new Error(`X ${r.status} ${await r.text()}`);
      const j:any=await r.json(); const users=new Map<string,string>((j.includes?.users??[]).map((u:any)=>[String(u.id),String(u.username)]));
      const added:StoredPost[]=[];
      for(const p of (j.data??[]) as XPost[]){const username=users.get(String(p.author_id))??"";const w=WATCH.find(x=>x.username.toLowerCase()===username.toLowerCase());if(!w)continue;added.push({...p,username:w.username,label:w.label,baseWeight:w.weight,fetchedAt:(p.created_at?Date.parse(p.created_at):Date.now())});}
      if(j.meta?.newest_id)this.newestId=String(j.meta.newest_id);
      this.operational=true;
      this.consecutiveFailures=0;
      this.posts=[...added,...this.posts].filter(p=>Date.now()-p.fetchedAt<=config.socialLookbackMin*60000).slice(0,500);
      this.computeMeta();
      if(added.length)log.info(`[SOCIAL] +${added.length} watchlist posts | META: ${this.meta.slice(0,5).join(" / ")||"forming"}`);
    }catch(e){
      this.consecutiveFailures++;
      this.operational=false;
      log.warn(`[SOCIAL] X unavailable (${this.consecutiveFailures} failure${this.consecutiveFailures===1?"":"s"}) — social weighting bypassed; market + safety scoring remains active. ${e instanceof Error?e.message:String(e)}`);
    }
  }

  discoveredTokens():DiscoveredToken[]{
    const out=new Map<string,DiscoveredToken>(); const now=Date.now();
    for(const p of this.posts){
      const addrs=p.text.match(/\b[1-9A-HJ-NP-Za-km-z]{32,44}\b/g)??[];
      for(const address of addrs){if(address.length<32||address.length>44)continue; const tick=(p.text.match(/\$([A-Za-z][A-Za-z0-9]{1,14})/)??[])[1]??"?";
        out.set(address,{address,name:tick==="?"?"Social Callout":tick,symbol:tick,source:"social-watchlist",rank:1,discoveredAt:now});}
    }
    return [...out.values()];
  }

  scoreToken(name:string,symbol:string):SocialIntelSnapshot{
    if(!this.enabled())return {enabled:false,score:0,mentions:0,weightedMentions:0,keyAccounts:[],pumpFun:false,metaMatch:false,dominantMeta:this.meta.slice(0,5)};
    const now=Date.now(), sym=symbol.toLowerCase().replace(/^\$/,""), nm=norm(name);let weighted=0,mentions=0;const accounts=new Set<string>();let pumpFun=false,eng=0,recent=0;
    for(const p of this.posts){const text=norm(p.text);const direct=(sym.length>1&&(text.includes(`$${sym}`)||new RegExp(`(^| )${sym}( |$)`).test(text)))||(nm.length>3&&text.includes(nm));if(!direct)continue;
      const ageMin=Math.max(.25,(now-p.fetchedAt)/60000);const decay=Math.max(.15,1-ageMin/config.socialLookbackMin);mentions++;recent+=ageMin<=10?1:0;weighted+=p.baseWeight*socialPerformance.multiplier(p.label)*decay;eng+=Math.log10(1+this.engagement(p));accounts.add(p.label);if(p.username.toLowerCase()==="pumpfun")pumpFun=true;}
    const metaMatch=this.meta.some(t=>sym.includes(t)||nm.includes(t));
    let score=weighted*22+Math.min(18,eng*3)+Math.min(18,recent*6)+Math.min(15,Math.max(0,accounts.size-1)*7)+(pumpFun?12:0)+(metaMatch?10:0);
    score=clamp(score);
    return {enabled:true,score,mentions,weightedMentions:weighted,keyAccounts:[...accounts],pumpFun,metaMatch,dominantMeta:this.meta.slice(0,5)};
  }
}
