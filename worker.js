import{RN_HUB_VERSION,selectRnHubCandidates}from"./rn-hub.js";
const CITIES={pirassununga:{name:"Pirassununga",slug:"pirassununga",lat:-21.996,lng:-47.426},taubate:{name:"Taubaté",slug:"taubate",lat:-23.026,lng:-45.555},"sao-jose-dos-campos":{name:"São José dos Campos",slug:"sao-jose-dos-campos",lat:-23.189,lng:-45.884},campinas:{name:"Campinas",slug:"campinas",lat:-22.906,lng:-47.061}};
const DEFAULT_MIN_WAIT=5,DEFAULT_MAX_WAIT=720,DEFAULT_MAX_TRANSFERS=2,MAX_TRANSFERS=10;
export default{async fetch(request,env){
 const u=new URL(request.url);
 if(u.pathname==="/api/blablacar-lab")return blablacarLab(request,env);
 if(u.pathname==="/api/blablacar-trip-lab")return blablacarTripLab(request);
 if(u.pathname==="/api/cities"){try{const data=await loadLocalCities(env,request);return json(data.map(({name,slug,uf})=>({name,slug,uf})))}catch{return json({error:"Falha ao carregar municípios"},502)}}
 if(u.pathname!=="/api/exists"){const r=await env.ASSETS.fetch(request),h=new Headers(r.headers);if(u.pathname==="/"||u.pathname.endsWith(".html"))h.set("Cache-Control","no-cache, no-store, must-revalidate");else if(u.pathname.endsWith(".js")||u.pathname.endsWith(".css"))h.set("Cache-Control","public, max-age=0, must-revalidate");return new Response(r.body,{status:r.status,statusText:r.statusText,headers:h})}
 try{
  const date=u.searchParams.get("date"),origin=u.searchParams.get("origin")||"pirassununga",key=u.searchParams.get("destination")||"taubate",originName=u.searchParams.get("originName")||displayName(origin),destinationName=u.searchParams.get("destinationName")||displayName(key),minWait=parseWait(u.searchParams.get("minWait"),DEFAULT_MIN_WAIT),maxWait=parseWait(u.searchParams.get("maxWait"),DEFAULT_MAX_WAIT),maxTransfers=parseWait(u.searchParams.get("maxTransfers"),DEFAULT_MAX_TRANSFERS);
  if(minWait<0||maxWait<minWait||maxWait>720)return json({error:"Intervalo de espera inválido"},400);
  if(maxTransfers<0||maxTransfers>MAX_TRANSFERS)return json({error:"Quantidade máxima de baldeações inválida"},400);
  if(!/^\d{4}-\d{2}-\d{2}$/.test(date||""))return json({error:"Data inválida"},400);
  if(!validSlug(origin)||!validSlug(key))return json({error:"Cidade inválida"},400);
  if(origin===key)return json({error:"Origem e destino devem ser diferentes"},400);
  const mode=u.searchParams.get("mode")||"all";
  if(!["all","direct","transfers"].includes(mode))return json({error:"Modo inválido"},400);
  let routes,incomplete=false,diagnostics=null;
  const geo=await loadLocalCities(env,request),rnHubEnabled=env.RN_HUB_ENABLED==="1";
  if(mode==="direct"||maxTransfers===0){const rides=await getDirectRides(origin,key,date,fromBuscaSlug(geo,origin),fromBuscaSlug(geo,key),Infinity,0,env);routes=rides.map(ride=>makeRoute([{from:origin,to:key,fromName:originName,toName:destinationName,ride}]));if(mode==="transfers")routes=[]}
  else{
   const strategy=classifySearchStrategy(geo,origin,key),hubIndex=rnHubEnabled?await loadRnHubIndex(env,request):null;
   const search=await findRoutes(origin,key,date,originName,destinationName,minWait,maxWait,maxTransfers,geo,mode!=="transfers",strategy,{rnHubEnabled:rnHubEnabled&&!!hubIndex,hubIndex,segmentCache:env.RIDES_CACHE});
   routes=search.routes;incomplete=search.incomplete;diagnostics=search.diagnostics;if(mode==="transfers")routes=routes.filter(x=>x.legs.length>1);
  }
  const direct=routes.filter(x=>x.legs.length===1),transfers=routes.filter(x=>x.legs.length>1);
  return json({date,origin,originName,destination:key,destinationName,mode,exists:routes.length>0,count:routes.length,directCount:direct.length,transferCount:transfers.length,source:"BuscaOnibus",incomplete,diagnostics:u.searchParams.get("debug")==="1"?diagnostics:undefined,warning:incomplete?"Alguns trechos não puderam ser consultados. Os resultados podem estar incompletos.":null,routes});
 }catch(e){if(e.name==="SearchTimeoutError")return json({error:e.message,code:"SEARCH_TIMEOUT"},504);if(e.name==="SourceUnavailableError")return json({error:e.message,code:"SOURCE_UNAVAILABLE"},502);return json({error:"Falha ao consultar as caronas",detail:String(e&&e.message||e)},502)}
}};
// BRG v0.7.1: bounded, time-aware graph search with fixed and geographic hubs.
const HUB_SLUGS=new Set(["sao-paulo","campinas","sao-jose-dos-campos","sorocaba","ribeirao-preto","jundiai","piracicaba","bauru","sao-jose-do-rio-preto","araraquara","limeira","americana","belo-horizonte","uberlandia","juiz-de-fora","pocos-de-caldas","rio-de-janeiro","niteroi","volta-redonda","curitiba","londrina","maringa","ponta-grossa","cascavel"]);
const BRG_BEAM_WIDTH=12,BRG_MAX_HUBS=10,BRG_MAX_QUERIES=55,BRG_MAX_RESULTS=80,MAX_GEO_HUBS=6;
async function findRoutes(origin,target,date,originName,targetName,minWait,maxWait,maxTransfers,geo,includeDirect=true,strategy="short",options={}){
 const deadline=Date.now()+300000;
 const diagnostics={algorithm:options.rnHubEnabled?RN_HUB_VERSION:`legacy-${strategy}`,planned:0,completed:0,failed:0,backwardProbes:0,backwardReachable:0,skippedBudget:0,skippedDepthBudget:0,skippedBeam:0,skippedDetour:0,rejectedWait:0,queryLimit:BRG_MAX_QUERIES,selectedHubs:[],queriedPairs:[],skippedPairs:[]};
 const recordSkip=(reason,key)=>{diagnostics[reason]++;if(diagnostics.skippedPairs.length<100)diagnostics.skippedPairs.push({pair:key,reason})};
 const direct=includeDirect?await getDirectRides(origin,target,date,fromBuscaSlug(geo,origin),fromBuscaSlug(geo,target),deadline,options.rnHubEnabled?60:0,{RIDES_CACHE:options.segmentCache}):[];
 const routes=direct.map(ride=>makeRoute([{from:origin,to:target,fromName:originName,toName:targetName,ride}]));
 const from=geo.find(c=>c.slug===origin),to=geo.find(c=>c.slug===target);
 if(!from||!to)return{routes,incomplete:false,diagnostics};
 let hubs;
 try{hubs=options.rnHubEnabled?selectRnHubCandidates(geo,from,to,options.hubIndex):strategy==="long"?selectHubs(geo,from,to):selectBrgHubs(geo,from,to)}
 catch{hubs=[]}
 if(!hubs.length)hubs=strategy==="long"?selectHubs(geo,from,to):selectBrgHubs(geo,from,to);
 diagnostics.selectedHubs=hubs.map(city=>`${city.slug}:${city.uf||""}`);
 const nodes=[...hubs,to],cache=new Map(),seenRoutes=new Set(),backwardReachable=new Set();
 let incomplete=false,queries=0,frontier=[{city:from,legs:[],visited:new Set([from.slug]),length:0,arrival:-1}];
 const directDistance=Math.max(1,distance(from,to));
 const maxDetour=options.rnHubEnabled?Math.min(250,Math.max(60,directDistance*.30)):strategy==="long"?Math.min(90,Math.max(15,directDistance*.18)):60;
 async function ridesBetween(a,b){
   const key=a.slug+"|"+b.slug;
   if(cache.has(key))return cache.get(key);
   if(queries>=BRG_MAX_QUERIES){incomplete=true;recordSkip("skippedBudget",key);return [];}
   queries++;
   let result;
   try{result=await getDirectRides(a.slug,b.slug,date,a.buscaOnibusSlug||a.slug,b.buscaOnibusSlug||b.slug,deadline,options.rnHubEnabled?60:0,{RIDES_CACHE:options.segmentCache});diagnostics.completed++;diagnostics.queriedPairs.push(key)}
   catch(error){if(!["SourceUnavailableError","SearchTimeoutError"].includes(error.name))throw error;incomplete=true;diagnostics.failed++;diagnostics.queriedPairs.push(key+" [failed]");result=[]}
   cache.set(key,result);
   return result;
 }
 if(options.rnHubEnabled){
   // Destination-side discovery verifies real final legs before the forward
   // beam spends its budget. Results share the same request cache.
   for(const hub of hubs.slice().reverse().slice(0,Math.min(6,hubs.length))){
     diagnostics.backwardProbes++;
     const rides=await ridesBetween(hub,to);
     if(rides.length)backwardReachable.add(hub.slug);
   }
   diagnostics.backwardReachable=backwardReachable.size;
 }
 // Each depth is one ride. At most maxTransfers+1 rides are allowed.
 for(let depth=0;depth<maxTransfers+1&&frontier.length;depth++){
   if(Date.now()>=deadline)return{routes,incomplete:true,diagnostics};
   const proposals=[];
   for(const state of frontier){
     for(const next of nodes){
       if(state.visited.has(next.slug))continue;
       if(!state.legs.length&&next.slug===to.slug)continue; // Direct search is handled separately.
       const legDistance=distance(state.city,next);
       const newLength=state.length+legDistance;
       // Total travel distance must remain within a bounded detour.
       if(newLength+distance(next,to)>directDistance+maxDetour){diagnostics.skippedDetour++;continue;}
       // All non-final legs must leave room for a later connection.
       if(next.slug!==to.slug&&depth===maxTransfers)continue;
       proposals.push({state,next,newLength,score:(newLength+distance(next,to))/directDistance+depth*.08});
     }
   }
   diagnostics.planned+=proposals.length;
   proposals.sort((a,b)=>Number(b.next.slug===to.slug)-Number(a.next.slug===to.slug)||Number(backwardReachable.has(b.next.slug))-Number(backwardReachable.has(a.next.slug))||Number(HUB_SLUGS.has(b.next.slug))-Number(HUB_SLUGS.has(a.next.slug))||a.score-b.score);
   // Prioritize finishing a journey, but preserve a bounded search budget.
   // Fair scheduling: inspect at least one destination connection per arrival city
    // before spending the per-depth budget on many departures from one hub.
    const finishes=proposals.filter(p=>p.next.slug===to.slug);
    const byOrigin=new Map();
    for(const p of finishes){
      const key=p.state.city.slug;
      if(!byOrigin.has(key))byOrigin.set(key,[]);
      byOrigin.get(key).push(p);
    }
    const fairFinishes=[];
    while([...byOrigin.values()].some(list=>list.length)){
      for(const list of byOrigin.values())if(list.length)fairFinishes.push(list.shift());
    }
    const picked=fairFinishes.concat(proposals.filter(p=>p.next.slug!==to.slug));
   const nextFrontier=[];
   // Inspect every selected first-hop hub even when the passenger permits more
   // transfers. The global query cap still bounds the complete search.
   const depthBudget=Math.max(BRG_BEAM_WIDTH,Math.floor(BRG_MAX_QUERIES/(maxTransfers+1)));
   let depthQueries=0;
   for(const p of picked){
     if(Date.now()>=deadline)return{routes,incomplete:true,diagnostics};
     const pairKey=p.state.city.slug+"|"+p.next.slug;
     if(!cache.has(pairKey)&&depthQueries>=depthBudget){incomplete=true;recordSkip("skippedDepthBudget",pairKey);continue;}
     if(!cache.has(pairKey))depthQueries++;
     if(queries>=BRG_MAX_QUERIES&&!cache.has(pairKey)){incomplete=true;recordSkip("skippedBudget",pairKey);continue;}
     const rides=await ridesBetween(p.state.city,p.next);
     for(const ride of rides){
       const departure=minutes(ride.departure),arrival=minutes(ride.arrival);
       if(departure<0||arrival<0)continue;
       if(p.state.legs.length){
         // The source does not provide a reliable next-day date for connections.
         const wait=departure-p.state.arrival;
         if(wait<minWait||wait>maxWait){diagnostics.rejectedWait++;continue;}
       }
       const leg={from:p.state.city.slug,to:p.next.slug,fromName:p.state.city.name,toName:p.next.name,ride};
       const legs=[...p.state.legs,leg];
       if(p.next.slug===to.slug){
         if(legs.length<2)continue; // Direct rides were already fetched.
         const key=legs.map(x=>x.from+"-"+x.to+"-"+x.ride.departure+"-"+x.ride.arrival).join("|");
         if(!seenRoutes.has(key)){seenRoutes.add(key);routes.push(makeRoute(legs))}
       }else{
         const visited=new Set(p.state.visited);visited.add(p.next.slug);
         // Every departure belongs to the requested date. An overnight arrival
         // is on the following day and cannot connect to another same-date ride.
         const arrivalOnSearchDate=arrival+(arrival<departure?1440:0);
         nextFrontier.push({city:p.next,legs,visited,length:p.newLength,arrival:arrivalOnSearchDate});
       }
       if(routes.length>=BRG_MAX_RESULTS)break;
     }
     if(routes.length>=BRG_MAX_RESULTS)break;
   }
   if(routes.length>=BRG_MAX_RESULTS)break;
   nextFrontier.sort((a,b)=>(a.length+distance(a.city,to))/directDistance+a.legs.length*.08-(b.length+distance(b.city,to))/directDistance-b.legs.length*.08);
   const unique=new Set();
   const candidates=nextFrontier.filter(s=>{const key=s.city.slug+"|"+s.arrival+"|"+s.legs.length;if(unique.has(key))return false;unique.add(key);return true});
   const byCity=new Map();
   for(const state of candidates){if(!byCity.has(state.city.slug))byCity.set(state.city.slug,[]);byCity.get(state.city.slug).push(state)}
   diagnostics.skippedBeam+=Math.max(0,candidates.length-BRG_BEAM_WIDTH);
   if(candidates.length>BRG_BEAM_WIDTH)incomplete=true;
   frontier=[];
   // Reserve room for each hub before taking additional departures from one city.
   while(frontier.length<BRG_BEAM_WIDTH){let added=false;for(const states of byCity.values()){if(!states.length)continue;frontier.push(states.shift());added=true;if(frontier.length===BRG_BEAM_WIDTH)break}if(!added)break}
 }
 return{routes,incomplete,diagnostics};
}
// Threshold is defined by the actual registered Taubaté and Ribeirão Preto coordinates.
function classifySearchStrategy(cities,origin,target){
 const from=cities.find(c=>c.slug===origin),to=cities.find(c=>c.slug===target);
 const taubate=cities.find(c=>c.slug==="taubate"),ribeirao=cities.find(c=>c.slug==="ribeirao-preto");
 if(![from,to,taubate,ribeirao].every(c=>c&&Number.isFinite(c.lat)&&Number.isFinite(c.lng)))return "short";
 return distance(from,to)<=distance(taubate,ribeirao)+1e-9?"short":"long";
}
function selectBrgHubs(cities,from,to){
 const direct=Math.max(1,distance(from,to));
 const candidates=cities.filter(c=>c.slug!==from.slug&&c.slug!==to.slug&&Number.isFinite(c.lat)&&Number.isFinite(c.lng)).map(city=>{
   const first=distance(from,city),second=distance(city,to);
   const detour=first+second-direct,ratio=(first+second)/direct;
   return {city,first,detour,ratio,priority:HUB_SLUGS.has(city.slug)};
 }).filter(x=>x.first>5&&distance(x.city,to)>5&&x.detour<=60);
 const fixed=candidates.filter(x=>x.priority).sort((a,b)=>a.ratio-b.ratio||a.city.slug.localeCompare(b.city.slug));
 const dynamic=candidates.filter(x=>!x.priority).sort((a,b)=>a.ratio-b.ratio||a.city.slug.localeCompare(b.city.slug));
 const selected=[];
 // Guarantee up to six fixed hubs first, then fill remaining with dynamic candidates.
 for(const x of fixed.slice(0,6)){
   if(selected.length>=6)break;
   if(!selected.some(y=>y.city.slug===x.city.slug))selected.push(x);
 }
 for(const x of dynamic){
   if(selected.length>=BRG_MAX_HUBS)break;
   if(selected.some(y=>distance(y.city,x.city)<25))continue;
   selected.push(x);
 }
 return selected.slice(0,BRG_MAX_HUBS).map(x=>x.city);
}
async function loadLocalCities(env,request){const url=new URL("/cities.json",request.url),r=await env.ASSETS.fetch(url);if(!r.ok)throw new Error("Base local de cidades indisponível");const data=await r.json();if(!Array.isArray(data))throw new Error("Base local de cidades inválida");return data}
let rnHubIndexPromise;
async function loadRnHubIndex(env,request){
 if(!rnHubIndexPromise)rnHubIndexPromise=env.ASSETS.fetch(new URL("/rn-hub-index.json",request.url)).then(async response=>{
   if(!response.ok)throw new Error("Índice RN-HUB indisponível");
   const index=await response.json();
   if(index?.version!==RN_HUB_VERSION||!index.records)throw new Error("Índice RN-HUB incompatível");
   return index;
 }).catch(()=>{rnHubIndexPromise=undefined;return null});
 return rnHubIndexPromise;
}
function findGeoCity(cities,label){const n=normalizeName(label);return cities.find(x=>normalizeName(x.name)===n)}
function normalizeName(v){return String(v||"").normalize("NFD").replace(/[\u0300-\u036f]/g,"").trim().toLowerCase()}
function selectHubs(cities,from,to){
 const direct=distance(from,to);
 if(!Number.isFinite(direct)||direct<15)return [];
 // Straight-line distance is a candidate heuristic, not a road routing estimate.
 const maxDetour=Math.min(90,Math.max(15,direct*.18));
 const candidates=cities.filter(c=>{
   if(c.slug===from.slug||c.slug===to.slug||!Number.isFinite(c.lat)||!Number.isFinite(c.lng))return false;
   const first=distance(from,c),second=distance(c,to);
   const progress=direct-second,detour=first+second-direct;
   return first>=8&&second>=8&&progress>5&&progress<direct-5&&detour<=maxDetour;
 }).map(c=>{
   const first=distance(from,c),second=distance(c,to);
   const detour=first+second-direct;
   // Prefer little detour and hubs distributed along the route.
   return {city:c,detour,progress:first/direct,score:detour/Math.max(1,direct)+Math.abs(first/direct-.5)*.12};
 }).sort((a,b)=>a.score-b.score||a.city.slug.localeCompare(b.city.slug));
 const selected=[];
 // Avoid spending all six requests on neighboring towns.
 for(const candidate of candidates){
   if(selected.some(x=>distance(x.city,candidate.city)<Math.min(35,Math.max(12,direct*.1))))continue;
   selected.push(candidate);
   if(selected.length===MAX_GEO_HUBS)break;
 }
 return selected.map(x=>x.city).sort((a,b)=>distance(from,a)-distance(from,b));
}
function waitMinutes(arrival,departure){const a=minutes(arrival),b=minutes(departure);if(a<0||b<0)return-1;return b>=a?b-a:b+1440-a}
function makeRoute(legs){return{legs,totalPrice:legs.reduce((s,x)=>s+price(x.ride.price),0)}}
function fromBuscaSlug(cities,slug){const c=cities.find(x=>x.slug===slug);return c&&c.buscaOnibusSlug||slug}
function sourceUnavailable(){const error=new Error("A fonte de caronas está indisponível. Tente novamente em alguns instantes.");error.name="SourceUnavailableError";return error}
function searchTimeout(){const error=new Error("A consulta demorou demais. Tente novamente.");error.name="SearchTimeoutError";return error}
async function fetchRidePage(url,options,deadline=Infinity){
 const remaining=Math.min(30000,deadline-Date.now());
 if(remaining<=0)throw searchTimeout();
 const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),remaining);
 try{
   const response=await fetch(url,{...options,signal:controller.signal});
   if(!response.ok){await response.body?.cancel();throw sourceUnavailable()}
   // Keep the timer active while reading the body, not only until headers arrive.
   const html=await response.text();
   if(controller.signal.aborted||Date.now()>=deadline)throw searchTimeout();
   return{ok:true,html};
 }catch(error){if(controller.signal.aborted)throw searchTimeout();if(error.name==="SearchTimeoutError")throw error;throw sourceUnavailable()}
 finally{clearTimeout(timer)}
}
const SEGMENT_CACHE_VERSION="v1",SEGMENT_CACHE_TTL=180;
async function getDirectRides(from,to,date,fromBusca=from,toBusca=to,deadline=Infinity,cacheTtl=0,env={}){
 const cache=env.RIDES_CACHE,cacheKey="rn:segment:"+SEGMENT_CACHE_VERSION+":"+date+":"+fromBusca+":"+toBusca;
 if(cache&&typeof cache.get==="function"){
  try{const value=await cache.get(cacheKey,"json");if(Array.isArray(value))return value}catch{}
 }
 const [y,m,d]=date.split("-"),sourceUrl="https://www.buscaonibus.com.br/horario/"+fromBusca+"/"+toBusca+"?dt="+d+"%2F"+m+"%2F"+y,r=await fetchRidePage(sourceUrl,{headers:{"Accept":"text/html","Accept-Language":"pt-BR,pt;q=0.9","User-Agent":"Mozilla/5.0 (compatible; RuaNossa/1.0)"},cf:{cacheTtl,cacheEverything:cacheTtl>0}},deadline);
 const html=decode(r.html),rides=[],seen=new Set();
 const add=(departure,arrival,ridePrice,rideUrl)=>{if(!departure||!arrival)return;const key=[departure,arrival,ridePrice||""].join("|");if(seen.has(key))return;seen.add(key);rides.push({departure,arrival,price:ridePrice,url:rideUrl||sourceUrl})};
 for(const match of html.matchAll(/href=["']([^"']+)["']/gi)){try{const href=decode(match[1]),buyUrl=new URL(href,"https://www.buscaonibus.com.br"),isBlaBla=/\/comprar-passagem\/blablacar(?:\/|$)/i.test(buyUrl.pathname),deep=buyUrl.searchParams.get("deep_link"),validDeep=deep&&/^https:\/\/(www\.)?blablacar\.com\.br\/trip(?:\?|\/)/i.test(deep);if(!isBlaBla&&!validDeep)continue;add(buyUrl.searchParams.get("departure"),buyUrl.searchParams.get("arrival"),buyUrl.searchParams.get("price"),validDeep?deep:buyUrl.href)}catch{}}
 const text=html.replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi," ").replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi," ").replace(/<[^>]+>/g," ").replace(/&nbsp;|&#160;/gi," ").replace(/\s+/g," ");
 for(const section of text.split(/Caronas oferecidas pela BlaBlaCar/i).slice(1)){const block=section.split(/(?:Caronas oferecidas pela BlaBlaCar|Assentos livres|Ofertas de Carona\d*|Escolha um dos nossos parceiros)/i)[0];for(const m of block.matchAll(/(\d{1,2}:\d{2})\s+(\d{1,2}:\d{2})\s+R\$\s*([\d.,]+)\s+Reservar/gi))add(m[1],m[2],m[3].replace(".","").replace(",","."),sourceUrl)}
 if(cache&&typeof cache.put==="function")try{await cache.put(cacheKey,JSON.stringify(rides),{expirationTtl:SEGMENT_CACHE_TTL})}catch{}
 return rides
}
async function getRides(from,to,date,fromBusca=from,toBusca=to,deadline=Infinity){const [y,m,d]=date.split("-"),url="https://www.buscaonibus.com.br/horario/"+fromBusca+"/"+toBusca+"?dt="+d+"%2F"+m+"%2F"+y,r=await fetchRidePage(url,{headers:{"Accept":"text/html","Accept-Language":"pt-BR,pt;q=0.9","User-Agent":"Mozilla/5.0 (compatible; RuaNossa/1.0)"},cf:{cacheTtl:0}},deadline);const html=decode(r.html),rides=[],seen=new Set();for(const match of html.matchAll(/href=["']([^"']*deep_link=[^"']+)["']/gi)){try{const href=decode(match[1]),buyUrl=new URL(href,"https://www.buscaonibus.com.br"),deep=buyUrl.searchParams.get("deep_link");if(!deep||!/^https:\/\/(www\.)?blablacar\.com\.br\/trip(?:\?|\/)/i.test(deep)||seen.has(deep))continue;seen.add(deep);rides.push({departure:buyUrl.searchParams.get("departure"),arrival:buyUrl.searchParams.get("arrival"),price:buyUrl.searchParams.get("price"),url:deep})}catch{}}return rides}
function parseWait(v,fallback){if(v===null||v==="")return fallback;const n=Number(v);return Number.isInteger(n)?n:-1}function validSlug(v){return /^[a-z0-9-]{2,80}$/.test(v)}function displayName(v){return v.split("-").map(x=>x.charAt(0).toUpperCase()+x.slice(1)).join(" ")+", SP"}function slugify(v){return v.normalize("NFD").replace(/[\u0300-\u036f]/g,"").toLowerCase().replace(/[^a-z0-9]+/g,"-").replace(/^-|-$/g,"")}function distance(a,b){const r=6371,p=Math.PI/180,dlat=(b.lat-a.lat)*p,dlng=(b.lng-a.lng)*p,x=Math.sin(dlat/2)**2+Math.cos(a.lat*p)*Math.cos(b.lat*p)*Math.sin(dlng/2)**2;return 2*r*Math.asin(Math.sqrt(x))}function minutes(v){const m=String(v||"").match(/(\d{1,2}):(\d{2})/);return m?Number(m[1])*60+Number(m[2]):-1}function price(v){const n=parseFloat(String(v||"0").replace(",","."));return Number.isFinite(n)?n:0}function decode(s){return s.replace(/&#38;|&amp;/g,"&").replace(/&#x3D;|&#61;/g,"=").replace(/&quot;|&#34;/g,'"').replace(/&#x27;|&#39;/g,"'")}function json(body,status=200){return new Response(JSON.stringify(body),{status,headers:{"Content-Type":"application/json; charset=utf-8","Cache-Control":"no-store"}})}
async function blablacarLab(request,env){try{const u=new URL(request.url),origin=u.searchParams.get("originName"),destination=u.searchParams.get("destinationName"),date=u.searchParams.get("date");if(!origin||!destination||!/^\d{4}-\d{2}-\d{2}$/.test(date||""))return json({ok:false,error:"Origem, destino e data são obrigatórios"},400);const search=new URL("https://www.blablacar.com.br/search");search.searchParams.set("fn",origin.replace(/,\s*SP$/i," - SP")+", Brasil");search.searchParams.set("tn",destination+", Brasil");search.searchParams.set("db",date);search.searchParams.set("seats","1");search.searchParams.set("search_origin","HOME");search.searchParams.set("p0[ac]","adult");let response;try{response=await fetch(search.toString(),{headers:{"Accept":"text/html,application/xhtml+xml","Accept-Language":"pt-BR,pt;q=0.9","User-Agent":"Mozilla/5.0 (compatible; RuaNossa-Lab/0.5; +https://github.com/luizgsrocha/rua-nossa)"},redirect:"follow",cf:{cacheTtl:0}})}catch(e){return json({ok:false,stage:"fetch",searchUrl:search.toString(),error:String(e&&e.message||e)})}const body=await response.text(),sample=body.slice(0,500),signals={hasNextData:/__NEXT_DATA__/i.test(body),hasTrip:/trip|ride|carona|viagem/i.test(body),hasPrice:/R\$|price|amount/i.test(body),hasBlocked:/captcha|access denied|forbidden|robot|blocked/i.test(body)};return json({ok:response.ok,status:response.status,finalUrl:response.url,searchUrl:search.toString(),contentType:response.headers.get("content-type"),bytes:body.length,signals,sample})}catch(e){return json({ok:false,error:String(e&&e.message||e)},502)}}
async function blablacarTripLab(request){try{const u=new URL(request.url),raw=u.searchParams.get("url");let trip;try{trip=new URL(raw)}catch{return json({ok:false,error:"URL da viagem inválida"},400)}if(!/^https:$/.test(trip.protocol)||!/(^|\.)blablacar\.com\.br$/i.test(trip.hostname)||trip.pathname!=="/trip")return json({ok:false,error:"Use uma URL individual https://www.blablacar.com.br/trip?... "},400);const tripId=trip.searchParams.get("id");let response;try{response=await fetch(trip.toString(),{headers:{"Accept":"text/html,application/xhtml+xml","Accept-Language":"pt-BR,pt;q=0.9","User-Agent":"Mozilla/5.0 (compatible; RuaNossa-Lab/0.5.1; +https://github.com/luizgsrocha/rua-nossa)"},redirect:"follow",cf:{cacheTtl:0}})}catch(e){return json({ok:false,stage:"fetch",tripUrl:trip.toString(),tripId,error:String(e&&e.message||e)})}const body=await response.text(),lower=body.toLowerCase(),signals={hasTripId:!!tripId&&body.includes(tripId),hasTaubate:/taubat[eé]/i.test(body),hasPirassununga:/pirassununga/i.test(body),hasPrice:/R\$|price|amount/i.test(body),hasTime:/\b\d{1,2}:\d{2}\b/.test(body),hasNextData:/__NEXT_DATA__/i.test(body),hasJsonLd:/application\/ld\+json/i.test(body),hasBlocked:/captcha|access denied|forbidden|robot|blocked|cloudflare/i.test(lower)};const title=(body.match(/<title[^>]*>([\s\S]*?)<\/title>/i)||[])[1]||null;return json({ok:response.ok,status:response.status,finalUrl:response.url,tripUrl:trip.toString(),tripId,contentType:response.headers.get("content-type"),bytes:body.length,title:title&&title.replace(/\s+/g," ").trim(),signals,sample:body.slice(0,700)})}catch(e){return json({ok:false,error:String(e&&e.message||e)},502)}}
