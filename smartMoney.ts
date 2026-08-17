import { Birdeye } from "./birdeye.ts";
import { SmartMoneySnapshot } from "./types.ts";
export class SmartMoneyIntel {
  constructor(private birdeye:Birdeye){}
  async inspect(address:string):Promise<SmartMoneySnapshot>{return this.birdeye.topTraderIntel(address);}
}
