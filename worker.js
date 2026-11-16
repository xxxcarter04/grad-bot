import {DurableObject} from 'cloudflare:workers';
const MIN_SOL=50,STEPS=[2,3,5,10,20,50,100];
const WSOL='So11111111111111111111111111111111111111112';
const PAMM='pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA';
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
const esc=s=>String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
const money=n=>n>=1e6?'$'+(n/1e6).toFixed(2)+'M':n>=1e3?'$'+(n/1e3).toFixed(1)+'K':'$'+Math.round(n);
const safe=u=>/^https?:\/\//.test(u||'')?esc(u).replace(/"/g,'&quot;'):'';
const liq=x=>(x.liquidity&&x.liquidity.usd)||0;
const links=m=>'<a href="https://dexscreener.com/solana/'+m+'">DexScreener</a> | <a href="https://pump.fun/coin/'+m+'">Pump.fun</a>';
const rpc=(env,method,params)=>fetch('https://mainnet.helius-rpc.com/?api-key='+env.HELIUS_KEY,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({jsonrpc:'2.0',id:1,method,params})}).then(r=>r.json()).then(j=>j.result);
const tg=(env,text)=>Promise.all(String(env.TG_CHAT).split(',').map(c=>fetch('https://api.telegram.org/bot'+env.TG_TOKEN+'/sendMessage',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({chat_id:c.trim(),text,parse_mode:'HTML',link_preview_options:{is_disabled:true}})})));
const store=env=>env.TRACK.get(env.TRACK.idFromName('main'));
export class Tracker extends DurableObject{
  async add(r){await this.ctx.storage.put('t:'+r.mint,r)}
  async list(){return [...(await this.ctx.storage.list({prefix:'t:'})).values()]}
  async del(m){await this.ctx.storage.delete('t:'+m)}
}
async function solUsd(){
  try{const a=await(await fetch('https://api.dexscreener.com/tokens/v1/solana/'+WSOL)).json();const b=a.filter(x=>x.priceUsd).sort((x,y)=>liq(y)-liq(x))[0];return b?Number(b.priceUsd):0}catch(e){return 0}
}
async function socials(a){
  try{const u=a&&a.content&&a.content.json_uri;if(!u)return {};const j=await(await fetch(u,{signal:AbortSignal.timeout(4000)})).json();return {tw:j.twitter,web:j.website,tgm:j.telegram}}catch(e){return {}}
}
async function handle(env,sig){
  let tx=null;
  for(let i=0;i<3&&!tx;i++){
    tx=await rpc(env,'getTransaction',[sig,{encoding:'jsonParsed',maxSupportedTransactionVersion:0,commitment:'confirmed'}]).catch(()=>null);
    if(!tx)await sleep(1000);
  }
  if(!tx||!tx.meta||tx.meta.err)return;
  const logs=tx.meta.logMessages||[];
  if(!(logs.some(l=>/Instruction: Migrate(V\d+)?$/.test(l))&&logs.some(l=>l.includes(PAMM))))return;
  const post=tx.meta.postTokenBalances||[];
  const mints=[...new Set(post.concat(tx.meta.preTokenBalances||[]).map(b=>b.mint))];
  const mint=mints.find(m=>m&&m.endsWith('pump'));
  if(!mint)return;
  const q=Math.max(0,...post.filter(b=>b.mint===WSOL).map(b=>Number(b.uiTokenAmount&&b.uiTokenAmount.uiAmount)||0));
  if(q<MIN_SOL)return;
  const tk=Math.max(0,...post.filter(b=>b.mint===mint).map(b=>Number(b.uiTokenAmount&&b.uiTokenAmount.uiAmount)||0));
  const p0=tk>0?q/tk:0;
  const [asset,usd]=await Promise.all([rpc(env,'getAsset',{id:mint}).catch(()=>null),solUsd()]);
  const m=asset&&asset.content&&asset.content.metadata;
  const sym=(m&&m.symbol)||'';
  const name=sym+(m&&m.name?' ('+m.name+')':'');
  const so=await socials(asset);
  const mc0=p0*1e9*usd;
  const soc=[['Twitter',so.tw],['Website',so.web],['Telegram',so.tgm]].filter(x=>safe(x[1])).map(x=>'<a href="'+safe(x[1])+'">'+x[0]+'</a>').join(' | ');
  await tg(env,'🎓 <b>Pump.fun graduation</b>\n'+esc(name||'new token')+'\nMcap '+(mc0?money(mc0):'n/a')+' | pool '+q.toFixed(1)+' SOL\n'+(soc?soc+'\n':'')+'\n<code>'+mint+'</code>\n\n'+links(mint));
  try{if(p0>0)await store(env).add({mint,sym:sym||'token',p0,mc0,t0:Date.now(),hit:1})}catch(e){}
}
async function check(env){
  const st=store(env),all=await st.list(),now=Date.now(),live=[];
  for(const r of all){if(now-r.t0>86400000)await st.del(r.mint);else live.push(r)}
  for(let i=0;i<live.length;i+=30){
    const chunk=live.slice(i,i+30);
    let ps=[];
    try{ps=await(await fetch('https://api.dexscreener.com/tokens/v1/solana/'+chunk.map(r=>r.mint).join(','))).json()}catch(e){continue}
    for(const r of chunk){
      const p=ps.filter(x=>x.baseToken.address===r.mint&&x.quoteToken.address===WSOL&&x.priceNative).sort((a,b)=>liq(b)-liq(a))[0];
      if(!p)continue;
      const x=Number(p.priceNative)/r.p0;
      const hit=STEPS.filter(s=>s>r.hit&&x>=s);
      if(!hit.length)continue;
      r.hit=hit[hit.length-1];
      await st.add(r);
      await tg(env,'🔥 <b>'+esc(r.sym)+'</b> is up '+x.toFixed(1)+'X\n💸 Now at '+money(p.marketCap||p.fdv||0)+'\n🚨 Alerted at '+(r.mc0?money(r.mc0):'n/a')+'\n\n<code>'+r.mint+'</code>\n\n'+links(r.mint));
    }
  }
}
export default{
  async fetch(req,env,ctx){
    const url=new URL(req.url);
    if(req.method==='GET'){
      if(url.pathname==='/test')ctx.waitUntil(tg(env,'✅ Graduation bot is connected'));
      return new Response('ok');
    }
    let txs=[];
    try{txs=await req.json()}catch(e){return new Response('bad',{status:400})}
    for(const t of txs){if(t&&t.signature)ctx.waitUntil(handle(env,t.signature))}
    return new Response('ok');
  },
  async scheduled(e,env,ctx){ctx.waitUntil(check(env))}
};
