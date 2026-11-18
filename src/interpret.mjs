// 按来源声明的记录类型领取结构化字段；未知扩展以原 TLV、嵌套路径与字节位置保存。
// 已知路径只匹配 universal class 的 tag 数字：context/private/application 的同号 tag
// 不套用解释；路径之外的同号 tag（更深层级）也不套用解释。
// 字段级语义失败隔离到该条记录，不影响同批其他记录。

import { identityOf } from './ber.mjs';

export { identityOf };

export function sameIdentity(a, b) {
  return a.class === b.class && a.constructed === b.constructed && a.tag === b.tag;
}

function decodeValue(type, content) {
  switch (type) {
    case 'INTEGER': {
      if (content.length === 0) throw new Error('integer_empty');
      let value = 0n;
      for (const byte of content) value = (value << 8n) | BigInt(byte);
      if (content[0] & 0x80) value -= 1n << BigInt(content.length * 8);
      if (value >= BigInt(Number.MIN_SAFE_INTEGER) && value <= BigInt(Number.MAX_SAFE_INTEGER)) {
        return { value: Number(value) };
      }
      return { value: value.toString() };
    }
    case 'OCTET STRING': return { value: content.toString('hex') };
    case 'UTF8String': return { value: content.toString('utf8') };
    case 'BOOLEAN': {
      if (content.length !== 1) throw new Error('boolean_length');
      return { value: content[0] !== 0 };
    }
    case 'NULL': {
      if (content.length !== 0) throw new Error('null_length');
      return { value: null };
    }
    default: return { value: content.toString('hex'), decoded: false };
  }
}

function pathKey(path) {
  return path.join('.');
}

// node：一条完整顶层 TLV（偏移为交付流内绝对偏移）。
// schema：来源 /schema 声明；为空则不解释，记录标记为 raw。
// slice(start, end)：按绝对偏移取交付字节的函数。
export function interpretRecord(node, schema, slice) {
  const identity = identityOf(node);
  const result = { identity, type: 'raw', fields: {}, extensions: [], errors: [] };
  if (!schema || typeof schema !== 'object') return result;
  if (!schema.record || !sameIdentity(identity, schema.record)) {
    result.type = 'undeclared';
    result.extensions.push({ path: [identity], start: node.start, end: node.end,
      raw: slice(node.start, node.end).toString('hex') });
    return result;
  }
  result.type = 'record';
  const known = (Array.isArray(schema.known) ? schema.known : [])
    .filter(entry => Array.isArray(entry?.path) && typeof entry.name === 'string');
  const exact = new Map(known.map(entry => [pathKey(entry.path), entry]));
  const prefixes = new Set();
  for (const entry of known) {
    for (let length = 1; length < entry.path.length; length++) {
      prefixes.add(pathKey(entry.path.slice(0, length)));
    }
  }
  const walk = (container, tagPath, identityPath) => {
    for (const child of container.children ?? []) {
      const childIdentity = identityOf(child);
      const childIdentities = [...identityPath, childIdentity];
      const childPath = child.class === 0 ? [...tagPath, child.tag] : null;
      const key = childPath ? pathKey(childPath) : null;
      const field = key ? exact.get(key) : null;
      if (field) {
        const span = { start: child.start, end: child.end };
        if (child.constructed) {
          result.fields[field.name] = { type: field.type, error: 'field_constructed', ...span };
          result.errors.push({ field: field.name, kind: 'field_constructed', ...span });
        } else {
          try {
            const decoded = decodeValue(field.type, slice(child.valueStart, child.valueEnd ?? child.end));
            result.fields[field.name] = { type: field.type, value: decoded.value, ...span };
          } catch (error) {
            result.fields[field.name] = { type: field.type, error: error.message, ...span };
            result.errors.push({ field: field.name, kind: error.message, ...span });
          }
        }
      } else if (key && prefixes.has(key) && child.constructed) {
        walk(child, childPath, childIdentities);
      } else {
        result.extensions.push({ path: childIdentities, start: child.start, end: child.end,
          raw: slice(child.start, child.end).toString('hex') });
      }
    }
  };
  walk(node, node.class === 0 ? [node.tag] : [], [identity]);
  return result;
}
