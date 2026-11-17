import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { inspect, parseStream, BerStreamParser } from '../src/reader.mjs';
import { normalizeSchema, interpretRecord, summarizeStream } from '../src/schema.mjs';

const primary = await readFile(new URL('../fixtures/primary.bin', import.meta.url));
const manifest = JSON.parse(await readFile(new URL('../fixtures/upstream.json', import.meta.url), 'utf8'));
async function resource(path) {
  const item = manifest.resources[path];
  return item.file ? readFile(new URL(`../fixtures/${item.file}`, import.meta.url)) : Buffer.from(item.body);
}
const streamBytes = await resource('/stream');
const damagedBytes = await resource('/damaged');
const schema = normalizeSchema(JSON.parse((await resource('/schema')).toString('utf8')));
const bytesOf = (...hex) => Buffer.from(hex.join('').replaceAll(' ', ''), 'hex');

test('定长原件具有层级与字节范围', () => {
  const result = inspect(primary);
  assert.equal(result.root.children.length, 2);
  assert.equal(result.root.children[1].raw, '41424344');
  assert.equal(result.root.end, primary.length);
});

test('未知 tag class 不会被数字同号覆盖', () => {
  const result = inspect(Buffer.from([0x30, 6, 0x02, 1, 1, 0x82, 1, 2]));
  assert.equal(result.root.children[0].tag, result.root.children[1].tag);
  assert.notEqual(result.root.children[0].class, result.root.children[1].class);
});

test('不定长构造容器与多条顶层记录可按结构拆分', () => {
  const result = parseStream([streamBytes]);
  assert.equal(result.outcome, 'complete');
  assert.equal(result.records.length, 2);
  const [first, second] = result.records;
  assert.deepEqual([first.start, first.end], [0, 23]);
  assert.deepEqual([second.start, second.end], [23, 31]);
  const [id, set, vendor] = first.node.children;
  assert.deepEqual([id.class, id.tag, id.start, id.end], [0, 2, 2, 5]);
  assert.equal(set.tag, 17);
  assert.equal(set.children[0].tag, 12);
  assert.deepEqual([set.start, set.end], [5, 14]);
  assert.deepEqual([vendor.class, vendor.tag, vendor.start, vendor.end], [2, 5, 14, 21]);
  assert.equal(vendor.children[0].tag, 4);
});

test('任意网络块切分不改变解析结果', () => {
  const whole = parseStream([streamBytes]);
  const drip = new BerStreamParser();
  for (let index = 0; index < streamBytes.length; index += 1) {
    drip.push(streamBytes.subarray(index, index + 1));
  }
  assert.deepEqual(drip.finish(), whole);
  const odd = parseStream([streamBytes.subarray(0, 7), streamBytes.subarray(7, 13), streamBytes.subarray(13)]);
  assert.deepEqual(odd, whole);
});

test('high-tag-number 与长式长度可解析', () => {
  const result = inspect(bytesOf('30 05 9f 85 00 01 41'));
  const child = result.root.children[0];
  assert.deepEqual([child.class, child.tag, child.constructed], [2, 640, false]);
  assert.equal(child.raw, '41');
  const long = inspect(Buffer.concat([bytesOf('30 81 85 04 81 82'), Buffer.alloc(130, 0x61)]));
  assert.equal(long.root.children[0].end, long.root.end);
});

test('EOC 只闭合不定长容器，primitive 内容里的 0000 是数据', () => {
  const result = inspect(bytesOf('30 05 04 03 00 00 41'));
  assert.equal(result.root.children[0].raw, '000041');
  assert.throws(() => inspect(bytesOf('30 04 02 01 01 00 00')), /ber_unexpected_eoc/);
  const stray = parseStream([bytesOf('30 00 00 00')]);
  assert.equal(stray.outcome, 'corrupt');
  assert.equal(stray.failure.reason, 'ber_unexpected_eoc');
  assert.equal(stray.failure.offset, 2);
  assert.equal(stray.records.length, 1);
});

test('长度损坏给出可证明的字节偏移，不继续猜下一条', () => {
  const overrun = parseStream([bytesOf('30 04 02 01 01 04 09 41')]);
  assert.equal(overrun.outcome, 'corrupt');
  assert.equal(overrun.failure.reason, 'ber_length_overrun');
  assert.equal(overrun.failure.offset, 5);
  assert.deepEqual(overrun.failure.container, { class: 0, constructed: true, tag: 16, start: 0, end: 6 });
  assert.deepEqual(overrun.failure.span, { start: 0, end: 8 });
  assert.equal(overrun.records.length, 0);
  const primitive = parseStream([bytesOf('04 80 00 00')]);
  assert.equal(primitive.failure?.reason, 'ber_indefinite_primitive');
  const reserved = parseStream([bytesOf('04 ff 01 02')]);
  assert.equal(reserved.failure?.reason, 'ber_length_reserved');
  const huge = parseStream([Buffer.concat([bytesOf('30 82 01 00'), Buffer.alloc(256)])], { maxRecordBytes: 100 });
  assert.equal(huge.failure?.reason, 'ber_record_too_large');
});

test('容器尚未闭合与长度损坏是不同结论', () => {
  const result = parseStream([damagedBytes]);
  assert.equal(result.outcome, 'incomplete');
  assert.equal(result.records.length, 0);
  const { failure } = result;
  assert.equal(failure.reason, 'ber_unclosed');
  assert.equal(failure.recordStart, 0);
  assert.equal(failure.offset, damagedBytes.length);
  assert.equal(failure.needed, 254);
  assert.deepEqual(failure.openContainers, [
    { class: 0, constructed: true, tag: 16, start: 0, valueStart: 2, remaining: null }]);
  assert.deepEqual(failure.pendingValue, { class: 0, constructed: false, tag: 4,
    start: 5, valueStart: 9, length: 256, received: 2 });
  assert.deepEqual(failure.span, { start: 0, end: damagedBytes.length });
  const header = parseStream([bytesOf('30 82 01')]);
  assert.equal(header.outcome, 'incomplete');
  assert.equal(header.failure.needed, null);
  assert.deepEqual(header.failure.openContainers, []);
});

test('按声明记录类型领取字段，扩展原样保留层级与字节位置', () => {
  const parsed = parseStream([streamBytes]);
  const summary = summarizeStream(parsed, schema, streamBytes);
  assert.equal(summary.outcome, 'complete');
  const [first, second] = summary.records;
  assert.equal(first.matched, true);
  assert.deepEqual(first.fields.recordId, { type: 'INTEGER', value: 1 });
  assert.equal(first.fields.payload, undefined);
  assert.equal(first.extensions.length, 2);
  const [set, vendor] = first.extensions;
  assert.deepEqual(set.path, [{ class: 0, tag: 16 }, { class: 0, tag: 17 }]);
  assert.equal(set.raw, '31800c036162630000');
  assert.deepEqual([set.start, set.end], [5, 14]);
  assert.deepEqual(vendor.path, [{ class: 0, tag: 16 }, { class: 2, tag: 5 }]);
  assert.equal(vendor.raw, 'a505040378797a');
  assert.deepEqual([vendor.start, vendor.end], [14, 21]);
  assert.deepEqual(second.fields.recordId, { type: 'INTEGER', value: 2 });
  assert.deepEqual(second.fields.payload, { type: 'OCTET STRING', hex: '51', utf8: 'Q' });
  assert.equal(second.extensions.length, 0);
});

test('同号 tag 不跨 class 套解释', () => {
  const data = bytesOf('30 06 82 01 07 04 01 51');
  const parsed = parseStream([data]);
  const summary = summarizeStream(parsed, schema, data);
  const [record] = summary.records;
  assert.equal(record.fields.recordId, undefined);
  assert.deepEqual(record.fields.payload, { type: 'OCTET STRING', hex: '51', utf8: 'Q' });
  assert.equal(record.extensions.length, 1);
  assert.deepEqual([record.extensions[0].class, record.extensions[0].tag], [2, 2]);
  assert.equal(record.extensions[0].raw, '820107');
});

test('schema 路径可显式声明 class，厂商私有字段按声明领取', () => {
  const local = normalizeSchema({ record: { class: 0, tag: 16, constructed: true },
    known: [{ path: [16, { class: 2, tag: 5 }], name: 'vendor', type: 'OCTET STRING' }] });
  const data = bytesOf('30 05 85 03 01 02 03');
  const summary = summarizeStream(parseStream([data]), local, data);
  assert.deepEqual(summary.records[0].fields.vendor, { type: 'OCTET STRING', hex: '010203', utf8: '\u0001\u0002\u0003' });
});

test('单条语义失败可隔离，不影响同批其他记录', () => {
  const data = Buffer.concat([bytesOf('30 05 02 00 04 01 51'), bytesOf('30 06 02 01 02 04 01 51')]);
  const summary = summarizeStream(parseStream([data]), schema, data);
  assert.equal(summary.outcome, 'complete');
  assert.equal(summary.records.length, 2);
  const [bad, good] = summary.records;
  assert.equal(bad.problems.length, 1);
  assert.equal(bad.problems[0].reason, 'field_bad_integer');
  assert.equal(bad.problems[0].name, 'recordId');
  assert.equal(bad.problems[0].offset, 2);
  assert.deepEqual(bad.fields.payload, { type: 'OCTET STRING', hex: '51', utf8: 'Q' });
  assert.deepEqual(good.fields.recordId, { type: 'INTEGER', value: 2 });
});

test('大整数按精度安全表示，顶层类型不匹配整条按未知保存', () => {
  const big = bytesOf('30 0e 02 09 01 00 00 00 00 00 00 00 00 04 01 51');
  const summary = summarizeStream(parseStream([big]), schema, big);
  assert.equal(summary.records[0].fields.recordId.value, '18446744073709551616');
  const other = bytesOf('31 03 02 01 01');
  const unmatched = summarizeStream(parseStream([other]), schema, other);
  assert.equal(unmatched.records[0].matched, false);
  assert.equal(unmatched.records[0].raw, '3103020101');
});

test('无 schema 时仍按结构拆分记录但不解释', () => {
  const summary = summarizeStream(parseStream([streamBytes]), null, streamBytes);
  assert.equal(summary.records.length, 2);
  assert.equal(summary.records[0].matched, null);
  assert.equal(summary.records[0].fields, undefined);
});

test('schema 校验拒绝无法忠实执行的声明', () => {
  assert.throws(() => normalizeSchema({ record: { class: 0, tag: 16 },
    known: [{ path: [16, 2], name: 'x', type: 'BOOLEAN' }] }), /schema_unsupported_type/);
  assert.throws(() => normalizeSchema({ record: { class: 0, tag: 16 },
    known: [{ path: [17, 2], name: 'x', type: 'INTEGER' }] }), /schema_bad_path/);
  assert.throws(() => normalizeSchema({ record: { class: 0, tag: 16 }, extensions: 'drop' }),
    /schema_unsupported_extensions/);
  assert.throws(() => normalizeSchema({ record: { class: 0, tag: 16 }, known: [
    { path: [16, 2], name: 'a', type: 'INTEGER' }, { path: [16, 4], name: 'a', type: 'INTEGER' }] }),
    /schema_duplicate_field/);
  assert.throws(() => normalizeSchema({ record: { class: 9, tag: 16 } }), /schema_invalid/);
});

test('单件契约：空输入、多条记录、损坏输入均明确拒绝', () => {
  assert.ok(inspect(primary));
  assert.throws(() => inspect(Buffer.alloc(0)));
  assert.throws(() => inspect(streamBytes), /simple_ber_trailing/);
  assert.throws(() => inspect(damagedBytes), /ber_unclosed/);
  const indefinite = inspect(bytesOf('30 80 02 01 01 00 00'));
  assert.equal(indefinite.root.children[0].tag, 2);
});
