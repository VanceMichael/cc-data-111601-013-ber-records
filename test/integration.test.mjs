import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startProvider } from '../src/provider.mjs';
import { startService } from '../src/service.mjs';
import { Store } from '../src/store.mjs';
import { inspect } from '../src/reader.mjs';

test('单件资料可解释，畸形输入被拒绝', async () => {
  const fixture = await readFile(new URL('../fixtures/primary.bin', import.meta.url));
  assert.ok(inspect(fixture));
  assert.throws(() => inspect(Buffer.alloc(0)));
});

test('来源领取、原件持久化、重启查询及无副作用拒收', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'intake-test-'));
  const provider = await startProvider();
  const service = await startService({ source: provider.url, directory });
  try {
    const body = JSON.stringify({ path: '/primary' });
    const send = path => fetch(`${service.url}/intakes`, { method: 'POST',
      headers: { 'content-type': 'application/json' }, body: JSON.stringify({ path }) });
    const first = await send('/primary');
    assert.equal(first.status, 201);
    const record = await first.json();
    assert.deepEqual(await new Store(directory).list(), [record]);
    assert.deepEqual(Buffer.from(await (await fetch(`${service.url}/objects/${record.digest}`)).arrayBuffer()),
      await readFile(new URL('../fixtures/primary.bin', import.meta.url)));
    const repeated = await send('/primary');
    assert.equal((await repeated.json()).id, record.id);
    assert.equal((await send('/missing')).status, 422);
    assert.equal((await send('https://example.invalid/foreign')).status, 422);
    assert.equal((await new Store(directory).list()).length, 1);
    const range = await fetch(`${provider.url}/primary`, { headers: { range: 'bytes=0-0' } });
    assert.equal(range.status, 206);
    assert.equal((await range.arrayBuffer()).byteLength, 1);
    const reject = await fetch(`${provider.url}/primary`, { headers: { 'if-match': '"old"' } });
    assert.equal(reject.status, 412);
    assert.ok(body.includes('primary'));
  } finally { await service.close(); await provider.close(); await rm(directory, { recursive: true, force: true }); }
});

test('流交付：按声明类型领取字段，扩展原样保留，重领幂等', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'intake-test-'));
  const provider = await startProvider();
  const service = await startService({ source: provider.url, directory });
  try {
    const send = body => fetch(`${service.url}/streams`, { method: 'POST',
      headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    const response = await send({ path: '/stream', schema: '/schema' });
    assert.equal(response.status, 201);
    const delivery = await response.json();
    assert.equal(delivery.parsed.outcome, 'complete');
    assert.equal(delivery.parsed.records.length, 2);
    const [first, second] = delivery.parsed.records;
    assert.deepEqual([first.start, first.end], [0, 23]);
    assert.deepEqual(first.fields.recordId, { type: 'INTEGER', value: 1 });
    assert.equal(first.extensions.length, 2);
    assert.deepEqual(first.extensions[1].path, [{ class: 0, tag: 16 }, { class: 2, tag: 5 }]);
    assert.equal(first.extensions[1].raw, 'a505040378797a');
    assert.deepEqual(second.fields.payload, { type: 'OCTET STRING', hex: '51', utf8: 'Q' });
    const repeated = await (await send({ path: '/stream', schema: '/schema' })).json();
    assert.equal(repeated.id, delivery.id);
    const object = Buffer.from(await (await fetch(`${service.url}/objects/${delivery.digest}`)).arrayBuffer());
    assert.deepEqual(object, await readFile(new URL('../fixtures/resource-01.bin', import.meta.url)));
    assert.equal((await new Store(directory).list()).length, 1);
    const single = await fetch(`${service.url}/intakes`, { method: 'POST',
      headers: { 'content-type': 'application/json' }, body: JSON.stringify({ path: '/stream' }) });
    assert.equal(single.status, 422);
    assert.equal((await send({ path: '/stream', schema: '/missing' })).status, 422);
    assert.equal((await send({ schema: '/schema' })).status, 422);
  } finally { await service.close(); await provider.close(); await rm(directory, { recursive: true, force: true }); }
});

test('损坏交付：登记字节依据，已闭合记录不受影响', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'intake-test-'));
  const provider = await startProvider();
  const service = await startService({ source: provider.url, directory });
  try {
    const send = body => fetch(`${service.url}/streams`, { method: 'POST',
      headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    const response = await send({ path: '/damaged', schema: '/schema' });
    assert.equal(response.status, 201);
    const delivery = await response.json();
    assert.equal(delivery.parsed.outcome, 'incomplete');
    assert.equal(delivery.parsed.records.length, 0);
    const { failure } = delivery.parsed;
    assert.equal(failure.reason, 'ber_unclosed');
    assert.deepEqual(failure.span, { start: 0, end: 11 });
    assert.equal(failure.pendingValue.length, 256);
    assert.equal(failure.pendingValue.received, 2);
    assert.equal(failure.excerpt, '3080020101048201006162');
    const object = Buffer.from(await (await fetch(`${service.url}/objects/${delivery.digest}`)).arrayBuffer());
    assert.equal(object.toString('hex'), failure.excerpt);
    const plain = await (await send({ path: '/stream' })).json();
    assert.equal(plain.parsed.records.length, 2);
    assert.equal(plain.parsed.records[0].matched, null);
  } finally { await service.close(); await provider.close(); await rm(directory, { recursive: true, force: true }); }
});
