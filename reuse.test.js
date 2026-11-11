import test from 'node:test'
import assert from 'node:assert/strict'
import { prepareReuse, reusePrompt } from './reuse.js'
const state=()=>({phase:'plain',draft:'',draftRev:1,attachmentIds:[],occurrences:[]})
const prompt={text:'Revisar código\nsem enviar automaticamente',truncated:false,hasAttachments:true}
function fixture(snapshot=state(),accept=true){const calls=[];return{calls,input:{state:{getSnapshot:()=>snapshot},focus:()=>calls.push('focus')},actions:{insertText:(text,span)=>{calls.push({text,span});return accept},persistDraft:()=>calls.push('persist'),submit:()=>assert.fail('never submit'),addAttachments:()=>assert.fail('never attach files')}}}

test('reuse inserts exact text with a native revision guard, persists and focuses without sending',()=>{
 const f=fixture();assert.equal(reusePrompt(f.input,f.actions,prompt).kind,'applied')
 assert.deepEqual(f.calls,[{text:prompt.text,span:{start:0,end:0,draftRev:1}},'persist','focus'])
})
test('existing draft requires confirmation; later edits invalidate that confirmation',()=>{
 const original={...state(),draft:'unsent draft'};const f=fixture(original)
 assert.deepEqual(reusePrompt(f.input,f.actions,prompt),{kind:'confirm',revision:1});assert.equal(f.calls.length,0)
 original.draftRev=2;assert.deepEqual(reusePrompt(f.input,f.actions,prompt,1),{kind:'blocked',reason:'changed'});assert.equal(f.calls.length,0)
 assert.equal(reusePrompt(f.input,f.actions,prompt,2).kind,'applied');assert.deepEqual(f.calls[0].span,{start:0,end:12,draftRev:2})
})
test('native CAS refusal never persists, focuses or submits',()=>{
 const f=fixture(state(),false);assert.equal(reusePrompt(f.input,f.actions,prompt).reason,'changed');assert.equal(f.calls.length,1)
})
test('busy phases, claims, draft attachments and references remain untouched',()=>{
 for(const extra of [{phase:'sending'},{phase:'submitting'},{phase:'adjudicating'},{phase:'claimed'},{claim:{name:'command'}},{attachmentIds:['file']},{occurrences:[{start:0,end:1}]}]){
  const f=fixture({...state(),...extra});assert.equal(reusePrompt(f.input,f.actions,prompt).kind,'blocked');assert.equal(f.calls.length,0)
 }
})
test('truncated or empty prompts are never silently copied into the editor',()=>{
 for(const p of [{...prompt,truncated:true},{text:''},{text:'   '}])assert.equal(prepareReuse(state(),p).kind,'blocked')
})
test('native reference marker sanitization cannot turn recalled text into a terminal entry',()=>{
 const f=fixture();assert.equal(reusePrompt(f.input,f.actions,{text:'\uFFFC!echo danger'}).reason,'referenceText');assert.equal(f.calls.length,0)
})
test('bang-prefixed history cannot accidentally activate the interactive terminal',()=>{
 const f=fixture();assert.deepEqual(reusePrompt(f.input,f.actions,{text:'!rm -rf project'}),{kind:'blocked',reason:'bang'});assert.equal(f.calls.length,0)
})
