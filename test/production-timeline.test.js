import test from 'node:test';
import assert from 'node:assert/strict';
import {buildMasterTimelineV2, pickHookPunchline} from '../server/timeline-v2.js';
const battle = {config:{mode:'rap'},fighters:[{name:'A'},{name:'B'}],totals:{a:8,b:9},final:{winner:'b'}};
const stem = (id,type,extra={})=>({id,segmentType:type,text:'Complete words here.',durationMs:3100,words:[{text:'Complete',offsetMs:0,durationMs:800},{text:'words',offsetMs:900,durationMs:800},{text:'here.',offsetMs:2100,durationMs:1000}],...extra});
test('cold open preserves every audible word rather than truncating to a duration target',()=>{
 const tl=buildMasterTimelineV2({battle,lineStems:[stem('hook','hook')]});
 const hook=tl.lines[0];
 assert.ok(hook.clipEndMs>=hook.endMs);
 assert.equal(hook.words.length,3);
 assert.ok(tl.events.find(e=>e.type==='vs-slam').startMs>=hook.endMs);
 assert.equal(tl.fps,60);
});
test('multi-sentence judge scores one round once',()=>{
 const tl=buildMasterTimelineV2({battle,lineStems:[stem('a','verse',{side:'a',round:1,roundScores:{a:8,b:9}}),stem('b','verse',{side:'b',round:1}),stem('j1','judge',{round:1,scores:{a:8,b:9}}),stem('j2','judge',{round:1,scores:{a:8,b:9}})]});
 const changes=tl.events.filter(e=>e.type==='score-change'&&e.side==='b');
 assert.equal(changes.length,1);
 assert.equal(changes[0].payload.scoreB,9);
});
test('poetry has no combat impacts or punchline shake events',()=>{
 const tl=buildMasterTimelineV2({battle:{...battle,config:{mode:'poetry'}},lineStems:[stem('a','verse',{side:'a',isPunchline:true,punchTier:'knockout'})]});
 assert.equal(tl.events.filter(e=>e.type==='punchline').length,0);
});
test('hook selection never takes an arbitrary eight-word tail',()=>{
 const text='You rent that car for ninety minutes just to pose beside the borrowed keys.';
 const hook=pickHookPunchline(battle,[{round:1,verses:{b:text},scores:{b:9}}]);
 assert.equal(hook.text,text);
});
test('rap line entries fall on the same beat grid as the backing track',()=>{
 const tl=buildMasterTimelineV2({battle,lineStems:[stem('a','verse',{side:'a'}),stem('b','verse',{side:'b'})]});
 for(const line of tl.lines.filter(l=>l.segmentType==='verse')) {
  const phase=(line.startMs-tl.beatGrid.offsetMs)/tl.beatGrid.beatMs;
  assert.ok(Math.abs(phase-Math.round(phase))<0.002);
 }
});

import {syncVideoChapters,probeMp3DurationMs} from '../server/automation.js';
test('chapter timestamps use the rendered clock and omit invalid short chapter lists',()=>{
 const metadata={description:'About this battle\n\n⏱️ Chapters:\n00:00 old\n00:02 stale\n\n#BotBrawl',chapters:['old']};
 const short=syncVideoChapters(metadata,{totalDurationMs:54000,lines:[{segmentType:'verse',round:1,side:'a',startMs:4000},{segmentType:'verse',round:1,side:'b',startMs:25000}]});
 assert.deepEqual(short.chapters,[]);
 assert.ok(!short.description.includes('stale'));
 const long=syncVideoChapters(metadata,{totalDurationMs:90000,lines:[{segmentType:'verse',round:1,side:'a',startMs:4000},{segmentType:'verse',round:1,side:'b',startMs:25000},{segmentType:'verse',round:2,side:'a',startMs:55000}]});
 assert.equal(long.chapters[1],'00:25 Round 1 — Corner B');
 assert.equal(long.chapters[2],'00:55 Round 2 — Corner A');
});
test('production timing refuses unknown speech duration',()=>{
 assert.throws(()=>probeMp3DurationMs('/nonexistent/botbrawl.wav'),/Cannot measure/);
});

import {spokenJudgeReason} from '../server/automation.js';
test('spoken judging disambiguates contestant letters without corrupting articles or existing labels',()=>{
 assert.equal(spokenJudgeReason('A vivid image earns B the win. A lands the rhyme; Corner A fights back.'),'A vivid image earns the lime corner the win. the violet corner lands the rhyme; Corner A fights back.');
 assert.equal(spokenJudgeReason("B clinches it by clowning A coasting, punishing A for an opening."),'the lime corner clinches it by clowning the violet corner coasting, punishing the violet corner for an opening.');
});
