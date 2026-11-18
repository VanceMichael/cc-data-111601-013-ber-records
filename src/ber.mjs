// 流式 BER TLV 接收：按任意网络块增量解析，不依赖块边界。
// tag 身份由 class、constructed、tag number 三者组成；支持 high-tag-number、
// short/long definite length，以及仅用于 constructed 的 indefinite length。
// EOC 只闭合当前不定长容器，不是字节扫描标记；primitive payload 里的 0000 是内容。
// 接收结果区分正常结束（ok）、容器尚未闭合（unclosed）、长度损坏（length）与
// 结构损坏（corrupt）；损坏影响范围以字节区间给出，损坏后不扫描结束标记继续猜。

const MAX_TAG_OCTETS = 6;
const MAX_LENGTH_OCTETS = 6;
const INCOMPLETE = Symbol('ber_incomplete');

const CATEGORIES = {
  ber_value_short: 'length',
  ber_container_short: 'length',
  ber_length_overrun: 'length',
  ber_container_unclosed: 'unclosed',
  ber_header_short: 'unclosed',
};

export class BerError extends Error {
  constructor(kind, offset, detail = {}) {
    super(kind);
    this.name = 'BerError';
    this.kind = kind;
    this.category = CATEGORIES[kind] ?? 'corrupt';
    this.offset = offset;
    this.detail = detail;
  }
}

export function identityOf(node) {
  return { class: node.class, constructed: node.constructed, tag: node.tag };
}

export class BerReceiver {
  constructor() {
    this.parts = [];
    this.total = 0;
    this.partIndex = 0;
    this.partOffset = 0;
    this.pos = 0;
    this.stack = [];
    this.filling = null;
    this.records = [];
    this.failed = null;
    this.failedStart = null;
    this.recordStart = null;
    this.outcome = null;
  }

  feed(chunk) {
    if (this.outcome) throw new Error('ber_feed_after_finish');
    if (!chunk || chunk.length === 0) return;
    this.parts.push(Buffer.from(chunk));
    this.total += chunk.length;
    if (this.failed) return;
    try {
      this._pump();
    } catch (error) {
      if (!(error instanceof BerError)) throw error;
      this.failed = error;
      this.failedStart = this.recordStart ?? error.offset;
    }
  }

  finish() {
    if (this.outcome) return this.outcome;
    let status = 'ok';
    let failure = null;
    if (this.failed) {
      status = this.failed.category;
      failure = { kind: this.failed.category, error: this.failed.kind, offset: this.failed.offset,
        start: this.failedStart, end: this.total, ...this.failed.detail };
    } else if (this.filling) {
      const node = this.filling;
      status = 'length';
      failure = { kind: 'length', error: 'ber_value_short', offset: node.start,
        start: this.recordStart ?? node.start, end: this.total,
        declaredLength: node.end - node.valueStart, valueStart: node.valueStart,
        declaredEnd: node.end, streamEnd: this.total, open: this._open() };
    } else {
      const container = [...this.stack].reverse().find(entry => !entry.indefinite);
      if (container && container.end > this.total) {
        status = 'length';
        failure = { kind: 'length', error: 'ber_container_short', offset: container.start,
          start: this.recordStart ?? container.start, end: this.total,
          declaredLength: container.end - container.valueStart, valueStart: container.valueStart,
          declaredEnd: container.end, streamEnd: this.total, open: this._open() };
      } else if (this.stack.length) {
        status = 'unclosed';
        failure = { kind: 'unclosed', error: 'ber_container_unclosed', offset: this.pos,
          start: this.recordStart ?? this.pos, end: this.total, open: this._open() };
      } else if (this.pos < this.total) {
        status = 'unclosed';
        failure = { kind: 'unclosed', error: 'ber_header_short', offset: this.pos,
          start: this.recordStart ?? this.pos, end: this.total };
      }
    }
    this.outcome = { status, records: this.records, failure };
    return this.outcome;
  }

  _open() {
    return this.stack.map(entry => ({ ...identityOf(entry), start: entry.start, indefinite: entry.indefinite }));
  }

  _mark() {
    return { partIndex: this.partIndex, partOffset: this.partOffset, pos: this.pos };
  }

  _restore(mark) {
    this.partIndex = mark.partIndex;
    this.partOffset = mark.partOffset;
    this.pos = mark.pos;
  }

  _take() {
    for (;;) {
      const part = this.parts[this.partIndex];
      if (part && this.partOffset < part.length) {
        const byte = part[this.partOffset++];
        this.pos++;
        return byte;
      }
      if (this.partIndex + 1 >= this.parts.length) throw INCOMPLETE;
      this.partIndex++;
      this.partOffset = 0;
    }
  }

  _bound() {
    for (let index = this.stack.length - 1; index >= 0; index--) {
      const entry = this.stack[index];
      if (!entry.indefinite) return entry.end;
    }
    return Infinity;
  }

  _pump() {
    for (;;) {
      if (this.filling) {
        const node = this.filling;
        let short = node.end - this.pos;
        while (short > 0) {
          const part = this.parts[this.partIndex];
          if (!part || this.partOffset >= part.length) {
            if (this.partIndex + 1 >= this.parts.length) return;
            this.partIndex++;
            this.partOffset = 0;
            continue;
          }
          const take = Math.min(short, part.length - this.partOffset);
          this.partOffset += take;
          this.pos += take;
          short -= take;
        }
        node.valueEnd = this.pos;
        this.filling = null;
        this._close(node);
        continue;
      }
      if (this._closeBounded()) continue;
      if (this.stack.length === 0 && this.recordStart === null) this.recordStart = this.pos;
      const mark = this._mark();
      let header;
      try {
        header = this._readHeader();
      } catch (error) {
        if (error === INCOMPLETE) { this._restore(mark); return; }
        throw error;
      }
      if (header.eoc) {
        const top = this.stack[this.stack.length - 1];
        if (!top || !top.indefinite) {
          throw new BerError('ber_eoc_unexpected', header.start, { open: this._open() });
        }
        this.stack.pop();
        top.end = this.pos;
        const bound = this._bound();
        if (this.pos > bound) {
          throw new BerError('ber_length_overrun', header.start,
            { declaredEnd: this.pos, containerEnd: bound });
        }
        this._close(top);
        continue;
      }
      const node = { ...header.identity, start: header.start, valueStart: header.headerEnd,
        children: header.identity.constructed ? [] : undefined };
      if (header.indefinite) {
        node.indefinite = true;
        node.end = null;
        this.stack.push(node);
        continue;
      }
      node.end = header.headerEnd + header.length;
      const bound = this._bound();
      if (node.end > bound) {
        throw new BerError('ber_length_overrun', node.start,
          { declaredEnd: node.end, containerEnd: bound });
      }
      if (node.children) {
        node.indefinite = false;
        this.stack.push(node);
      } else {
        this.filling = node;
      }
    }
  }

  _readHeader() {
    const start = this.pos;
    const initial = this._take();
    const tagClass = initial >> 6;
    const constructed = Boolean(initial & 0x20);
    let tag = initial & 0x1f;
    if (tag === 0x1f) {
      tag = 0;
      let count = 0;
      for (;;) {
        const octet = this._take();
        count++;
        if (count > MAX_TAG_OCTETS) throw new BerError('ber_tag_long', start);
        if (count === 1 && (octet & 0x7f) === 0) throw new BerError('ber_tag_padding', start);
        tag = tag * 128 + (octet & 0x7f);
        if (!(octet & 0x80)) break;
      }
    }
    const lengthAt = this.pos;
    const first = this._take();
    let indefinite = false;
    let length = 0;
    if (first === 0x80) indefinite = true;
    else if (first === 0xff) throw new BerError('ber_length_reserved', lengthAt);
    else if (first & 0x80) {
      const count = first & 0x7f;
      if (count > MAX_LENGTH_OCTETS) throw new BerError('ber_length_long', lengthAt, { count });
      for (let index = 0; index < count; index++) length = length * 256 + this._take();
    } else length = first;
    const headerEnd = this.pos;
    if (tagClass === 0 && tag === 0) {
      if (initial === 0x00 && !indefinite && length === 0) return { eoc: true, start, headerEnd };
      throw new BerError('ber_tag_zero', start);
    }
    if (indefinite && !constructed) {
      throw new BerError('ber_indefinite_primitive', start, { class: tagClass, tag });
    }
    return { eoc: false, start, headerEnd, indefinite, length,
      identity: { class: tagClass, constructed, tag } };
  }

  _closeBounded() {
    let closed = false;
    while (this.stack.length) {
      const top = this.stack[this.stack.length - 1];
      if (top.indefinite || this.pos < top.end) break;
      this.stack.pop();
      this._close(top);
      closed = true;
    }
    return closed;
  }

  _close(node) {
    if (this.stack.length) this.stack[this.stack.length - 1].children.push(node);
    else {
      this.records.push(node);
      this.recordStart = null;
    }
  }
}
