import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startProvider } from '../src/provider.mjs';
import { startService } from '../src/service.mjs';
const directory = await mkdtemp(join(tmpdir(), 'intake-demo-'));
const provider = await startProvider();
const service = await startService({ source: provider.url, directory });
const post = (path, body) => fetch(`${service.url}${path}`, { method: 'POST',
  headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
try {
  console.log(JSON.stringify({ source: provider.url, product: service.url }));
  console.log('来源目录', await (await fetch(`${provider.url}/catalog`)).json());
  const intake = await post('/intakes', { path: '/primary' });
  if (intake.status !== 201) throw new Error(await intake.text());
  console.log('单件接收', await intake.json());
  const delivery = await post('/deliveries', { path: '/stream' });
  if (delivery.status !== 201) throw new Error(await delivery.text());
  const stream = await delivery.json();
  console.log('连续交付接收（不定长、构造型、任意网络块）',
    JSON.stringify({ status: stream.status, records: stream.records.length,
      fields: stream.records.map(record => record.fields), extensions: stream.records[0].extensions }));
  const damaged = await (await post('/deliveries', { path: '/damaged' })).json();
  console.log('长度损坏字节依据', JSON.stringify(damaged.failure));
  console.log('交付目录', (await (await fetch(`${service.url}/deliveries`)).json())
    .map(entry => ({ id: entry.id, status: entry.status, records: entry.records.length })));
  console.log('已保存资料', await (await fetch(`${service.url}/records`)).json());
} finally { await service.close(); await provider.close(); await rm(directory, { recursive: true, force: true }); }
