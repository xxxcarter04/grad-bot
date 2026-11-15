const WSOL='So11111111111111111111111111111111111111112';
const tg=(env,text)=>fetch('https://api.telegram.org/bot'+env.TG_TOKEN+'/sendMessage',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({chat_id:env.TG_CHAT,text})});
export default{
  async fetch(req,env,ctx){
    const url=new URL(req.url);
    if(req.method==='GET'){
      if(url.pathname==='/test')ctx.waitUntil(tg(env,'✅ Graduation bot is connected'));
      return new Response('ok');
    }
    let txs=[];
    try{txs=await req.json()}catch(e){return new Response('bad',{status:400})}
    for(const t of txs){
      const ms=[...new Set((t.tokenTransfers||[]).map(x=>x.mint))].filter(m=>m&&m!==WSOL);
      const mint=ms.find(m=>m.endsWith('pump'))||ms[0];
      if(!mint)continue;
      ctx.waitUntil(tg(env,'🎓 Pump.fun graduation\n'+mint+'\nhttps://dexscreener.com/solana/'+mint+'\nhttps://pump.fun/coin/'+mint));
    }
    return new Response('ok');
  }
};
