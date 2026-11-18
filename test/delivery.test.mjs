import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startProvider } from '../src/provider.mjs';
import { startService } from '../src/service.mjs';

const streamBytes = await readFile(new URL('../fixtures/resource-01.bin', import.meta.url));
const damagedBytes = await readFile(new URL('../fixtures/resource-02.bin', import.meta.url));

async function setup() {
  const directory = await mkdtemp(join(tmpdir(), 'delivery-test-'));
  const provider = await startProvider();
  const service = await startService({ source: provider.url, directory });
  const deliver = (body, id) => fetch(`${service.url}/deliveries${id ? `/${id}` : ''}`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  return { directory, provider, service, deliver,
    close: async () => { await service.close(); await provider.close();
      await rm(directory, { recursive: true, force: true }); } };
}

test('连续交付按声明解释记录，扩展原样保留，重领返回原 id', async () => {
  const { service, deliver, close } = await setup();
  try {
    const response = await deliver({ path: '/stream' });
    assert.equal(response.status, 201);
    const delivery = await response.json();
    assert.equal(delivery.status, 'ok');
    assert.equal(delivery.schema.applied, true);
    assert.equal(delivery.schema.path, '/schema');
    assert.equal(delivery.bytes, streamBytes.length);
    assert.equal(delivery.records.length, 2);
    const [first, second] = delivery.records;
    assert.deepEqual([first.start, first.end], [0, 23]);
    assert.deepEqual(first.identity, { class: 0, constructed: true, tag: 16 });
    assert.equal(first.fields.recordId.value, 1);
    assert.equal(first.extensions.length, 2);
    assert.equal(first.extensions[0].raw, '31800c036162630000');
    assert.equal(first.extensions[1].path[1].class, 2);
    assert.equal(second.fields.recordId.value, 2);
    assert.equal(second.fields.payload.value, '51');
    assert.deepEqual(Buffer.from(await (await fetch(`${service.url}/objects/${delivery.digest}`)).arrayBuffer()),
      streamBytes);
    const again = await (await deliver({ path: '/stream' })).json();
    assert.equal(again.id, delivery.id);
    const listed = await (await fetch(`${service.url}/deliveries`)).json();
    assert.equal(listed.length, 1);
    const single = await fetch(`${service.url}/deliveries/${delivery.id}`);
    assert.equal(single.status, 200);
    assert.equal((await single.json()).id, delivery.id);
    assert.equal((await fetch(`${service.url}/deliveries/${delivery.id.replace(/.$/, '0')}`)).status, 404);
  } finally { await close(); }
});

test('长度损坏的交付登记字节依据，原件完整保存', async () => {
  const { service, deliver, close } = await setup();
  try {
    const response = await deliver({ path: '/damaged' });
    assert.equal(response.status, 201);
    const delivery = await response.json();
    assert.equal(delivery.status, 'length');
    assert.equal(delivery.records.length, 0);
    assert.equal(delivery.failure.error, 'ber_value_short');
    assert.equal(delivery.failure.offset, 5);
    assert.equal(delivery.failure.declaredEnd, 265);
    assert.equal(delivery.failure.streamEnd, damagedBytes.length);
    assert.deepEqual([delivery.failure.start, delivery.failure.end], [0, damagedBytes.length]);
    assert.deepEqual(Buffer.from(await (await fetch(`${service.url}/objects/${delivery.digest}`)).arrayBuffer()),
      damagedBytes);
  } finally { await close(); }
});

test('显式无声明不解释字段，显式声明领取失败即拒收', async () => {
  const { service, deliver, close } = await setup();
  try {
    const raw = await (await deliver({ path: '/stream', schema: null })).json();
    assert.equal(raw.schema.applied, false);
    assert.equal(raw.records[0].type, 'raw');
    assert.deepEqual(raw.records[0].fields, {});
    assert.equal((await deliver({ path: '/stream', schema: '/missing' })).status, 422);
    assert.equal((await deliver({ path: '/missing' })).status, 422);
    assert.equal((await deliver({ schema: '/schema' })).status, 422);
    const listed = await (await fetch(`${service.url}/deliveries`)).json();
    assert.equal(listed.length, 1);
  } finally { await close(); }
});
