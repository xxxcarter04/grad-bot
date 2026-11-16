const MIN_SOL=50;
const WSOL='So11111111111111111111111111111111111111112';
const PAMM='pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA';
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
const esc=s=>String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
const rpc=(env,method,params)=>fetch('https://mainnet.helius-rpc.com/?api-key='+env.HELIUS_KEY,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({jsonrpc:'2.0',id:1,method,params})}).then(r=>r.json()).then(j=>j.result);
const tg=(env,text)=>Promise.all(String(env.TG_CHAT).split(',').map(c=>fetch('https://api.telegram.org/bot'+env.TG_TOKEN+'/sendMessage',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({chat_id:c.trim(),text,parse_mode:'HTML',link_preview_options:{is_disabled:true}})})));
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
  let name='';
  try{const a=await rpc(env,'getAsset',{id:mint});const m=a&&a.content&&a.content.metadata;if(m)name=(m.symbol||'')+(m.name?' ('+m.name+')':'')}catch(e){}
  await tg(env,'🎓 <b>Pump.fun graduation</b>\n'+esc(name||'new token')+' | pool '+q.toFixed(1)+' SOL\n\n<code>'+mint+'</code>\n\n<a href="https://dexscreener.com/solana/'+mint+'">DexScreener</a> | <a href="https://pump.fun/coin/'+mint+'">Pump.fun</a>');
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
  }
};
