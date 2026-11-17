// 已声明记录类型的结构化领取：schema 只登记已知字段，未知扩展原样保留。
// tag 身份 = class + tag（constructed 参与记录类型匹配），数字相同但 class 不同不套解释。

const FIELD_TYPES = new Set(['INTEGER', 'OCTET STRING']);
const MAX_SAFE = BigInt(Number.MAX_SAFE_INTEGER);
const utf8 = new TextDecoder('utf-8', { fatal: true });
const tries = new WeakMap();

function identity(step, code) {
  if (typeof step === 'number') {
    if (!Number.isInteger(step) || step < 0) throw new Error(code);
    return { class: 0, tag: step };
  }
  if (step && typeof step === 'object'
      && Number.isInteger(step.class) && step.class >= 0 && step.class <= 3
      && Number.isInteger(step.tag) && step.tag >= 0) {
    return { class: step.class, tag: step.tag };
  }
  throw new Error(code);
}

export function normalizeSchema(document) {
  if (!document || typeof document !== 'object' || Array.isArray(document)) {
    throw new Error('schema_invalid');
  }
  const head = identity(document.record, 'schema_invalid');
  if (document.record.constructed !== undefined && typeof document.record.constructed !== 'boolean') {
    throw new Error('schema_invalid');
  }
  const record = { ...head, constructed: document.record.constructed ?? true };
  const known = [];
  const names = new Set();
  const paths = new Set();
  for (const entry of document.known ?? []) {
    if (!entry || typeof entry !== 'object') throw new Error('schema_invalid');
    if (!Array.isArray(entry.path) || entry.path.length < 2) throw new Error('schema_bad_path');
    const path = entry.path.map(step => identity(step, 'schema_bad_path'));
    if (path[0].class !== record.class || path[0].tag !== record.tag) throw new Error('schema_bad_path');
    if (typeof entry.name !== 'string' || !entry.name) throw new Error('schema_invalid');
    if (names.has(entry.name)) throw new Error('schema_duplicate_field');
    names.add(entry.name);
    const key = path.map(step => `${step.class}:${step.tag}`).join('/');
    if (paths.has(key)) throw new Error('schema_duplicate_field');
    paths.add(key);
    if (!FIELD_TYPES.has(entry.type)) throw new Error('schema_unsupported_type');
    known.push({ path, name: entry.name, type: entry.type });
  }
  const extensions = document.extensions ?? 'preserve-tlv';
  if (extensions !== 'preserve-tlv') throw new Error('schema_unsupported_extensions');
  return { record, known, extensions };
}

function trieFor(schema) {
  let root = tries.get(schema);
  if (root) return root;
  root = { edges: new Map(), field: null };
  for (const field of schema.known) {
    let node = root;
    for (let depth = 1; depth < field.path.length; depth += 1) {
      const step = field.path[depth];
      const key = `${step.class}:${step.tag}`;
      if (!node.edges.has(key)) node.edges.set(key, { edges: new Map(), field: null });
      node = node.edges.get(key);
    }
    node.field = field;
  }
  tries.set(schema, root);
  return root;
}

function boundedRaw(bytes, start, end, limit) {
  const size = end - start;
  const raw = size <= limit ? bytes.subarray(start, end) : bytes.subarray(start, start + limit);
  return { raw: raw.toString('hex'), ...(size > limit ? { truncated: true } : {}) };
}

function decodeInteger(content) {
  if (!content.length) return null;
  let value = 0n;
  for (const byte of content) value = (value << 8n) | BigInt(byte);
  if (content[0] & 0x80) value -= 1n << BigInt(content.length * 8);
  return value <= MAX_SAFE && value >= -MAX_SAFE ? Number(value) : value.toString(10);
}

function decodeField(node, field, bytes) {
  const content = bytes.subarray(node.valueStart, node.indefinite ? node.end - 2 : node.end);
  if (field.type === 'INTEGER') {
    if (node.constructed) return { problem: 'field_not_primitive' };
    const value = decodeInteger(content);
    return value === null ? { problem: 'field_bad_integer' } : { value: { type: 'INTEGER', value } };
  }
  if (node.constructed) return { problem: 'field_constructed_string' };
  const value = { type: 'OCTET STRING', hex: content.toString('hex') };
  try { value.utf8 = utf8.decode(content); } catch { /* 非 UTF-8 内容，保留 hex */ }
  return { value };
}

function extensionOf(node, path, bytes, rawLimit) {
  return { path, class: node.class, constructed: node.constructed, tag: node.tag,
    start: node.start, end: node.end, ...boundedRaw(bytes, node.start, node.end, rawLimit) };
}

// 解释一条已闭合的顶层记录。不匹配声明类型时整条按未知保存；
// 匹配时已知路径解码为字段，未知子 TLV 连同层级路径与字节位置原样保留，
// 不深入未知构造内容里按已知 tag 套解释。
export function interpretRecord(node, schema, bytes, { rawLimit = 8192 } = {}) {
  const type = { class: node.class, tag: node.tag, constructed: node.constructed };
  if (node.class !== schema.record.class || node.tag !== schema.record.tag
      || node.constructed !== schema.record.constructed) {
    return { matched: false, type, ...boundedRaw(bytes, node.start, node.end, rawLimit) };
  }
  const fields = {};
  const extensions = [];
  const problems = [];
  const walk = (current, trieNode, path) => {
    for (const child of current.children ?? []) {
      const edge = trieNode.edges.get(`${child.class}:${child.tag}`);
      const childPath = [...path, { class: child.class, tag: child.tag }];
      if (!edge) { extensions.push(extensionOf(child, childPath, bytes, rawLimit)); continue; }
      if (edge.field) {
        if (fields[edge.field.name] !== undefined) {
          problems.push({ path: childPath, name: edge.field.name, reason: 'field_repeated', offset: child.start });
          extensions.push(extensionOf(child, childPath, bytes, rawLimit));
        } else {
          const decoded = decodeField(child, edge.field, bytes);
          if (decoded.problem) {
            problems.push({ path: childPath, name: edge.field.name, reason: decoded.problem, offset: child.start });
          } else {
            fields[edge.field.name] = decoded.value;
          }
        }
      }
      if (edge.edges.size && child.constructed) walk(child, edge, childPath);
    }
  };
  walk(node, trieFor(schema), [{ class: node.class, tag: node.tag }]);
  return { matched: true, type, fields, extensions, problems };
}

// 流收件摘要：每条记录的类型、字段、扩展与字节跨度；失败处附字节依据摘录。
export function summarizeStream(result, schema, bytes, { rawLimit = 8192, excerptLimit = 512 } = {}) {
  const records = result.records.map((record, index) => {
    const base = { index, start: record.start, end: record.end,
      class: record.node.class, tag: record.node.tag, constructed: record.node.constructed };
    if (!schema) return { ...base, matched: null };
    const interpreted = interpretRecord(record.node, schema, bytes, { rawLimit });
    if (!interpreted.matched) {
      return { ...base, matched: false, raw: interpreted.raw,
        ...(interpreted.truncated ? { truncated: true } : {}) };
    }
    return { ...base, matched: true, fields: interpreted.fields, extensions: interpreted.extensions,
      ...(interpreted.problems.length ? { problems: interpreted.problems } : {}) };
  });
  let failure = null;
  if (result.failure) {
    const { span } = result.failure;
    failure = { ...result.failure, ...(() => {
      const { raw, truncated } = boundedRaw(bytes, span.start, span.end, excerptLimit);
      return { excerpt: raw, ...(truncated ? { excerptTruncated: true } : {}) };
    })() };
  }
  return { kind: 'ber-record-stream', outcome: result.outcome,
    schema: schema ? { record: schema.record,
      fields: schema.known.map(({ name, type }) => ({ name, type })) } : null,
    records, failure, bytes: result.receivedBytes };
}
