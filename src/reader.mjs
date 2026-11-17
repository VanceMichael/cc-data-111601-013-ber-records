// BER（X.690 子集）流式读取：high-tag-number、short/long definite length、
// 仅 constructed 可用的 indefinite length。EOC 只在不定长容器期待子项的位置解释，
// primitive 内容里的 00 00 是数据，绝不扫描结束标记来猜测记录边界。
// 收件结论三态：complete（正常结束）、incomplete（容器尚未闭合）、corrupt（长度/结构损坏）。
// 损坏与未闭合都带字节偏移依据；长度损坏或顶层未闭合时不继续猜下一条。

export class BerError extends Error {
  constructor(code, offset, detail = {}) {
    super(code);
    this.name = 'BerError';
    this.code = code;
    this.offset = offset;
    this.detail = detail;
  }
}

// 读取一个 TLV 头。字节不足返回 null（等待更多网络块）；可证明的损坏抛 BerError。
function readHeader(buf, pos, absolute) {
  if (pos >= buf.length) return null;
  const first = buf[pos];
  const tagClass = first >> 6;
  const constructed = (first & 0x20) !== 0;
  let tag = first & 0x1f;
  let index = pos + 1;
  if (tag === 0x1f) {
    tag = 0;
    let octets = 0;
    for (;;) {
      if (index >= buf.length) return null;
      const byte = buf[index++];
      octets += 1;
      if (octets > 9 || tag > (Number.MAX_SAFE_INTEGER - 127) / 128) {
        throw new BerError('ber_tag_too_large', absolute);
      }
      tag = tag * 128 + (byte & 0x7f);
      if ((byte & 0x80) === 0) break;
    }
  }
  if (index >= buf.length) return null;
  const lengthByte = buf[index++];
  let length = null;
  let indefinite = false;
  if (lengthByte === 0x80) {
    if (!constructed) throw new BerError('ber_indefinite_primitive', absolute);
    indefinite = true;
  } else if (lengthByte & 0x80) {
    const count = lengthByte & 0x7f;
    if (count === 0x7f) throw new BerError('ber_length_reserved', absolute);
    if (count > 8) throw new BerError('ber_length_too_large', absolute, { count });
    if (index + count > buf.length) return null;
    length = 0;
    for (let n = 0; n < count; n += 1) {
      if (length > (Number.MAX_SAFE_INTEGER - 255) / 256) {
        throw new BerError('ber_length_too_large', absolute, { count });
      }
      length = length * 256 + buf[index++];
    }
  } else {
    length = lengthByte;
  }
  const headerSize = index - pos;
  const eoc = tagClass === 0 && !constructed && tag === 0 && !indefinite && length === 0;
  return { tagClass, constructed, tag, indefinite, length, headerSize, eoc,
    start: absolute, valueStart: absolute + headerSize };
}

export class BerStreamParser {
  constructor({ maxRecordBytes = 8 * 1024 * 1024 } = {}) {
    this.maxRecordBytes = maxRecordBytes;
    this.incoming = [];
    this.incomingBytes = 0;
    this.buffer = Buffer.alloc(0);
    this.base = 0;              // buffer[0] 的绝对偏移
    this.totalBytes = 0;        // 已推送的全部字节数
    this.stack = [];            // 未闭合构造容器 { node, remaining: number|null }
    this.pendingPrimitive = null; // 头已消费、值未齐的 primitive { node, valueLength }
    this.recordStart = null;    // 当前顶层记录的绝对起点
    this.records = [];          // 已完整闭合的顶层记录
    this.stall = null;
    this.waiting = 1;
    this.failed = null;
    this.ended = false;
    this.result = null;
  }

  push(chunk) {
    if (this.ended) throw new Error('ber_parser_finished');
    this.totalBytes += chunk.length;
    if (this.failed) return this;
    if (chunk.length) { this.incoming.push(chunk); this.incomingBytes += chunk.length; }
    if (this.incomingBytes < this.waiting) return this;
    this.#absorb();
    this.#parse();
    return this;
  }

  finish() {
    if (!this.ended) {
      this.ended = true;
      this.#absorb();
      if (!this.failed) this.#parse();
      const end = this.totalBytes;
      if (this.failed) {
        const start = this.recordStart ?? Math.min(this.failed.offset, end);
        this.result = { outcome: 'corrupt', records: this.records, receivedBytes: end,
          failure: { reason: this.failed.code, offset: this.failed.offset,
            recordStart: start, span: { start, end }, ...this.failed.detail } };
      } else if (this.stack.length || this.pendingPrimitive || this.buffer.length) {
        const start = this.recordStart ?? this.base;
        const failure = { reason: 'ber_unclosed', recordStart: start, offset: end,
          needed: this.stall?.kind === 'value' ? this.stall.needed : null,
          openContainers: this.stack.map(frame => ({ class: frame.node.class,
            constructed: frame.node.constructed, tag: frame.node.tag,
            start: frame.node.start, valueStart: frame.node.valueStart,
            remaining: frame.remaining })),
          span: { start, end } };
        if (this.pendingPrimitive) {
          const { node, valueLength } = this.pendingPrimitive;
          failure.pendingValue = { class: node.class, constructed: node.constructed,
            tag: node.tag, start: node.start, valueStart: node.valueStart,
            length: valueLength, received: this.buffer.length };
        }
        this.result = { outcome: 'incomplete', records: this.records, receivedBytes: end, failure };
      } else {
        this.result = { outcome: 'complete', records: this.records, receivedBytes: end, failure: null };
      }
    }
    return this.result;
  }

  #absorb() {
    if (!this.incoming.length) return;
    const incoming = this.incoming.length === 1
      ? this.incoming[0] : Buffer.concat(this.incoming, this.incomingBytes);
    this.buffer = this.buffer.length === 0 ? incoming : Buffer.concat([this.buffer, incoming]);
    this.incoming = [];
    this.incomingBytes = 0;
  }

  // 把 total 字节计入最近一层定长祖先；定长父容器装不下即长度损坏，偏移可定位。
  #charge(total, offset) {
    for (let index = this.stack.length - 1; index >= 0; index -= 1) {
      const frame = this.stack[index];
      if (frame.remaining === null) continue;
      frame.remaining -= total;
      if (frame.remaining < 0) {
        throw new BerError('ber_length_overrun', offset, {
          container: { class: frame.node.class, constructed: frame.node.constructed,
            tag: frame.node.tag, start: frame.node.start, end: frame.node.end },
          declared: total, available: frame.remaining + total });
      }
      return;
    }
  }

  #complete(node) {
    const parent = this.stack[this.stack.length - 1];
    if (parent) {
      parent.node.children.push(node);
    } else {
      this.records.push({ node, start: node.start, end: node.end });
      this.recordStart = null;
    }
  }

  #parse() {
    if (this.failed) return;
    let pos = 0;
    const buf = this.buffer;
    try {
      for (;;) {
        if (this.pendingPrimitive) {
          const { node, valueLength } = this.pendingPrimitive;
          const available = buf.length - pos;
          if (available < valueLength) {
            this.stall = { kind: 'value', needed: valueLength - available };
            break;
          }
          pos += valueLength;
          this.pendingPrimitive = null;
          this.#complete(node);
          continue;
        }
        while (this.stack.length && this.stack[this.stack.length - 1].remaining === 0) {
          this.#complete(this.stack.pop().node);
        }
        if (pos >= buf.length) {
          this.stall = this.stack.length ? { kind: 'header' } : null;
          break;
        }
        if (!this.stack.length && this.recordStart === null) this.recordStart = this.base + pos;
        const header = readHeader(buf, pos, this.base + pos);
        if (!header) { this.stall = { kind: 'header' }; break; }
        if (header.eoc) {
          const frame = this.stack[this.stack.length - 1];
          if (!frame || frame.remaining !== null) {
            throw new BerError('ber_unexpected_eoc', this.base + pos);
          }
          pos += 2;
          this.#charge(2, this.base + pos - 2);
          this.stack.pop();
          frame.node.end = this.base + pos;
          this.#complete(frame.node);
          continue;
        }
        const total = header.indefinite ? header.headerSize : header.headerSize + header.length;
        if (!this.stack.length && !header.indefinite && total > this.maxRecordBytes) {
          throw new BerError('ber_record_too_large', this.base + pos, { declared: total });
        }
        this.#charge(total, this.base + pos);
        const node = { class: header.tagClass, constructed: header.constructed, tag: header.tag,
          start: header.start, valueStart: header.valueStart,
          end: header.indefinite ? null : header.start + total };
        if (header.indefinite) node.indefinite = true;
        if (header.constructed) {
          node.children = [];
          pos += header.headerSize;
          this.stack.push({ node, remaining: header.indefinite ? null : header.length });
        } else {
          pos += header.headerSize;
          this.pendingPrimitive = { node, valueLength: header.length };
        }
      }
    } catch (error) {
      if (!(error instanceof BerError)) throw error;
      this.failed = error;
    }
    this.buffer = buf.subarray(pos);
    this.base += pos;
    this.waiting = this.stall?.kind === 'value' ? this.stall.needed : 1;
  }
}

export function parseStream(chunks, options) {
  const parser = new BerStreamParser(options);
  for (const chunk of chunks) parser.push(chunk);
  return parser.finish();
}

function materializeRaw(node, bytes) {
  const contentEnd = node.indefinite ? node.end - 2 : node.end;
  node.raw = bytes.subarray(node.valueStart, contentEnd).toString('hex');
  if (node.children) for (const child of node.children) materializeRaw(child, bytes);
  return node;
}

// 单件读取契约：输入必须恰好是一条完整 BER 记录（定长或不定长均可）。
export function inspect(bytes) {
  const result = parseStream([bytes]);
  if (result.outcome === 'corrupt') {
    throw new BerError(result.failure.reason, result.failure.offset, result.failure);
  }
  if (result.outcome === 'incomplete') {
    throw new BerError('ber_unclosed', result.failure.offset, result.failure);
  }
  if (!result.records.length) throw new Error('ber_header_short');
  if (result.records.length > 1) throw new Error('simple_ber_trailing');
  return { kind: 'ber-record', root: materializeRaw(result.records[0].node, bytes) };
}
