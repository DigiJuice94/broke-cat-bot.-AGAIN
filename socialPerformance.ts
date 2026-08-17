type Stat={samples:number;wins:number;sumReturn:number};
class SocialPerformance {
  private stats=new Map<string,Stat>();
  multiplier(label:string){
    const s=this.stats.get(label); if(!s||s.samples<3)return 1;
    const win=s.wins/s.samples, avg=s.sumReturn/s.samples;
    return Math.max(.65,Math.min(1.45,.75+win*.45+Math.max(-.15,Math.min(.25,avg/100))));
  }
  record(labels:string[],returnPct:number){
    for(const label of labels){const s=this.stats.get(label)??{samples:0,wins:0,sumReturn:0};s.samples++;if(returnPct>0)s.wins++;s.sumReturn+=returnPct;this.stats.set(label,s);}
  }
  text(label:string){const s=this.stats.get(label);if(!s)return "new";return `${s.wins}/${s.samples} win ${(s.samples?s.sumReturn/s.samples:0).toFixed(1)}% avg`;}
}
export const socialPerformance=new SocialPerformance();
