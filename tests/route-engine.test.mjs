import test from 'node:test';
import assert from 'node:assert/strict';
import {buildRoutes} from '../route-engine.js';

const trip=(from,to,departure,arrival)=>({
  from,to,departure:`2026-10-14T${departure}:00Z`,arrival:`2026-10-14T${arrival}:00Z`,price:10
});
const rides=[
  trip('A','D','06:00','07:00'),
  trip('A','B','06:00','07:00'),
  trip('B','D','07:30','08:30'),
  trip('B','C','07:30','08:00'),
  trip('C','D','08:30','09:30')
];

for(const [maxConnections,expected] of [[0,[0]],[1,[0,1]],[2,[0,1,2]]]){
  test(`route engine respects ${maxConnections} transfer(s)`,()=>{
    const routes=buildRoutes(rides,{origin:'A',destination:'D',hubs:['B','C'],minConnection:20,maxConnections});
    assert.deepEqual(routes.map(route=>route.connections).sort((a,b)=>a-b),expected);
    assert.ok(routes.every(route=>route.connections<=maxConnections));
  });
}
