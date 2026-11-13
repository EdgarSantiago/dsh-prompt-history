import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, existsSync } from 'node:fs'

const read = name => readFileSync(new URL(name, import.meta.url), 'utf8')
const manifest = JSON.parse(read('package.json'))

test('public repository metadata preserves the installed identity and npm publication guard',()=>{
  assert.equal(manifest.name,'@local/dsh-prompt-history')
  assert.equal(manifest.private,true)
  assert.equal(manifest.license,'MIT')
  assert.equal(manifest.engines.dsh,'>=0.2.2-rc.1 <0.2.3-0')
  assert.equal(manifest.repository.url,'https://github.com/EdgarSantiago/dsh-prompt-history.git')
  assert.ok(manifest.keywords.includes('dsh-plugin'))
  assert.ok(read('client.js').includes("id:'"+manifest.name+"'"))
  assert.ok(read('cordis.patch.yml').includes(manifest.name))
  assert.equal(manifest.exports['./client'],'./lib/client.js')
  assert.equal(manifest.dependencies.zod,'4.4.3')
  assert.ok(!manifest.scripts.prepare && !manifest.scripts.prepack && !manifest.scripts.install)
})
test('public README uses real GitHub install commands and retains catalog disclosures',()=>{
  const text=read('README.md')
  assert.ok(text.includes(manifest.engines.dsh),'README declares the same controlled compatibility range')
  for(const profile of ['web','desktop'])assert.ok(text.includes('dsh plugin --profile '+profile+' add github:EdgarSantiago/dsh-prompt-history'))
  for(const value of ['Sessions & Messages','0.2.2-rc.1','Permissions and privacy','not an npm release','https://dsh-plugin.org/submit'])assert.ok(text.includes(value),value)
  assert.ok(!text.includes('Publication pending'))
  assert.ok(!text.includes('/Users/'))
  for(const file of ['index.js','projection.js','lib/client.js','cordis.patch.yml','icon.svg','README.md','LICENSE']){
    assert.ok(manifest.files.includes(file),file)
    assert.ok(existsSync(new URL(file,import.meta.url)),file)
  }
  assert.ok(manifest.files.includes('docs/images/*.png'))
})
test('published screenshot is the reviewed metadata-free PNG, not a raw source capture',()=>{
  const bytes=readFileSync(new URL('docs/images/prompt-history-overview.png',import.meta.url))
  assert.deepEqual([...bytes.subarray(0,8)],[137,80,78,71,13,10,26,10])
  assert.equal(bytes.readUInt32BE(16),1800)
  assert.equal(bytes.readUInt32BE(20),692)
  let offset=8
  while(offset<bytes.length){
    const length=bytes.readUInt32BE(offset),type=bytes.toString('ascii',offset+4,offset+8)
    assert.ok(['IHDR','IDAT','IEND'].includes(type),type)
    offset+=length+12
  }
  assert.equal(offset,bytes.length)
})
