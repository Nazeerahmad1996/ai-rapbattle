import {launchStudioBrowser,renderAspectVideo} from '../server/video-renderer.js';
import {loadManifest} from '../server/automation.js';
const manifest=loadManifest(process.argv[2]||'bad08f04');
const browser=await launchStudioBrowser();
try {
 for(const aspect of ['16:9','9:16']) {
  let last=-1;
  const result=await renderAspectVideo({manifest,aspect,browser,onProgress:({pct})=>{const step=Math.floor(pct/10);if(step!==last){console.log(aspect,pct+'%');last=step;}}});
  console.log('Finished',result.videoPath,result.telemetrySamples.length+' layout samples');
 }
}finally{await browser.close()}
