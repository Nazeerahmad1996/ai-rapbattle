import {loadManifest} from '../server/automation.js';
import {launchStudioBrowser} from '../server/video-renderer.js';
import {verifyMixIntelligibility} from '../server/forced-aligner.js';
import {buildReviewScript} from '../server/video-reviewer.js';
import {writeFileSync} from 'node:fs';
const m=loadManifest(process.argv[2]||'bad08f04');
const b=await launchStudioBrowser();
try {
 for(const aspect of ['9:16','16:9']) {
  const t=aspect==='9:16'?m.shortsTimelineV2:m.timelineV2;
  const p=await b.newPage({viewport:aspect==='9:16'?{width:1080,height:1920}:{width:1920,height:1080}});
  await p.goto('http://127.0.0.1:3000/director.html');await p.evaluate(({m,aspect})=>window.__initDirectorStage(m,aspect),{m,aspect});
  await p.evaluate(async()=>{await document.fonts.ready;await Promise.all([...document.images].map(i=>i.decode()));});
  const frames=new Set([0]);for(const e of t.events){for(const dt of [0,200,400,650])if(e.type!=='vs-slam'||dt>0)frames.add(Math.round((e.startMs+dt)*t.fps/1000));}
  for(const page of t.captionPages)frames.add(page.startFrame+1);
  const failures=[];
  for(const frame of [...frames].sort((a,b)=>a-b)){if(frame>=t.totalFrames)continue;await p.evaluate(f=>window.__renderAtFrame(f),frame);const x=await p.evaluate(()=>window.__measureLayoutTelemetry());if(x.safeZoneViolations.length||x.textOverflows.length)failures.push({frame,...x});}
  writeFileSync('qa/production-upgrade/'+aspect.replace(':','x')+'-preflight.json',JSON.stringify(failures,null,2));console.log(aspect,frames.size,'samples',failures.length,'layout failures');
  await p.close();
 }
}finally{await b.close()}
const result=verifyMixIntelligibility({mediaPath:m.audio16x9,scriptText:buildReviewScript(m,'16:9'),language:m.battle.config.language});writeFileSync('qa/production-upgrade/audio-preflight.json',JSON.stringify(result,null,2));console.log('Audio preflight',result.wordMatchPct,result.wordErrors);
