
const WSOL='So11111111111111111111111111111111111111112';
const PAMM='pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA';
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
const rpc=(env,method,params)=>fetch('https://mainnet.helius-rpc.com/?api-key='+env.HELIUS_KEY,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({jsonrpc:'2.0',id:1,method,params})}).then(r=>r.json()).then(j=>j.result);
const tg=const tg=(env,text)=>Promise.all(String(env.TG_CHAT).split(',').map(c=>fetch('https://api.telegram.org/bot'+env.TG_TOKEN+'/sendMessage',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({chat_id:c.trim(),text})})));
async function handle(env,sig){
  let tx=null;
  for(let i=0;i<3&&!tx;i++){
    tx=await rpc(env,'getTransaction',[sig,{encoding:'jsonParsed',maxSupportedTransactionVersion:0,commitment:'confirmed'}]).catch(()=>null);
    if(!tx)await sleep(1000);
  }
  if(!tx||!tx.meta||tx.meta.err)return;
  const logs=tx.meta.logMessages||[];
  if(!(logs.some(l=>/Instruction: Migrate$/.test(l))&&logs.some(l=>l.includes(PAMM))))return;
  const ms=[...new Set([...(tx.meta.postTokenBalances||[]),...(tx.meta.preTokenBalances||[])].map(b=>b.mint))].filter(m=>m&&m!==WSOL);
  const mint=ms.find(m=>m.endsWith('pump'))||ms[0];
  if(!mint)return;
  let p=null;
  for(let i=0;i<3&&!p;i++){
    await sleep(3000);
    try{const a=await(await fetch('https://api.dexscreener.com/tokens/v1/solana/'+mint)).json();p=a.find(x=>x.dexId==='pumpswap')||null}catch(e){}
  }
  if(p){
    if(p.pairCreatedAt&&Date.now()-p.pairCreatedAt>3600000)return;
    if((p.liquidity&&p.liquidity.usd||0)<3000)return;
  }
  const info=p?'\n'+p.baseToken.symbol+' | liquidity $'+Math.round(p.liquidity.usd):'';
  await tg(env,'🎓 Pump.fun graduation'+info+'\n'+mint+'\nhttps://dexscreener.com/solana/'+mint+'\nhttps://pump.fun/coin/'+mint);
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
