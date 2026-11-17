import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startProvider } from '../src/provider.mjs';
import { startService } from '../src/service.mjs';
const directory = await mkdtemp(join(tmpdir(), 'intake-demo-'));
const provider = await startProvider();
const service = await startService({ source: provider.url, directory });
const post = async (path, body) => {
  const response = await fetch(`${service.url}${path}`, { method: 'POST',
    headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  if (response.status !== 201) throw new Error(await response.text());
  return response.json();
};
try {
  console.log(JSON.stringify({ source: provider.url, product: service.url }));
  console.log('来源目录', await (await fetch(`${provider.url}/catalog`)).json());
  console.log('单件接收', await post('/intakes', { path: '/primary' }));
  const stream = await post('/streams', { path: '/stream', schema: '/schema' });
  console.log('流接收（含开放扩展）', JSON.stringify(stream.parsed, null, 2));
  const damaged = await post('/streams', { path: '/damaged', schema: '/schema' });
  console.log('损坏依据', JSON.stringify(damaged.parsed.failure, null, 2));
  console.log('已保存资料', await (await fetch(`${service.url}/records`)).json());
} finally { await service.close(); await provider.close(); await rm(directory, { recursive: true, force: true }); }
