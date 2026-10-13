export function buildRoutes(rides,{origin="Pirassununga",destination="Taubaté",hubs=["Campinas","São José dos Campos"],minConnection=30,maxConnections=2}={}){
 const outgoing=new Map(); for(const r of rides){if(!outgoing.has(r.from))outgoing.set(r.from,[]);outgoing.get(r.from).push(r)}
 const routes=[]; const walk=(city,legs,visited)=>{if(legs.length>=maxConnections+1)return;
  for(const ride of outgoing.get(city)||[]){if(visited.has(ride.to))continue;
   if(legs.length){const prev=legs.at(-1),gap=(new Date(ride.departure)-new Date(prev.arrival))/60000;if(gap<minConnection)continue}
   const next=[...legs,ride]; if(ride.to===destination){routes.push(summarize(next));continue}
   if(hubs.includes(ride.to))walk(ride.to,next,new Set([...visited,ride.to]))
  }}; walk(origin,[],new Set([origin])); return routes}
function summarize(legs){const start=new Date(legs[0].departure),end=new Date(legs.at(-1).arrival);return{legs,connections:legs.length-1,price:legs.reduce((s,x)=>s+x.price,0),duration:(end-start)/60000,start,end}}
export function sortRoutes(routes,mode="recommended"){return [...routes].sort((a,b)=>mode==="cheapest"?a.price-b.price:mode==="fastest"?a.duration-b.duration:(a.connections-b.connections)||(a.duration-b.duration)||(a.price-b.price))}