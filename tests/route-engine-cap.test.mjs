import test from 'node:test';
import assert from 'node:assert/strict';
import { buildRoutes } from '../route-engine.js';

const ride=(from,to,departure,arrival)=>({
  from,to,
  departure:'2026-10-14T'+departure+':00',
  arrival:'2026-10-14T'+arrival+':00',
  price:10
});
const rides=[
  ride('Origem','Destino','08:00','09:00'),
  ride('Origem','Hub A','08:00','09:00'),
  ride('Hub A','Destino','09:30','10:30'),
  ride('Hub A','Hub B','09:30','10:30'),
  ride('Hub B','Destino','11:00','12:00')
];
const options={origin:'Origem',destination:'Destino',hubs:['Hub A','Hub B'],minConnection:30};

for(const [maxConnections,expected] of [
  [0,[0]],
  [1,[0,1]],
  [2,[0,1,2]]
]){
  test('motor auxiliar respeita limite de '+maxConnections+' baldeações',()=>{
    const result=buildRoutes(rides,{...options,maxConnections});
    assert.deepEqual(result.map(route=>route.connections).sort((a,b)=>a-b),expected);
    assert.ok(result.every(route=>route.legs.length<=maxConnections+1));
  });
}

test('zero baldeações não transforma viagem com conexão em direta',()=>{
  const withoutDirect=rides.filter(ride=>!(ride.from==='Origem'&&ride.to==='Destino'));
  assert.deepEqual(buildRoutes(withoutDirect,{...options,maxConnections:0}),[]);
});
