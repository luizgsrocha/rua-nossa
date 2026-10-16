import {performance} from 'node:perf_hooks';
import fs from 'node:fs';
import {loadWorker,query,source,ride,html} from '../tests/helpers/worker.mjs';

const CITIES=JSON.parse(fs.readFileSync(new URL('../cities.json',import.meta.url)));
const INDEX=JSON.parse(fs.readFileSync(new URL('../rn-hub-index.json',import.meta.url)));
const ITERATIONS=Number(process.env.BENCH_ITERATIONS||30);
const DELAY_MS=Number(process.env.BENCH_SOURCE_DELAY_MS||18);
const OFFERS={
 'taubate|ribeirao-preto':[ride('05:00','07:00','tr-1','60')],
 'ribeirao-preto|uberlandia':[ride('08:00','11:00','tr-2','70')],
 'sao-paulo|ribeirao-preto':[ride('06:00','08:00','sp-1','80')],
 'sao-paulo|campinas':[ride('06:30','08:00','sp-2','30')],
 'campinas|uberlandia':[ride('09:00','13:00','sp-3','100')],
};
const FAIL=['taubate|uberaba'];
const FIXED_DATE='2026-10-16';

function makeCache(){
 const values=new Map();
 return {
  async get(key,type){const entry=values.get(key);if(!entry)return null;if(entry.expires<Date.now()){values.delete(key);return null}return type==='json'?JSON.parse(entry.value):entry.value},
  async put(key,value,{expirationTtl}={}){values.set(key,{value,expires:Date.now()+(expirationTtl||60)*1000})},
  get size(){return values.size},clear(){values.clear()}
 };
}
function delayedSource({unavailable=false}={}){
 const calls=[];
 return {calls,fetch:async input=>{
  const url=new URL(input),m=url.pathname.match(/\/horario\/([^/]+)\/([^/]+)/);
  if(!m)throw new Error('Unrecognized source URL '+url.href);
  const pair=m[1]+'|'+m[2];calls.push(pair);
  await new Promise(resolve=>setTimeout(resolve,DELAY_MS));
  return new Response(unavailable||FAIL.includes(pair)?'Unavailable':html(OFFERS[pair]||[]),{status:unavailable||FAIL.includes(pair)?503:200});
 }};
}
function percentile(values,p){const sorted=[...values].sort((a,b)=>a-b);return sorted[Math.ceil(p*sorted.length)-1]??0}
function stats(values){return{meanMs:+(values.reduce((a,b)=>a+b,0)/values.length).toFixed(3),p50Ms:+percentile(values,.50).toFixed(3),p95Ms:+percentile(values,.95).toFixed(3),minMs:+Math.min(...values).toFixed(3),maxMs:+Math.max(...values).toFixed(3)}}
async function measured(api,upstream,cache,kind){
 const latencies=[],requests=[],errors=[],incomplete=0,routeCounts=[];
 for(let i=0;i<ITERATIONS;i++){
  const route=i%2===0?['taubate','uberlandia']:['sao-paulo','uberlandia'];
  if(kind==='cold')cache.clear();
  const fromCalls=upstream.calls.length,start=performance.now();
  try{
   const result=await query(api,{geo:CITIES,hubIndex:INDEX,rnHubEnabled:true,origin:route[0],destination:route[1],maxTransfers:2,maxWait:720,date:FIXED_DATE,debug:'1'});
   latencies.push(performance.now()-start);requests.push(upstream.calls.length-fromCalls);routeCounts.push(result.body.count);if(result.body.incomplete)incomplete++;
   if(result.status>=500)errors.push(result.status);
  }catch(error){latencies.push(performance.now()-start);requests.push(upstream.calls.length-fromCalls);errors.push(error.name||'Error');}
 }
 const totalExternal=requests.reduce((a,b)=>a+b,0);
 return{kind,iterations:ITERATIONS,latency:stats(latencies),externalRequests:totalExternal,requestsPerSearch:+(totalExternal/ITERATIONS).toFixed(3),errors:errors.length,incompleteSearches:incomplete,routesFound:routeCounts.reduce((a,b)=>a+b,0),cacheEntries:cache.size};
}
async function runScenario(kind){
 const cache=kind==='baseline'?null:makeCache(),upstream=delayedSource(),api=loadWorker({fetch:upstream.fetch,cache});
 const first=await measured(api,upstream,cache||{size:0},kind);
 return{...first,cacheEntries:cache?.size||0};
}
const scenarios={baseline:await runScenario('baseline'),cold:await runScenario('cold'),warm:await runScenario('warm')};
// Cross-search sharing: execute the two distinct journeys twice with one shared cache
// and count exact provider calls avoided compared with the same cold pair of journeys.
const crossCache=makeCache(),crossSource=delayedSource(),crossApi=loadWorker({fetch:crossSource.fetch,cache:crossCache});
const crossStartCalls=crossSource.calls.length;
for(const route of [['taubate','uberlandia'],['sao-paulo','uberlandia'],['taubate','uberlandia'],['sao-paulo','uberlandia']])
 await query(crossApi,{geo:CITIES,hubIndex:INDEX,rnHubEnabled:true,origin:route[0],destination:route[1],maxTransfers:2,maxWait:720,date:FIXED_DATE});
const crossTotal=crossSource.calls.length-crossStartCalls;
const outageSource=delayedSource({unavailable:true}),outageApi=loadWorker({fetch:outageSource.fetch,cache:makeCache()}),outageStart=performance.now();
const outage=await query(outageApi,{geo:CITIES,hubIndex:INDEX,rnHubEnabled:true,origin:'taubate',destination:'uberlandia',maxTransfers:2,maxWait:720,date:FIXED_DATE,debug:'1'});
const outageResult={latencyMs:+(performance.now()-outageStart).toFixed(3),status:200,externalErrors:outageSource.calls.length,incomplete:outage.body.incomplete,routes:outage.body.count};
const result={generatedAt:new Date().toISOString(),method:{iterations:ITERATIONS,delayMs:DELAY_MS,provider:'deterministic local mock; no live upstream calls',cacheTtlSeconds:180,scenarioOrder:'each scenario has a fresh worker and cache; baseline has no cache binding',warmDefinition:'same cache binding retained across measured queries, alternating two query shapes',metrics:'worker response latency measured with performance.now(); external requests count actual mocked fetch invocations'},scenarios,totalOutage:outageResult,crossSearch:{queries:4,externalRequests:crossTotal,expectedWithoutCache:scenarios.baseline.externalRequests*4/ITERATIONS,cacheEntries:crossCache.size},
 routeNames:'Taubaté → Uberlândia and São Paulo → Uberlândia; offer graph intentionally shares a final segment and includes one unavailable pair.'};
console.log(JSON.stringify(result,null,2));
