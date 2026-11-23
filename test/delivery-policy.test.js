import test from 'node:test';
import assert from 'node:assert/strict';
import {requestedDeliveryFiles,mayUploadAspect} from '../server/delivery-policy.js';
test('a Shorts-only request never returns unrelated cached widescreen or diagnostic objects',()=>{
 assert.deepEqual(requestedDeliveryFiles({video16x9:'/wide.mp4',video9x16Shorts:'/short.mp4',thumbnail16x9:'/wide.png',thumbnail9x16:'/short.png',telemetry:{},manifestJson:'/manifest.json'},['9:16']),{video9x16Shorts:'/short.mp4',thumbnail9x16:'/short.png',manifestJson:'/manifest.json'});
});
test('upload permission belongs to the independently reviewed requested aspect',()=>{
 const review={approvedForUpload:true,requestedAspects:['9:16'],bestCandidate:{aspects:{'9:16':{ok:true}}}};
 assert.equal(mayUploadAspect(review,'9:16'),true);
 assert.ok(!mayUploadAspect(review,'16:9'));
 assert.ok(!mayUploadAspect({...review,approvedForUpload:false},'9:16'));
 assert.ok(!mayUploadAspect({approvedForUpload:true},'9:16'));
});
