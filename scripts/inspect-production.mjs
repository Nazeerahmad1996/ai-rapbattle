import {launchStudioBrowser} from '../server/video-renderer.js';
import {loadManifest} from '../server/automation.js';
import {writeFileSync} from 'node:fs';
const b=await launchStudioBrowser();
try {
 const m=loadManifest('bad08f04');
 for(const aspect of ['9:16','16:9']) {
  const p=await b.newPage({viewport:aspect==='9:16'?{width:1080,height:1920}:{width:1920,height:1080}});
  await p.goto('http://127.0.0.1:3000/director.html');
  await p.evaluate(({m,aspect})=>window.__initDirectorStage(m,aspect),{m,aspect});
  await p.evaluate(async()=>{await document.fonts.ready;await Promise.all([...document.images].map(i=>i.decode()));});
  const samples=[];
  for(const t of [1,8,28,51]) {
   await p.evaluate(t=>window.__renderAtFrame(t*60),t);
   await p.screenshot({path:'qa/production-upgrade/'+aspect.replace(':','x')+'-'+t+'s.png'});
   const telemetry=await p.evaluate(()=>window.__measureLayoutTelemetry());samples.push({t,...telemetry});
   console.log(aspect,t,JSON.stringify({violations:telemetry.safeZoneViolations,overflows:telemetry.textOverflows}));
  }
  writeFileSync('qa/production-upgrade/'+aspect.replace(':','x')+'-sample-layout.json',JSON.stringify(samples,null,2));
  await p.close();
 }
} finally {await b.close()}
