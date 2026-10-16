import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {loadWorker,query,source,ride} from './helpers/worker.mjs';

const cities=JSON.parse(fs.readFileSync(new URL('../cities.json',import.meta.url)));
const index=JSON.parse(fs.readFileSync(new URL('../rn-hub-index.json',import.meta.url)));
function memoryCache(){
 const store=new Map();
 return {store,async get(k,type){const x=store.get(k);return x===undefined?null:type==='json'?JSON.parse(x):x},async put(k,v){store.set(k,v)}};
}
const options={geo:cities,hubIndex:index,rnHubEnabled:true,origin:'taubate',destination:'uberlandia',maxTransfers:2,maxWait:720};

test('segment cache reuses successful leg responses between searches',async()=>{
 const upstream=source({'taubate|ribeirao-preto':[ride('05:00','07:00')],
   'ribeirao-preto|uberlandia':[ride('08:00','11:00')]}),cache=memoryCache(),api=loadWorker({fetch:upstream.fetch,cache});
 const first=await query(api,options),callsAfterFirst=upstream.calls.length;
 const second=await query(api,options);
 assert.ok(first.body.count>0);assert.ok(second.body.count>0);
 assert.ok(callsAfterFirst>0);assert.ok(upstream.calls.length-callsAfterFirst<callsAfterFirst);
 assert.ok(cache.store.size>0);
});

test('source errors are not cached and can recover on the next request',async()=>{
 let shouldFail=true,calls=0;
 const upstream={fetch:async input=>{calls++;if(shouldFail)return new Response('Unavailable',{status:503});
   const route=source({'taubate|ribeirao-preto':[ride('05:00','07:00')],
     'ribeirao-preto|uberlandia':[ride('08:00','11:00')]});return route.fetch(input)}};
 const cache=memoryCache(),api=loadWorker({fetch:upstream.fetch,cache});
 await query(api,options);const afterFailure=calls;shouldFail=false;
 const recovered=await query(api,options);
 assert.ok(calls>afterFailure);assert.ok(recovered.body.count>0);
});

test('segment cache key isolates direction, date, and provider route slugs',async()=>{
 const cache=memoryCache(),api=loadWorker({fetch:source({}).fetch,cache});
 // Cold requests are retained by exact source direction and requested date.
 for(const [from,to,date] of [['taubate','ribeirao-preto','2026-10-14'],
   ['ribeirao-preto','taubate','2026-10-14'],['taubate','ribeirao-preto','2026-10-15']]){
  await api.worker.fetch(new Request(`https://rua-nossa.example/api/exists?date=${date}&origin=${from}&destination=${to}&mode=transfers&maxTransfers=2&maxWait=90`),
   {ASSETS:{fetch:async input=>Response.json(new URL(input).pathname==='/rn-hub-index.json'?index:cities)},RN_HUB_ENABLED:'1',RIDES_CACHE:cache});
 }
 const keys=[...cache.store.keys()];
 assert.ok(keys.some(key=>key.includes('2026-10-14:taubate:campinas')));
 assert.ok(keys.some(key=>key.includes('2026-10-14:campinas:taubate')));
 assert.ok(keys.some(key=>key.includes('2026-10-15:taubate:campinas')));
});
