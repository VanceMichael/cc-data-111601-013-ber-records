import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { inspect, definiteTlv } from '../src/reader.mjs';
const primary=await readFile(new URL('../fixtures/primary.bin',import.meta.url));
const manifest=JSON.parse(await readFile(new URL('../fixtures/upstream.json',import.meta.url),'utf8'));
async function resource(path) {
  const item=manifest.resources[path];
  return item.file ? readFile(new URL(`../fixtures/${item.file}`,import.meta.url)) : Buffer.from(item.body);
}

test('定长原件具有层级与字节范围',()=>{
  const result=inspect(primary);assert.equal(result.root.children.length,2);
  assert.equal(result.root.children[1].raw,'41424344');assert.equal(result.root.end,primary.length);
});
test('未知 tag class 不会被数字同号覆盖',()=>{
  const result=inspect(Buffer.from([0x30,6,0x02,1,1,0x82,1,2]));
  assert.equal(result.root.children[0].tag,result.root.children[1].tag);
  assert.notEqual(result.root.children[0].class,result.root.children[1].class);
});
test('当前能力对不定长明确拒绝，错误长度不静默恢复',async()=>{
  const stream=await resource('/stream');assert.equal(stream[1],0x80);
  assert.throws(()=>inspect(stream));assert.throws(()=>definiteTlv(Buffer.from([4,9,1])));
});
