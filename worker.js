import {DurableObject} from 'cloudflare:workers';
const MIN_SOL=50,STEPS=[2,3,5,10,20,50,100];
const WINDOW=20*60*1000; // legacy pending window
const DEX_WINDOW=60*60*1000; // how long to watch for a Dex paid profile after the graduation alert
const MAX_RECHECK=40; // max tokens re-checked per run (DexScreener rate limit)
const WSOL='So11111111111111111111111111111111111111112';
const PAMM='pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA';
const TOP_HOLDERS=15,BUNDLE_MIN=3,SIG_CAP=100,BURN='11111111111111111111111111111111';
const MAX_VER=1,FEE_CURVE=0.0125,FEE_DEFAULT=0.0125;
const SKIP_OWNERS=new Set([BURN,PAMM,'5Q544fKrFoe6tsEbD7S8EmxGTJYAKtTVhAW5Q5pge4j1','6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P']);
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
const esc=s=>String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
const money=n=>n>=1e6?'$'+(n/1e6).toFixed(2)+'M':n>=1e3?'$'+(n/1e3).toFixed(1)+'K':'$'+Math.round(n);
const safe=u=>/^https?:\/\//.test(u||'')?esc(u).replace(/"/g,'&quot;'):'';
const liq=x=>(x.liquidity&&x.liquidity.usd)||0;
const links=m=>'<a href="https://dexscreener.com/solana/'+m+'">DexScreener</a> | <a href="https://pump.fun/coin/'+m+'">Pump.fun</a> | <a href="https://rugcheck.xyz/tokens/'+m+'">Rugcheck</a>';
const helius=env=>'https://mainnet.helius-rpc.com/?api-key='+env.HELIUS_KEY;
const rpc=(env,method,params)=>fetch(helius(env),{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({jsonrpc:'2.0',id:1,method,params})}).then(r=>r.json()).then(j=>j.result);
const rpcBatch=(env,calls)=>fetch(helius(env),{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(calls.map(([method,params],i)=>({jsonrpc:'2.0',id:i+1,method,params})))}).then(r=>r.json()).then(j=>Object.fromEntries([].concat(j).map(x=>[x.id,x.result])));
const tg=(env,text)=>Promise.all(String(env.TG_CHAT).split(',').map(c=>fetch('https://api.telegram.org/bot'+env.TG_TOKEN+'/sendMessage',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({chat_id:c.trim(),text,parse_mode:'HTML',link_preview_options:{is_disabled:true}})})));
const store=env=>env.TRACK.get(env.TRACK.idFromName('main'));
async function isDexPaid(mint){
  try{
    const r=await fetch('https://api.dexscreener.com/orders/v1/solana/'+mint,{signal:AbortSignal.timeout(3000)});
    if(!r.ok)return false;
    const d=await r.json();
    const o=Array.isArray(d)?d:(d.orders||[]);
    return o.some(x=>x.type==='tokenProfile'&&x.status==='approved');
  }catch(e){return false}
}
async function dexPair(mint){
  try{
    const ps=await(await fetch('https://api.dexscreener.com/tokens/v1/solana/'+mint,{signal:AbortSignal.timeout(5000)})).json();
    return (Array.isArray(ps)?ps:[]).filter(x=>x.baseToken&&x.baseToken.address===mint&&x.quoteToken&&x.quoteToken.address===WSOL&&x.priceNative).sort((a,b)=>liq(b)-liq(a))[0]||null;
  }catch(e){return null}
}
async function geckoFee(pair){
  if(!pair)return null;
  try{
    const j=await(await fetch('https://api.geckoterminal.com/api/v2/networks/solana/pools/'+pair,{signal:AbortSignal.timeout(5000)})).json();
    const pct=Number(j&&j.data&&j.data.attributes&&j.data.attributes.pool_fee_percentage);
    return pct>0?pct/100:null;
  }catch(e){return null}
}
async function launchVolume(env,mint,gradSig){
  try{
    const opt={limit:SIG_CAP,commitment:'confirmed'};
    if(gradSig)opt.until=gradSig;
    const sigs=await rpc(env,'getSignaturesForAddress',[mint,opt]);
    if(!Array.isArray(sigs)||!sigs.length)return {sol:0,buys:0,capped:false};
    const res=await rpcBatch(env,sigs.map(s=>['getTransaction',[s.signature,{encoding:'jsonParsed',maxSupportedTransactionVersion:MAX_VER,commitment:'confirmed'}]]));
    let lamports=0,buys=0;
    for(const tx of Object.values(res)){
      if(!tx||!tx.meta||tx.meta.err)continue;
      if(!(tx.meta.logMessages||[]).some(l=>/Instruction: Buy/i.test(l)))continue;
      buys++;
      for(const ii of tx.meta.innerInstructions||[])for(const ins of ii.instructions||[]){
        const p=ins&&ins.parsed;
        if(p&&(p.type==='transfer'||p.type==='transferWithSeed')&&Number(p.info&&p.info.lamports)>0)lamports+=Number(p.info.lamports);
      }
    }
    return {sol:lamports/1e9,buys,capped:sigs.length>=SIG_CAP};
  }catch(e){return {sol:0,buys:0,capped:false}}
}
async function volumeStats(env,d,pair){
  const p=pair||await dexPair(d.mint);
  const v24=Number(p&&p.volume&&p.volume.h24)||0;
  const usd=Number(d.usd)||lastSol;
  const lv=await launchVolume(env,d.mint,d.sig);
  const launchUsd=lv.sol*usd;
  const feePct=await geckoFee(p&&p.pairAddress);
  const feesUsd=launchUsd*FEE_CURVE+v24*(feePct||FEE_DEFAULT);
  return {v24,launchUsd,feesUsd,feePct,...lv};
}
function funderOf(tx,owner){
  const top=(tx&&tx.transaction&&tx.transaction.message&&tx.transaction.message.instructions)||[];
  const inner=((tx&&tx.meta&&tx.meta.innerInstructions)||[]).flatMap(x=>x.instructions||[]);
  for(const i of [...top,...inner]){
    const p=i&&i.parsed;
    if(!p||(p.type!=='transfer'&&p.type!=='transferWithSeed'))continue;
    const info=p.info||{};
    if(info.destination===owner&&Number(info.lamports)>0)return info.source||null;
  }
  return null;
}
async function bundleStats(env,mint){
  let supply=0,holders=[],bundledPct=null,bundledWallets=0,bundleGroups=0;
  try{
    const accs=await rpc(env,'getTokenLargestAccounts',[mint,{commitment:'confirmed'}]);
    const top=(Array.isArray(accs)?accs:[]).filter(a=>Number(a.amount)>0&&a.address!==BURN).sort((a,b)=>Number(b.amount)-Number(a.amount)).slice(0,TOP_HOLDERS);
    const res=await rpcBatch(env,[['getTokenSupply',[mint,{commitment:'confirmed'}]],...top.map(a=>['getAccountInfo',[a.address,{encoding:'jsonParsed',commitment:'confirmed'}]])]);
    supply=Number(res[1]&&res[1].value&&res[1].value.amount)||0;
    holders=top.map((a,i)=>({owner:res[i+2]&&res[i+2].value&&res[i+2].value.data&&res[i+2].value.data.parsed&&res[i+2].value.data.parsed.info&&res[i+2].value.data.parsed.info.owner,pct:supply?Number(a.amount)/supply*100:0})).filter(h=>h.owner&&!SKIP_OWNERS.has(h.owner));
  }catch(e){}
  if(holders.length&&supply){
    try{
      const sr=await rpcBatch(env,holders.map(h=>['getSignaturesForAddress',[h.owner,{limit:50,commitment:'confirmed'}]]));
      const idx=[],calls=[];
      holders.forEach((h,i)=>{
        const a=sr[i+1],s=Array.isArray(a)&&a.length?a[a.length-1].signature:null;
        if(s){idx.push(i);calls.push(['getTransaction',[s,{encoding:'jsonParsed',maxSupportedTransactionVersion:MAX_VER,commitment:'confirmed'}]])}
      });
      if(calls.length){
        const tr=await rpcBatch(env,calls);
        const funders=Array(holders.length).fill(null);
        idx.forEach((hi,j)=>{funders[hi]=funderOf(tr[j+1],holders[hi].owner)});
        const count={};
        funders.forEach(f=>{if(f)count[f]=(count[f]||0)+1});
        const bundled=holders.filter((h,i)=>funders[i]&&count[funders[i]]>=BUNDLE_MIN);
        bundledPct=bundled.length?bundled.reduce((s,h)=>s+h.pct,0):0;
        bundledWallets=bundled.length;
        bundleGroups=Object.values(count).filter(n=>n>=BUNDLE_MIN).length;
      }
    }catch(e){}
  }
  let rug=null;
  try{rug=await(await fetch('https://api.rugcheck.xyz/v1/tokens/'+mint+'/report',{signal:AbortSignal.timeout(6000)})).json()}catch(e){}
  const rSupply=Number(rug&&rug.token&&rug.token.supply)||0;
  const dev=rSupply&&rug&&rug.creatorBalance!=null?Number(rug.creatorBalance)/rSupply*100:null;
  let top10=(Array.isArray(rug&&rug.topHolders)?rug.topHolders.slice(0,10):[]).reduce((s,h)=>s+(Number(h.pct)||0),0);
  if(!top10)top10=holders.slice(0,10).reduce((s,h)=>s+h.pct,0);
  const risk=(Array.isArray(rug&&rug.risks)?rug.risks:[]).find(r=>/bundl/i.test(String(r.name||'')+' '+String(r.description||'')));
  const rm=risk&&String(risk.value||risk.description||'').match(/(\d+(?:\.\d+)?)\s*%/);
  if(bundledPct==null&&rm)bundledPct=Number(rm[1]);
  const pumps=(Array.isArray(rug&&rug.markets)?rug.markets:[]).filter(m=>/pump/i.test(String(m&&m.marketType||'')));
  let lpBurned=null;
  if(pumps.length){
    lpBurned=pumps.some(m=>{
      const lp=m.lp||{},lpMint=String(m.mintLP||lp.lpMint||'');
      return lpMint===BURN||Number(lp.currentSupply)===0||Number(lp.lpLockedPct)>=99;
    });
  }
  return {pct:bundledPct,wallets:bundledWallets,groups:bundleGroups,top10,dev,lpBurned};
}
export class Tracker extends DurableObject{
  async add(r){await this.ctx.storage.put('t:'+r.mint,r)}
  async list(){return [...(await this.ctx.storage.list({prefix:'t:'})).values()]}
  async del(m){await this.ctx.storage.delete('t:'+m)}
  async addW(r){await this.ctx.storage.put('w:'+r.mint,r)}
  async listW(){return [...(await this.ctx.storage.list({prefix:'w:'})).values()]}
  async delW(m){await this.ctx.storage.delete('w:'+m)}
}
let lastSol=0;
async function solUsd(){
  for(let i=0;i<3;i++){
    try{const a=await(await fetch('https://api.dexscreener.com/tokens/v1/solana/'+WSOL)).json();const b=a.filter(x=>x.priceUsd).sort((x,y)=>liq(y)-liq(x))[0];if(b){lastSol=Number(b.priceUsd);return lastSol}}catch(e){}
    await sleep(700);
  }
  return lastSol;
}
async function socials(a){
  try{const u=a&&a.content&&a.content.json_uri;if(!u)return {};const j=await(await fetch(u,{signal:AbortSignal.timeout(4000)})).json();return {tw:j.twitter,web:j.website,tgm:j.telegram}}catch(e){return {}}
}
async function sendGrad(env,d,late,pair){
  const mins=Math.max(0,Math.round((Date.now()-d.t0)/60000));
  const head=(late?'⏱ Graduated '+mins+' min ago':'✅ Just graduated')+(d.paid?' · Dex paid':'')+'\n';
  const [v,b]=await Promise.all([
    volumeStats(env,d,pair).catch(()=>null),
    bundleStats(env,d.mint).catch(()=>null)
  ]);
  const stats=[];
  if(v){
    stats.push('📊 Volume 24h '+money(v.v24)+' | launch '+(v.capped?'≥':'')+money(v.launchUsd)+' ('+v.buys+(v.buys===1?' buy':' buys')+')');
    stats.push('💰 Trading fees ~'+money(v.feesUsd)+' (curve '+Number(FEE_CURVE*100).toFixed(2)+'%'+(v.feePct?' · pool '+Number(v.feePct*100).toFixed(2)+'%':'')+')');
  }
  if(b)stats.push('🧩 Bundled '+(b.pct==null?'n/a':b.pct.toFixed(1)+'%')+(b.wallets?' · '+b.wallets+' wallets / '+b.groups+(b.groups===1?' funder':' funders'):'')+' | Top10 '+(b.top10?b.top10.toFixed(1)+'%':'n/a')+' | Dev '+(b.dev==null?'n/a':b.dev.toFixed(1)+'%')+' | LP '+(b.lpBurned==null?'n/a':b.lpBurned?'burned ✅':'⚠️ not burned'));
  await tg(env,'🎓 <b>Pump.fun graduation</b>\n'+head+esc(d.name)+'\nMcap '+(d.mc0?money(d.mc0):'n/a')+' | pool '+d.q.toFixed(1)+' SOL\n'+(d.soc?d.soc+'\n':'')+(stats.length?'\n'+stats.join('\n')+'\n':'')+'\n<code>'+d.mint+'</code>\n\n'+links(d.mint));
  try{if(d.p0>0)await store(env).add({mint:d.mint,sym:d.sym,p0:d.p0,mc0:d.mc0,t0:Date.now(),hit:1})}catch(e){}
  if(!d.paid)try{await store(env).addW({mint:d.mint,sym:d.sym||'token',t0:Date.now()})}catch(e){}
}
async function sendDexPaid(env,d){
  await tg(env,'✅ <b>Dex paid</b>\n'+esc(d.sym||'token')+'\n\n<code>'+d.mint+'</code>\n\n'+links(d.mint));
}
async function handle(env,sig){
  let tx=null;
  for(let i=0;i<3&&!tx;i++){
    tx=await rpc(env,'getTransaction',[sig,{encoding:'jsonParsed',maxSupportedTransactionVersion:MAX_VER,commitment:'confirmed'}]).catch(()=>null);
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
  const [asset,usd,paid,pair]=await Promise.all([rpc(env,'getAsset',{id:mint}).catch(()=>null),solUsd(),isDexPaid(mint),dexPair(mint)]);
  const m=asset&&asset.content&&asset.content.metadata;
  const sym=(m&&m.symbol)||'';
  const name=sym+(m&&m.name?' ('+m.name+')':'');
  const so=await socials(asset);
  const mc0=p0*1e9*usd;
  const soc=[['Twitter',so.tw],['Website',so.web],['Telegram',so.tgm]].filter(x=>safe(x[1])).map(x=>'<a href="'+safe(x[1])+'">'+x[0]+'</a>').join(' | ');
  const d={mint,sym:sym||'token',name:name||'new token',q,soc,p0,mc0,usd,sig,paid,t0:Date.now()};
  await sendGrad(env,d,false,pair);
}
async function checkPending(env){
  const st=store(env),list=await st.listW(),now=Date.now();
  let n=0;
  for(const w of list){
    if(now-w.t0>DEX_WINDOW){await st.delW(w.mint);continue}
    if(n>=MAX_RECHECK)break;
    n++;
    if(!(await isDexPaid(w.mint)))continue;
    await st.delW(w.mint);
    await sendDexPaid(env,w);
  }
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
      await tg(env,'🔥 <b>'+esc(r.sym)+'</b> is up '+x.toFixed(1)+'X\n💸 Now at '+money(p.marketCap||p.fdv||0)+'\n🚨 Alerted at '+money(r.mc0||((p.marketCap||p.fdv||0)/x))+'\n\n<code>'+r.mint+'</code>\n\n'+links(r.mint));
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
  async scheduled(e,env,ctx){ctx.waitUntil(Promise.all([check(env),checkPending(env).catch(()=>{})]))}
};
