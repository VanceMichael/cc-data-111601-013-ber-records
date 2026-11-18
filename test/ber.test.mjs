import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { BerReceiver } from '../src/ber.mjs';
import { interpretRecord } from '../src/interpret.mjs';

const stream = await readFile(new URL('../fixtures/resource-01.bin', import.meta.url));
const damaged = await readFile(new URL('../fixtures/resource-02.bin', import.meta.url));
const schema = JSON.parse(await readFile(new URL('../fixtures/resource-03.bin', import.meta.url)));

function receive(bytes, width = bytes.length || 1) {
  const receiver = new BerReceiver();
  for (let offset = 0; offset < bytes.length; offset += width) {
    receiver.feed(bytes.subarray(offset, offset + width));
  }
  return receiver.finish();
}

test('流式解析不定长与构造型记录，网络块切分不影响结构', () => {
  const whole = receive(stream);
  assert.equal(whole.status, 'ok');
  assert.equal(whole.failure, null);
  assert.equal(whole.records.length, 2);
  assert.deepEqual([whole.records[0].start, whole.records[0].end], [0, 23]);
  assert.deepEqual([whole.records[1].start, whole.records[1].end], [23, 31]);
  const [first] = whole.records;
  assert.deepEqual([first.class, first.constructed, first.tag], [0, true, 16]);
  assert.equal(first.children.length, 3);
  assert.deepEqual([first.children[0].start, first.children[0].end], [2, 5]);
  assert.deepEqual([first.children[1].class, first.children[1].tag, first.children[1].indefinite],
    [0, 17, true]);
  assert.deepEqual([first.children[1].start, first.children[1].end], [5, 14]);
  assert.deepEqual([first.children[2].class, first.children[2].tag], [2, 5]);
  assert.deepEqual([first.children[2].children[0].start, first.children[2].children[0].end], [16, 21]);
  for (const width of [1, 2, 3, 5, 7, 11, stream.length]) {
    const chunked = receive(stream, width);
    assert.equal(chunked.status, 'ok');
    assert.deepEqual(chunked.records, whole.records);
  }
});

test('长度损坏有字节依据：声明长度超出流末端', () => {
  const outcome = receive(damaged);
  assert.equal(outcome.status, 'length');
  assert.equal(outcome.records.length, 0);
  const failure = outcome.failure;
  assert.equal(failure.kind, 'length');
  assert.equal(failure.error, 'ber_value_short');
  assert.equal(failure.offset, 5);
  assert.equal(failure.declaredLength, 256);
  assert.equal(failure.valueStart, 9);
  assert.equal(failure.declaredEnd, 265);
  assert.equal(failure.streamEnd, 11);
  assert.deepEqual([failure.start, failure.end], [0, 11]);
  assert.deepEqual(failure.open.map(entry => [entry.tag, entry.indefinite]), [[16, true]]);
});

test('容器尚未闭合与头部截断区别于长度损坏', () => {
  const unclosed = receive(Buffer.from([0x30, 0x80, 0x02, 0x01, 0x01]));
  assert.equal(unclosed.status, 'unclosed');
  assert.equal(unclosed.failure.error, 'ber_container_unclosed');
  assert.deepEqual([unclosed.failure.start, unclosed.failure.end], [0, 5]);
  assert.deepEqual(unclosed.failure.open.map(entry => entry.start), [0]);
  const truncated = receive(Buffer.from([0x30]));
  assert.equal(truncated.status, 'unclosed');
  assert.equal(truncated.failure.error, 'ber_header_short');
  assert.deepEqual([truncated.failure.start, truncated.failure.end], [0, 1]);
  const lengthCut = receive(Buffer.from([0x04, 0x82, 0x01]));
  assert.equal(lengthCut.status, 'unclosed');
  assert.equal(lengthCut.failure.error, 'ber_header_short');
});

test('EOC 只闭合当前不定长容器，不作扫描标记；primitive 内 0000 是内容', () => {
  const stray = receive(Buffer.from([0x00, 0x00]));
  assert.equal(stray.status, 'corrupt');
  assert.equal(stray.failure.error, 'ber_eoc_unexpected');
  assert.equal(stray.failure.offset, 0);
  const insideDefinite = receive(Buffer.from([0x30, 0x02, 0x00, 0x00]));
  assert.equal(insideDefinite.status, 'corrupt');
  assert.equal(insideDefinite.failure.error, 'ber_eoc_unexpected');
  assert.equal(insideDefinite.failure.offset, 2);
  const content = receive(Buffer.from([0x30, 0x04, 0x04, 0x02, 0x00, 0x00]));
  assert.equal(content.status, 'ok');
  const record = interpretRecord(content.records[0], schema, (start, end) =>
    Buffer.from([0x30, 0x04, 0x04, 0x02, 0x00, 0x00]).subarray(start, end));
  assert.equal(record.fields.payload.value, '0000');
});

test('不定长不允许出现在 primitive，子级声明超出父级边界即损坏', () => {
  const primitive = receive(Buffer.from([0x04, 0x80, 0x00, 0x00]));
  assert.equal(primitive.status, 'corrupt');
  assert.equal(primitive.failure.error, 'ber_indefinite_primitive');
  const overrun = receive(Buffer.from([0x30, 0x04, 0x04, 0x08, 0x61, 0x62]));
  assert.equal(overrun.status, 'length');
  assert.equal(overrun.failure.error, 'ber_length_overrun');
  assert.equal(overrun.failure.offset, 2);
  assert.equal(overrun.failure.declaredEnd, 12);
  assert.equal(overrun.failure.containerEnd, 6);
  assert.deepEqual([overrun.failure.start, overrun.failure.end], [0, 6]);
});

test('高号 tag 与长型长度保持完整身份，保留字长度被拒绝', () => {
  const highTag = receive(Buffer.from([0x5f, 0x2a, 0x01, 0x41]));
  assert.equal(highTag.status, 'ok');
  assert.deepEqual([highTag.records[0].class, highTag.records[0].constructed, highTag.records[0].tag],
    [1, false, 42]);
  const longLength = receive(Buffer.concat([Buffer.from([0x04, 0x82, 0x01, 0x00]), Buffer.alloc(256, 0x41)]));
  assert.equal(longLength.status, 'ok');
  assert.equal(longLength.records[0].end, 260);
  assert.equal(receive(Buffer.from([0x04, 0xff])).status, 'corrupt');
  assert.equal(receive(Buffer.from([0x04, 0xff])).failure.error, 'ber_length_reserved');
  const tooLong = receive(Buffer.from([0x04, 0x87, 1, 2, 3, 4, 5, 6, 7]));
  assert.equal(tooLong.failure.error, 'ber_length_long');
  const padding = receive(Buffer.from([0x1f, 0x80, 0x01, 0x00]));
  assert.equal(padding.failure.error, 'ber_tag_padding');
});

test('损坏前的完整记录保留，损坏后不扫描结束标记继续猜', () => {
  const bytes = Buffer.concat([Buffer.from([0x30, 0x03, 0x02, 0x01, 0x01]),
    Buffer.from([0x04, 0x05, 0x01])]);
  const outcome = receive(bytes);
  assert.equal(outcome.records.length, 1);
  assert.deepEqual([outcome.records[0].start, outcome.records[0].end], [0, 5]);
  assert.equal(outcome.status, 'length');
  assert.equal(outcome.failure.offset, 5);
  assert.deepEqual([outcome.failure.start, outcome.failure.end], [5, 8]);
});

test('按声明类型领取字段，未知扩展原样保留嵌套路径与字节位置', () => {
  const outcome = receive(stream);
  const slice = (start, end) => stream.subarray(start, end);
  const first = interpretRecord(outcome.records[0], schema, slice);
  assert.equal(first.type, 'record');
  assert.equal(first.fields.recordId.value, 1);
  assert.deepEqual([first.fields.recordId.start, first.fields.recordId.end], [2, 5]);
  assert.equal(first.fields.payload, undefined);
  assert.equal(first.extensions.length, 2);
  assert.equal(first.extensions[0].raw, '31800c036162630000');
  assert.deepEqual(first.extensions[0].path.map(entry => entry.tag), [16, 17]);
  assert.deepEqual([first.extensions[0].start, first.extensions[0].end], [5, 14]);
  assert.equal(first.extensions[1].raw, 'a505040378797a');
  assert.equal(first.extensions[1].path[1].class, 2);
  assert.deepEqual([first.extensions[1].start, first.extensions[1].end], [14, 21]);
  const second = interpretRecord(outcome.records[1], schema, slice);
  assert.equal(second.fields.recordId.value, 2);
  assert.equal(second.fields.payload.value, '51');
  assert.equal(second.extensions.length, 0);
});

test('同号 tag 不跨 class 或上下文套解释', () => {
  const bytes = Buffer.from([0x30, 0x06, 0x02, 0x01, 0x01, 0x82, 0x01, 0x02]);
  const outcome = receive(bytes);
  const record = interpretRecord(outcome.records[0], schema, (start, end) => bytes.subarray(start, end));
  assert.equal(record.fields.recordId.value, 1);
  assert.equal(record.extensions.length, 1);
  assert.equal(record.extensions[0].raw, '820102');
  assert.deepEqual(record.extensions[0].path.map(entry => [entry.class, entry.tag]), [[0, 16], [2, 2]]);
});

test('未声明记录类型整体保留，无声明不解释', () => {
  const bytes = Buffer.from([0x31, 0x03, 0x02, 0x01, 0x05]);
  const outcome = receive(bytes);
  const slice = (start, end) => bytes.subarray(start, end);
  const undeclared = interpretRecord(outcome.records[0], schema, slice);
  assert.equal(undeclared.type, 'undeclared');
  assert.equal(undeclared.extensions[0].raw, '3103020105');
  const raw = interpretRecord(outcome.records[0], null, slice);
  assert.equal(raw.type, 'raw');
  assert.deepEqual(raw.fields, {});
  assert.deepEqual(raw.extensions, []);
});

test('字段语义失败隔离到单条记录，不影响同批其他记录', () => {
  const bytes = Buffer.concat([Buffer.from([0x30, 0x05, 0x22, 0x03, 0x01, 0x01, 0xff]),
    Buffer.from([0x30, 0x03, 0x02, 0x01, 0x07])]);
  const outcome = receive(bytes);
  assert.equal(outcome.status, 'ok');
  assert.equal(outcome.records.length, 2);
  const slice = (start, end) => bytes.subarray(start, end);
  const broken = interpretRecord(outcome.records[0], schema, slice);
  assert.equal(broken.type, 'record');
  assert.equal(broken.fields.recordId.error, 'field_constructed');
  assert.equal(broken.errors.length, 1);
  const healthy = interpretRecord(outcome.records[1], schema, slice);
  assert.equal(healthy.fields.recordId.value, 7);
  assert.equal(healthy.errors.length, 0);
});
