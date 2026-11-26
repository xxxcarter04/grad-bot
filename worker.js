import {DurableObject} from 'cloudflare:workers';
const MIN_SOL=50,STEPS=[2,3,5,10,20,50,100];
const DEX_WINDOW=60*60*1000; // how long to watch for a Dex paid profile after the graduation alert
const MAX_RECHECK=25; // max tokens re-checked per run
const STATS_CAP=13000; // max ms spent on stats before the alert is sent anyway
const WSOL='So11111111111111111111111111111111111111112';
const PAMM='pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA';
const BURN='11111111111111111111111111111111';
const INCINERATOR='1nc1nerator11111111111111111111111111111111';
const BUNDLE_MIN=3,FUND_N=12,FUND_SIGS=200,SIG_CAP=100,SIG_PAGES=2,SINGLE=5,MAX_VER=1;
const FEE_CURVE=0.0125,FEE_DEFAULT=0.0125;
// ---- fake-pump filter for the "X" alerts (tune these) ----
const F_BASE_TXNS=30,F_TXNS_PER_X=5,F_MAX_TXNS=3000; // txns needed in 24h = 30 + 5 per X (max 3000)
const F_MIN_SELL=0.04;   // at least 4% of the txns must be sells
const F_MAX_TOP1=35;     // biggest holder (pool excluded) max % of supply
const F_MAX_TOP10=80;    // top 10 holders (pool excluded) max % of supply
const F_CACHE=10*60*1000;
const SKIP_OWNERS=new Set([BURN,INCINERATOR,PAMM,'5Q544fKrFoe6tsEbD7S8EmxGTJYAKtTVhAW5Q5pge4j1','6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P']);
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
const capT=(p,ms)=>Promise.race([p,sleep(ms).then(()=>null)]);
const esc=s=>String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
const money=n=>n>=1e6?'$'+(n/1e6).toFixed(2)+'M':n>=1e3?'$'+(n/1e3).toFixed(1)+'K':'$'+Math.round(n);
// SOL amounts: 1234 SOL, 12.3 SOL, 1.23 SOL, 0.012 SOL
const solFmt=n=>n>=100?Math.round(n).toLocaleString('en-US'):n>=10?n.toFixed(1):n>=1?n.toFixed(2):n.toFixed(3);
const pc=n=>n==null||!isFinite(n)?'n/a':n.toFixed(1)+'%';
const safe=u=>/^https?:\/\//.test(u||'')?esc(u).replace(/"/g,'&quot;'):'';
const imgUrl=u=>{u=String(u||'');if(u.startsWith('ipfs://'))u='https://ipfs.io/ipfs/'+u.slice(7).replace(/^ipfs\//,'');return /^https?:\/\//.test(u)?u:''};
const liq=x=>(x.liquidity&&x.liquidity.usd)||0;
const links=m=>'<a href="https://dexscreener.com/solana/'+m+'">DexScreener</a> | <a href="https://pump.fun/coin/'+m+'">Pump.fun</a> | <a href="https://rugcheck.xyz/tokens/'+m+'">Rugcheck</a>';
const helius=env=>'https://mainnet.helius-rpc.com/?api-key='+env.HELIUS_KEY;
const rpc=(env,method,params)=>fetch(helius(env),{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({jsonrpc:'2.0',id:1,method,params})}).then(r=>r.json()).then(j=>{if(j&&j.error)console.error('rpc',method,JSON.stringify(j.error).slice(0,150));return j&&j.result});
// Batch call. If the plan rejects batches, falls back to a few single calls (partial=true) instead of returning nothing.
async function rpcBatch(env,calls){
  if(!calls.length)return {res:{},partial:false};
  try{
    const r=await fetch(helius(env),{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(calls.map(([method,params],i)=>({jsonrpc:'2.0',id:i+1,method,params})))});
    const j=await r.json();
    if(Array.isArray(j))return {res:Object.fromEntries(j.map(x=>[x.id,x.result])),partial:false};
    console.error('batch rejected',JSON.stringify(j).slice(0,150));
  }catch(e){console.error('batch error',e&&e.message)}
  const res={};
  await Promise.all(calls.slice(0,SINGLE).map(([m,p],i)=>rpc(env,m,p).then(v=>{res[i+1]=v}).catch(()=>{})));
  return {res,partial:calls.length>SINGLE};
}
// text + optional picture. If the picture fails (bad link, slow IPFS) the plain text message is sent instead.
const tg=(env,text,photo)=>Promise.all(String(env.TG_CHAT).split(',').map(async c=>{
  const chat=c.trim();
  const post=async(method,body)=>{
    const r=await fetch('https://api.telegram.org/bot'+env.TG_TOKEN+'/'+method,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});
    if(!r.ok)console.error('telegram',method,chat,r.status,(await r.text()).slice(0,150));
    return r.ok;
  };
  try{
    if(photo&&text.replace(/<[^>]*>/g,'').length<=1000){
      if(await post('sendPhoto',{chat_id:chat,photo,caption:text,parse_mode:'HTML'}))return;
    }
    await post('sendMessage',{chat_id:chat,text,parse_mode:'HTML',link_preview_options:{is_disabled:true}});
  }catch(e){console.error('telegram error',e&&e.message)}
}));
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
async function rugInfo(mint){
  try{return await(await fetch('https://api.rugcheck.xyz/v1/tokens/'+mint+'/report',{signal:AbortSignal.timeout(6000)})).json()}catch(e){return null}
}
// Bonding-curve phase: buys BEFORE the graduation tx. Fills `out` as it goes so a timeout still keeps partial data.
async function launchVolume(env,mint,gradSig,out){
  let lamports=0,buys=0,before=gradSig||undefined;
  try{
    for(let page=0;page<SIG_PAGES;page++){
      const opt={limit:SIG_CAP,commitment:'confirmed'};
      if(before)opt.before=before;
      const sigs=await rpc(env,'getSignaturesForAddress',[mint,opt]);
      if(!Array.isArray(sigs)||!sigs.length)break;
      const {res,partial}=await rpcBatch(env,sigs.map(s=>['getTransaction',[s.signature,{encoding:'jsonParsed',maxSupportedTransactionVersion:MAX_VER,commitment:'confirmed'}]]));
      for(const tx of Object.values(res)){
        if(!tx||!tx.meta||tx.meta.err)continue;
        const logs=tx.meta.logMessages||[];
        if(!out.creator&&logs.some(l=>/Instruction: Create(V2)?$/.test(l))){
          const k=tx.transaction&&tx.transaction.message&&tx.transaction.message.accountKeys,f=k&&k[0];
          out.creator=(f&&f.pubkey)||(typeof f==='string'?f:null);
        }
        if(!logs.some(l=>/Instruction: Buy/i.test(l)))continue;
        buys++;
        for(const ii of tx.meta.innerInstructions||[])for(const ins of ii.instructions||[]){
          const p=ins&&ins.parsed;
          if(p&&(p.type==='transfer'||p.type==='transferWithSeed')&&Number(p.info&&p.info.lamports)>0)lamports+=Number(p.info.lamports);
        }
      }
      out.sol=lamports/1e9;out.buys=buys;
      if(partial){out.capped=true;break}
      if(sigs.length<SIG_CAP){out.capped=false;break}
      before=sigs[sigs.length-1].signature;
      if(page===SIG_PAGES-1)out.capped=true;
    }
  }catch(e){console.error('launchVolume',e&&e.message)}
  out.done=true;
}
async function feeStats(env,d,pair,out){
  const gp=geckoFee(pair&&pair.pairAddress).then(v=>{out.feePct=v});
  await Promise.all([launchVolume(env,d.mint,d.sig,out),gp]);
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
// Top holders (pool/burn/program accounts excluded), top1 / top10 %, and bundle detection by common funder.
async function holderStats(env,mint,skipSet,out,funders){
  const skip=o=>!o||SKIP_OWNERS.has(o)||skipSet.has(o);
  const [accs,sup]=await Promise.all([
    rpc(env,'getTokenLargestAccounts',[mint,{commitment:'confirmed'}]),
    rpc(env,'getTokenSupply',[mint,{commitment:'confirmed'}])
  ]);
  out.supply=Number(sup&&sup.value&&sup.value.amount)||0;
  // the RPC returns {context,value:[...]}, not a plain array
  const top=(accs&&Array.isArray(accs.value)?accs.value:[]).filter(a=>Number(a.amount)>0).sort((a,b)=>Number(b.amount)-Number(a.amount));
  if(!top.length||!out.supply)return;
  const m=await rpc(env,'getMultipleAccounts',[top.map(a=>a.address),{encoding:'jsonParsed',commitment:'confirmed'}]);
  const vals=m&&Array.isArray(m.value)?m.value:[];
  const holders=top.map((a,i)=>{
    const v=vals[i],o=v&&v.data&&v.data.parsed&&v.data.parsed.info&&v.data.parsed.info.owner;
    return {owner:o,pct:Number(a.amount)/out.supply*100};
  }).filter(h=>!skip(h.owner));
  out.holders=holders;
  out.top10=holders.slice(0,10).reduce((s,h)=>s+h.pct,0);
  out.top1=holders.length?holders[0].pct:0;
  if(!funders||!holders.length)return;
  const cand=holders.slice(0,FUND_N);
  const sr=(await rpcBatch(env,cand.map(h=>['getSignaturesForAddress',[h.owner,{limit:FUND_SIGS,commitment:'confirmed'}]]))).res;
  if(!cand.some((h,i)=>Array.isArray(sr[i+1])))return;
  const idx=[],calls=[];
  cand.forEach((h,i)=>{
    const a=sr[i+1];
    // only wallets with a short history: the oldest signature is then the funding transaction
    const s=Array.isArray(a)&&a.length&&a.length<FUND_SIGS?a[a.length-1].signature:null;
    if(s){idx.push(i);calls.push(['getTransaction',[s,{encoding:'jsonParsed',maxSupportedTransactionVersion:MAX_VER,commitment:'confirmed'}]])}
  });
  if(!calls.length){out.bundledPct=0;return}
  const tr=(await rpcBatch(env,calls)).res;
  const fund=Array(cand.length).fill(null);
  idx.forEach((hi,j)=>{fund[hi]=funderOf(tr[j+1],cand[hi].owner)});
  const count={};
  fund.forEach(f=>{if(f)count[f]=(count[f]||0)+1});
  const bundled=cand.filter((h,i)=>fund[i]&&count[fund[i]]>=BUNDLE_MIN);
  out.bundledPct=bundled.reduce((s,h)=>s+h.pct,0);
  out.wallets=bundled.length;
  out.groups=Object.values(count).filter(n=>n>=BUNDLE_MIN).length;
}
// Dev = the creator wallet. Reads its current balance of the token straight from the chain.
async function devHolding(env,mint,creator,supply){
  if(!creator||!supply)return null;
  const r=await rpc(env,'getTokenAccountsByOwner',[creator,{mint},{encoding:'jsonParsed',commitment:'confirmed'}]);
  const arr=r&&Array.isArray(r.value)?r.value:null;
  if(!arr)return null;
  const amt=arr.reduce((s,a)=>{
    const ta=a&&a.account&&a.account.data&&a.account.data.parsed&&a.account.data.parsed.info&&a.account.data.parsed.info.tokenAmount;
    return s+(Number(ta&&ta.amount)||0);
  },0);
  return amt/supply*100;
}
const devText=d=>d==null?'n/a':d>=0.05?'holding '+d.toFixed(1)+'%':'sold all (0%)';
async function gatherStats(env,d,pair){
  const t0=Date.now();
  const skip=new Set([d.pool,pair&&pair.pairAddress].filter(Boolean));
  const fee={sol:0,buys:0,capped:false,creator:null,feePct:null,done:false};
  const hold={supply:0,holders:[],top10:null,top1:null,bundledPct:null,wallets:0,groups:0};
  const box={rug:null};
  await capT(Promise.all([
    feeStats(env,d,pair,fee).catch(e=>console.error('fees',e&&e.message)),
    holderStats(env,d.mint,skip,hold,true).catch(e=>console.error('holders',e&&e.message)),
    rugInfo(d.mint).then(r=>{box.rug=r})
  ]),Math.round(STATS_CAP*0.7));
  const rug=box.rug;
  const creator=(rug&&typeof rug.creator==='string'&&rug.creator)||fee.creator||null;
  let dev=null;
  if(creator&&hold.supply){
    const o={v:null};
    await capT(devHolding(env,d.mint,creator,hold.supply).then(v=>{o.v=v}).catch(()=>{}),Math.max(1500,STATS_CAP-(Date.now()-t0)));
    dev=o.v;
  }
  if(dev==null&&rug&&rug.creatorBalance!=null){
    const rs=Number(rug.token&&rug.token.supply)||0;
    if(rs)dev=Number(rug.creatorBalance)/rs*100;
  }
  // ---- total fees in SOL ----
  // curve fees: SOL spent on the bonding curve x curve fee rate (needs no price at all)
  // pool fees: 24h volume (USD from DexScreener) converted to SOL x pool fee rate (needs the SOL price)
  const usd=Number(d.usd)||lastSol;
  const v24=Number(pair&&pair.volume&&pair.volume.h24)||0;
  const curveSol=fee.sol*FEE_CURVE;
  const poolSol=usd>0?(v24/usd)*(fee.feePct||FEE_DEFAULT):0;
  const fees=(fee.done||fee.sol>0)?curveSol+poolSol:null;
  // if the SOL price was missing, the pool part is left out, so show the number as a minimum (≥)
  const feesCapped=fee.capped||(v24>0&&!(usd>0));
  let top10=hold.holders.length?hold.top10:null;
  if(top10==null&&rug&&Array.isArray(rug.topHolders)){
    top10=rug.topHolders.filter(h=>h&&!SKIP_OWNERS.has(h.owner)&&!skip.has(h.owner)).slice(0,10).reduce((s,h)=>s+(Number(h.pct)||0),0)||null;
  }
  let bundled=hold.bundledPct;
  if(bundled==null&&rug){
    const risk=(Array.isArray(rug.risks)?rug.risks:[]).find(r=>/bundl/i.test(String(r.name||'')+' '+String(r.description||'')));
    const rm=risk&&String(risk.value||risk.description||'').match(/(\d+(?:\.\d+)?)\s*%/);
    if(rm)bundled=Number(rm[1]);
  }
  return {fees,feesCapped,bundled,wallets:hold.wallets,groups:hold.groups,top10,dev};
}
export class Tracker extends DurableObject{
  async add(r){await this.ctx.storage.put('t:'+r.mint,r)}
  async list(){return [...(await this.ctx.storage.list({prefix:'t:'})).values()]}
  async del(m){await this.ctx.storage.delete('t:'+m)}
  async addW(r){await this.ctx.storage.put('w:'+r.mint,r)}
  async listW(){return [...(await this.ctx.storage.list({prefix:'w:'})).values()]}
  async delW(m){await this.ctx.storage.delete('w:'+m)}
  // duplicate protection: a DO runs one call at a time, so this check-and-set is safe
  async claim(m){const k='s:'+m;if(await this.ctx.storage.get(k))return false;await this.ctx.storage.put(k,Date.now());return true}
  async listS(){return [...(await this.ctx.storage.list({prefix:'s:'})).entries()]}
  async delS(k){await this.ctx.storage.delete(k)}
}
let lastSol=0;
// SOL/USD price: DexScreener first, Coinbase as backup. Returns the last known price (or 0) if both fail.
async function solUsd(){
  for(let i=0;i<2;i++){
    try{
      const a=await(await fetch('https://api.dexscreener.com/tokens/v1/solana/'+WSOL,{signal:AbortSignal.timeout(3000)})).json();
      const b=Array.isArray(a)&&a.filter(x=>x.priceUsd).sort((x,y)=>liq(y)-liq(x))[0];
      if(b){lastSol=Number(b.priceUsd);return lastSol}
    }catch(e){}
    await sleep(300);
  }
  try{
    const j=await(await fetch('https://api.coinbase.com/v2/prices/SOL-USD/spot',{signal:AbortSignal.timeout(3000)})).json();
    const v=Number(j&&j.data&&j.data.amount);
    if(v>0){lastSol=v;return v}
  }catch(e){}
  return lastSol;
}
async function socials(a){
  try{const u=a&&a.content&&a.content.json_uri;if(!u)return {};const j=await(await fetch(u,{signal:AbortSignal.timeout(4000)})).json();return {tw:j.twitter,web:j.website,tgm:j.telegram,img:j.image}}catch(e){return {}}
}
async function sendGrad(env,d,late,pair){
  const mins=Math.max(0,Math.round((Date.now()-d.t0)/60000));
  const head=(late?'⏱ Graduated '+mins+' min ago':'✅ Just graduated')+(d.paid?' · Dex paid':'')+'\n';
  const s=await gatherStats(env,d,pair).catch(e=>{console.error('stats',e&&e.message);return null});
  const stats=[];
  if(s){
    stats.push('💰 Total fees '+(s.fees==null?'n/a':(s.feesCapped?'≥':'~')+solFmt(s.fees)+' SOL'));
    stats.push('🧩 Bundled '+(s.bundled==null?'n/a':pc(s.bundled)+(s.wallets?' ('+s.wallets+' wallets / '+s.groups+(s.groups===1?' funder)':' funders)'):''))+' | Top10 '+pc(s.top10));
    stats.push('👤 Dev '+devText(s.dev));
  }
  const text='🎓 <b>Pump.fun graduation</b>\n'+head+esc(d.name)+'\nMcap '+(d.mc0?money(d.mc0):'n/a')+' | pool '+d.q.toFixed(1)+' SOL\n'+(d.soc?d.soc+'\n':'')+(stats.length?'\n'+stats.join('\n')+'\n':'')+'\n<code>'+d.mint+'</code>\n\n'+links(d.mint);
  await tg(env,text,d.img);
  try{if(d.p0>0)await store(env).add({mint:d.mint,sym:d.sym,p0:d.p0,mc0:d.mc0,t0:Date.now(),hit:1,img:d.img})}catch(e){}
  if(!d.paid)try{await store(env).addW({mint:d.mint,sym:d.sym||'token',t0:Date.now(),img:d.img})}catch(e){}
}
async function sendDexPaid(env,d){
  await tg(env,'✅ <b>Dex paid</b>\n'+esc(d.sym||'token')+'\n\n<code>'+d.mint+'</code>\n\n'+links(d.mint),d.img);
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
  const ui=b=>Number(b.uiTokenAmount&&b.uiTokenAmount.uiAmount)||0;
  const q=Math.max(0,...post.filter(b=>b.mint===WSOL).map(ui));
  if(q<MIN_SOL)return;
  // skip a graduation we already alerted on
  let first=true;
  try{first=await store(env).claim(mint)}catch(e){}
  if(!first)return;
  const mintBals=post.filter(b=>b.mint===mint).sort((a,b)=>ui(b)-ui(a));
  const tk=mintBals.length?ui(mintBals[0]):0;
  const pool=(mintBals[0]&&mintBals[0].owner)||null; // the new pool: its vault holds the most tokens in this tx
  const p0=tk>0?q/tk:0;
  const [asset,usd0,paid,pair]=await Promise.all([rpc(env,'getAsset',{id:mint}).catch(()=>null),solUsd(),isDexPaid(mint),dexPair(mint)]);
  // SOL price: use the lookup, or derive it from the pair (USD price / SOL price) if both price APIs failed
  let usd=Number(usd0)||0;
  if(!usd&&pair&&Number(pair.priceUsd)>0&&Number(pair.priceNative)>0){
    usd=Number(pair.priceUsd)/Number(pair.priceNative);
    lastSol=usd;
  }
  const m=asset&&asset.content&&asset.content.metadata;
  const sym=(m&&m.symbol)||'';
  const name=sym+(m&&m.name?' ('+m.name+')':'');
  const so=await socials(asset);
  const img=imgUrl((pair&&pair.info&&pair.info.imageUrl)||so.img||(asset&&asset.content&&asset.content.links&&asset.content.links.image));
  const mc0=p0*1e9*usd;
  const soc=[['Twitter',so.tw],['Website',so.web],['Telegram',so.tgm]].filter(x=>safe(x[1])).map(x=>'<a href="'+safe(x[1])+'">'+x[0]+'</a>').join(' | ');
  const d={mint,sym:sym||'token',name:name||'new token',q,soc,p0,mc0,usd,sig,paid,pool,img,t0:Date.now()};
  try{await sendGrad(env,d,false,pair)}catch(e){console.error('sendGrad',e&&e.message);try{await store(env).delS('s:'+mint)}catch(e2){}}
}
async function checkPending(env){
  const st=store(env),list=(await st.listW()).sort((a,b)=>a.t0-b.t0),now=Date.now();
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
  try{for(const [k,t] of await st.listS()){if(now-Number(t)>86400000)await st.delS(k)}}catch(e){}
  for(let i=0;i<live.length;i+=30){
    const chunk=live.slice(i,i+30);
    let ps=[];
    try{ps=await(await fetch('https://api.dexscreener.com/tokens/v1/solana/'+chunk.map(r=>r.mint).join(','),{signal:AbortSignal.timeout(8000)})).json()}catch(e){continue}
    if(!Array.isArray(ps))continue;
    for(const r of chunk){
      const p=ps.filter(x=>x.baseToken&&x.baseToken.address===r.mint&&x.quoteToken&&x.quoteToken.address===WSOL&&x.priceNative).sort((a,b)=>liq(b)-liq(a))[0];
      if(!p)continue;
      const x=Number(p.priceNative)/r.p0;
      const hit=STEPS.filter(s=>s>r.hit&&x>=s);
      if(!hit.length)continue;
      // ---- fake-pump filter: a few huge buys can fake a 1000x; real runs have many trades, real sellers, spread-out holders ----
      const t=p.txns&&p.txns.h24,buys=Number(t&&t.buys)||0,sells=Number(t&&t.sells)||0,n=buys+sells;
      if(n<Math.min(F_MAX_TXNS,F_BASE_TXNS+F_TXNS_PER_X*x))continue;
      if(sells/n<F_MIN_SELL)continue;
      if(!r.conc||now-r.conc.t>F_CACHE){
        const h={supply:0,holders:[],top10:null,top1:null};
        try{await capT(holderStats(env,r.mint,new Set([p.pairAddress].filter(Boolean)),h,false),8000)}catch(e){}
        if(h.holders.length){
          r.conc={t:now,bad:h.top1>F_MAX_TOP1||h.top10>F_MAX_TOP10};
          try{await st.add(r)}catch(e){}
        }
      }
      if(r.conc&&r.conc.bad)continue;
      r.hit=hit[hit.length-1];
      await st.add(r);
      await tg(env,'🔥 <b>'+esc(r.sym)+'</b> is up '+x.toFixed(1)+'X\n💸 Now at '+money(p.marketCap||p.fdv||0)+'\n🚨 Alerted at '+money(r.mc0||((p.marketCap||p.fdv||0)/x))+'\n\n<code>'+r.mint+'</code>\n\n'+links(r.mint),r.img);
    }
  }
}
export default{
  async fetch(req,env,ctx){
    const url=new URL(req.url);
    const need=env.WEBHOOK_KEY; // optional: only enforced when this secret is set
    if(req.method==='GET'){
      if(url.pathname==='/test'&&(!need||url.searchParams.get('key')===need))ctx.waitUntil(tg(env,'✅ Graduation bot is connected'));
      return new Response('ok');
    }
    if(need&&req.headers.get('Authorization')!==need)return new Response('no',{status:401});
    let txs=[];
    try{txs=await req.json()}catch(e){return new Response('bad',{status:400})}
    if(!Array.isArray(txs))txs=[txs];
    for(const t of txs){if(t&&t.signature)ctx.waitUntil(handle(env,t.signature))}
    return new Response('ok');
  },
  async scheduled(e,env,ctx){ctx.waitUntil(Promise.all([check(env).catch(()=>{}),checkPending(env).catch(()=>{})]))}
};
