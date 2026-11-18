import test from 'node:test';
import assert from 'node:assert/strict';
import {build} from 'esbuild';
import {fileURLToPath} from 'node:url';
const result=await build({entryPoints:[fileURLToPath(new URL('../src/components/exam/progressiveSpeech.ts',import.meta.url))],bundle:true,write:false,format:'esm',platform:'node'});
const {progressiveSpeech}=await import('data:text/javascript;base64,'+Buffer.from(result.outputFiles[0].text).toString('base64'));
test('first clip starts before the delayed second clip finishes generation; ordered queue drains',async()=>{
 const controller=new AbortController();let release;const started=new Promise(resolve=>release=resolve);
 let secondReady=false;const played=[];
 await progressiveSpeech(async push=>{await push({url:'one'});await started;secondReady=true;await push({url:'two'});},async clip=>{
  if(clip.url==='one'){assert.equal(secondReady,false);release();}
  played.push(clip.url);await new Promise(resolve=>setTimeout(resolve,5));
 },controller.signal);
 assert.deepEqual(played,['one','two']);assert.equal(secondReady,true);
});
test('playback failure cancels a producer blocked by the bounded queue',async()=>{
 const controller=new AbortController();let producerStopped=false;
 await assert.rejects(progressiveSpeech(async(push,signal)=>{
  try{for(let index=0;index<20;index++)await push({url:String(index)});}finally{producerStopped=signal.aborted;}
 },async()=>{throw new Error('synthetic playback failure');},controller.signal),/playback failure/);
 await new Promise(resolve=>setTimeout(resolve,0));assert.equal(producerStopped,true);
});
