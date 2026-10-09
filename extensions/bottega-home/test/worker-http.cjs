#!/usr/bin/env node
// Authenticated real bridge transport, isolated filesystem and loopback only.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const esbuild = require('esbuild');
test('worker HTTP: auth, event wakeup without presence spin, shared jobs, pause and stale result', async () => {
 const home = fs.mkdtempSync(path.join(os.tmpdir(), 'worker-http-'));
 esbuild.buildSync({entryPoints:[path.join(__dirname,'../src/ponte.ts'),path.join(__dirname,'../src/worker.ts')],outdir:home,bundle:true,platform:'node',format:'cjs',target:'node20'});
 const {Ponte,leggiGettone}=require(path.join(home,'ponte.js'));
 const {WorkerQueue}=require(path.join(home,'worker.js'));
 const queue=new WorkerQueue({home}); const port=40000+Math.floor(Math.random()*10000);
 const ponte=new Ponte({dir:home,porta:port,versione:'test',worker:queue,indirizzo:async()=>({ip:'127.0.0.1',nome:'fixture.tailnet.ts.net'}),stato:()=>({}),occupata:()=>false,chiedi:async()=>'',parla:async()=>'',voce:async()=>Buffer.alloc(0),scriviLavoro:()=>false,registraDispositivo:()=>{},log:()=>{}});
 let claims=0; const claim=queue.claim.bind(queue); queue.claim=(x)=>{claims++;return claim(x)};
 const token=leggiGettone(home); const call=async(route,body,authenticated=true)=>{
  const response=await fetch(`http://127.0.0.1:${port}/v1/worker/${route}`,{method:body===undefined?'GET':'POST',headers:{...(authenticated?{authorization:`Bearer ${token}`}:{})},body:body===undefined?undefined:JSON.stringify(body)});
  return {code:response.status,data:await response.json()};
 };
 const worker={id:'fixture-phone',capacity:1,available:true,capabilities:[{operation:'embeddings',implementation:'apple-nl-it',revision:1,dimension:640}]};
 try {
  await ponte.start();
  assert.equal((await call('status',undefined,false)).code,401);
  const waiting=call('claim',{worker});
  await new Promise(r=>setTimeout(r,150));
  assert.equal(claims,1,'own presence filesystem writes must not busy-loop claim');
  const job={id:'avo-fixture',origin:'avo',operation:'embeddings',input:{texts:['Una memoria condivisa.']}};
  assert.equal((await call('jobs',job)).code,200);
  const lease=(await waiting).data.job; assert.equal(lease.id,job.id); assert.equal(lease.origin,'avo');
  assert.equal((await call('presence',{worker:{...worker,available:false}})).code,200);
  assert.equal((await call('jobs/'+job.id)).data.job.state,'queued');
  const stale={jobId:lease.id,leaseToken:lease.leaseToken,attempt:lease.attempt,result:{implementation:'apple-nl-it',revision:1,dimension:640,vectors:[Array.from({length:640},(_,i)=>i===0?1:0)]},metrics:{elapsedMs:1,cpuMs:1}};
  assert.equal((await call('complete',stale)).code,409);
  const current=(await call('claim',{worker})).data.job;
  const valid={...stale,leaseToken:current.leaseToken,attempt:current.attempt};
  assert.equal((await call('complete',valid)).data.duplicate,false);
  assert.equal((await call('complete',valid)).data.duplicate,true);
  assert.equal((await call('jobs/'+job.id)).data.job.state,'completed');
  const large={id:'large-image',origin:'bottega',operation:'ocr',input:{mimeType:'image/png',imageBase64:Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]),Buffer.alloc(20000)]).toString('base64')}};
  assert.equal((await call('jobs',large)).code,200,'worker input exceeds legacy16KB limit');
  assert.equal((await call('jobs/'+large.id+'/cancel',{})).data.job.state,'cancelled');
 } finally { ponte.stop(); fs.rmSync(home,{recursive:true,force:true}); }
});
