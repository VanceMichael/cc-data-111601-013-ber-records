import http from 'node:http';
import { fileURLToPath } from 'node:url';
import { Store } from './store.mjs';
import { acquire } from './transport.mjs';
import { inspect, BerStreamParser } from './reader.mjs';
import { normalizeSchema, summarizeStream } from './schema.mjs';

async function readJson(request) {
  const chunks = [];
  let length = 0;
  for await (const chunk of request) {
    length += chunk.length;
    if (length > 16384) throw new Error('request_too_large');
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString());
}

export async function startService({ source, directory, port = 0 }) {
  const store = await new Store(directory).initialize();
  const server = http.createServer(async (request, response) => {
    response.setHeader('Content-Type', 'application/json');
    try {
      const url = new URL(request.url, 'http://localhost');
      if (url.pathname === '/health') return response.end(JSON.stringify({ ready: true }));
      if (url.pathname === '/records' && request.method === 'GET') return response.end(JSON.stringify(await store.list()));
      if (url.pathname.startsWith('/objects/') && request.method === 'GET') {
        response.setHeader('Content-Type', 'application/octet-stream');
        return response.end(await store.object(url.pathname.slice(9)));
      }
      if (url.pathname === '/intakes' && request.method === 'POST') {
        const payload = await readJson(request);
        if (typeof payload.path !== 'string') throw new Error('path_required');
        const result = await acquire(source, payload.path);
        const parsed = inspect(result.bytes);
        const record = await store.accept(result.bytes, new URL(payload.path, source).href, parsed);
        response.statusCode = 201;
        return response.end(JSON.stringify(record));
      }
      if (url.pathname === '/streams' && request.method === 'POST') {
        const payload = await readJson(request);
        if (typeof payload.path !== 'string') throw new Error('path_required');
        let schema = null;
        if (typeof payload.schema === 'string') {
          const document = await acquire(source, payload.schema);
          schema = normalizeSchema(JSON.parse(document.bytes.toString('utf8')));
        }
        const parser = new BerStreamParser();
        const result = await acquire(source, payload.path, { onChunk: chunk => parser.push(chunk) });
        const outcome = parser.finish();
        const parsed = summarizeStream(outcome, schema, result.bytes);
        const record = await store.accept(result.bytes, new URL(payload.path, source).href, parsed);
        response.statusCode = 201;
        return response.end(JSON.stringify(record));
      }
      response.writeHead(404); response.end(JSON.stringify({ error: 'not_found' }));
    } catch (error) { response.statusCode = 422; response.end(JSON.stringify({ error: error.message })); }
  });
  await new Promise(resolve => server.listen(port, '127.0.0.1', resolve));
  return { server, store, url: `http://127.0.0.1:${server.address().port}`,
    close: () => new Promise(resolve => server.close(resolve)) };
}
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  if (!process.env.SOURCE_URL) throw new Error('SOURCE_URL_required');
  const service = await startService({ source: process.env.SOURCE_URL,
    directory: process.env.DATA_DIR ?? './data', port: Number(process.env.PORT ?? 4102) });
  console.log(JSON.stringify({ product: service.url }));
}
