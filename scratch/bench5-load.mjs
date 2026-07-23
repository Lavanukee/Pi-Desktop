import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
const SERVER='/Users/jedd/.cache/pi-desktop/llamacpp/b9934/llama-b9934/llama-server';
const MODEL='/Users/jedd/.cache/pi-desktop/models/qwen3.5-4b-mtp/Qwen3.5-4B-Q8_0.gguf';
const ARGS=['-c','8192','--parallel','1','--spec-type','draft-mtp','--spec-draft-n-max','2'];
function freePort(){return new Promise((r,j)=>{const s=createServer();s.on('error',j);s.listen(0,'127.0.0.1',()=>{const p=s.address().port;s.close(()=>r(p));});});}
async function loadOnce(){
  const port=await freePort();const t0=performance.now();
  const child=spawn(SERVER,['-m',MODEL,'--host','127.0.0.1','--port',String(port),...ARGS],{stdio:['ignore','ignore','ignore']});
  const d=Date.now()+90000;let ready=null;
  while(Date.now()<d){try{const r=await fetch(`http://127.0.0.1:${port}/health`);if(r.ok){ready=performance.now()-t0;break;}}catch{}await new Promise(r=>setTimeout(r,30));}
  // measure first real prefill (weights fully paged) right after health
  const rr=await fetch(`http://127.0.0.1:${port}/v1/chat/completions`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({messages:[{role:'user',content:'Say hi.'}],max_tokens:4,temperature:0})});
  const firstReqEnd=performance.now()-t0;await rr.json();
  child.kill('SIGTERM');await new Promise(r=>setTimeout(r,500));child.kill('SIGKILL');
  return {ready,firstReqEnd};
}
const R=[];for(let i=0;i<3;i++){R.push(await loadOnce());}
const mean=a=>a.reduce((x,y)=>x+y,0)/a.length;
console.log('spawn->health (ms):',R.map(r=>r.ready.toFixed(0)).join(', '),' mean',mean(R.map(r=>r.ready)).toFixed(0));
console.log('spawn->first-token-done (ms):',R.map(r=>r.firstReqEnd.toFixed(0)).join(', '),' mean',mean(R.map(r=>r.firstReqEnd)).toFixed(0));
