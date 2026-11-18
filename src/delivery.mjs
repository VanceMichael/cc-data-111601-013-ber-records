// 连续交付接收：按来源声明领取 schema，把任意网络块流式送入 BER 接收器，
// 每条完整顶层 TLV 解释为一条记录；损坏以字节区间登记，不阻断已完整记录。

import { acquire } from './transport.mjs';
import { BerReceiver } from './ber.mjs';
import { interpretRecord } from './interpret.mjs';

async function loadSchema(source, path, required) {
  try {
    const result = await acquire(source, path);
    return { schema: JSON.parse(result.bytes.toString('utf8')), path };
  } catch (error) {
    if (required) throw error;
    return { schema: null, path: null };
  }
}

// options.schema：字符串路径表示显式声明（领取失败即失败）；
// null 表示不按声明解释；undefined 表示经来源 /catalog 发现。
export async function receiveDelivery(source, path, options = {}) {
  let schemaPath = options.schema;
  if (schemaPath === undefined) {
    schemaPath = null;
    try {
      const catalog = JSON.parse((await acquire(source, '/catalog')).bytes.toString('utf8'));
      if (catalog && typeof catalog.schema === 'string') schemaPath = catalog.schema;
    } catch { /* 无目录时按无声明继续接收 */ }
  }
  const required = typeof options.schema === 'string';
  const declared = schemaPath ? await loadSchema(source, schemaPath, required)
    : { schema: null, path: null };
  const receiver = new BerReceiver();
  const result = await acquire(source, path, { onChunk: chunk => receiver.feed(chunk) });
  const outcome = receiver.finish();
  const bytes = result.bytes;
  const slice = (start, end) => bytes.subarray(start, end);
  const records = outcome.records.map((node, index) => ({
    index, start: node.start, end: node.end, ...interpretRecord(node, declared.schema, slice),
  }));
  const entry = {
    source: new URL(path, source).href,
    bytes: bytes.length,
    status: outcome.status,
    schema: { path: declared.path, applied: Boolean(declared.schema) },
    records,
    failure: outcome.failure,
  };
  return { entry, bytes };
}
