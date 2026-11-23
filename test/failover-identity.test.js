import test from 'node:test';
import assert from 'node:assert/strict';
import {withFailover, resolvedFighter, extractRoundsFromBattle} from '../server/automation.js';
import {runBattle} from '../server/engine.js';
const fighter = (name, generate) => ({id:name,model:name+'-model',name,stageName:name,color:'#123456',generate});
const collect = async f => {let text='';for await(const chunk of f.generate({prompt:'test'})) text+=chunk;return text;};
test('fallback commits the actual identity, discards failed partial text, and remains active',async()=>{
 let calls=0;
 const primary=fighter('Original',async function*(){calls++;yield 'incomplete';throw Error('quota');});
 const backup=fighter('Backup',async function*(){yield 'complete verse';});
 const wrapped=withFailover(primary,[primary,backup]);
 assert.equal(await collect(wrapped),'complete verse');
 assert.equal(wrapped.name,'Backup');assert.equal(wrapped.model,'Backup-model');
 assert.equal(resolvedFighter(wrapped).stageName,'Backup');
 assert.equal(await collect(wrapped),'complete verse');assert.equal(calls,1);
});
test('mid-battle fallback preserves per-turn attribution and credits only successful contributors',async()=>{
 let calls=0;
 const primary=fighter('Original',async function*(){if(calls++)throw Error('quota');yield 'first verse';});
 const backup=fighter('Backup',async function*(){yield 'second verse';});
 const wrapped=withFailover(primary,[primary,backup]);
 const events=[];
 const result=await runBattle({config:{mode:'rap',topic:'Tea vs Coffee',rounds:2,lines:2},fighters:[wrapped,backup],judge:null,emit:e=>events.push(e)});
 assert.equal(result.rounds[0].performers.a.name,'Original');
 assert.equal(result.rounds[1].performers.a.name,'Backup');
 assert.equal(resolvedFighter(wrapped).stageName,'Original / Backup');
 assert.equal(extractRoundsFromBattle({events})[1].performers.a.model,'Backup-model');
});
test('aborting a generation never invokes a fallback or changes attribution',async()=>{
 const controller=new AbortController();let calls=0;
 const primary=fighter('Original',async function*(){controller.abort();throw Error('aborted');});
 const backup=fighter('Backup',async function*(){calls++;yield 'wrong';});
 const wrapped=withFailover(primary,[backup]);
 await assert.rejects(async()=>{for await(const chunk of wrapped.generate({signal:controller.signal})){} });
 assert.equal(calls,0);assert.equal(wrapped.name,'Original');assert.equal(wrapped.contributors.length,0);
});
