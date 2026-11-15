export function definiteTlv(bytes, start = 0) {
  let offset = start;
  if (offset + 2 > bytes.length) throw new Error('ber_header_short');
  const initial = bytes[offset++];
  if ((initial & 31) === 31) throw new Error('simple_ber_high_tag');
  let length = bytes[offset++];
  if (length & 128) {
    const count = length & 127;
    if (!count) throw new Error('simple_ber_indefinite');
    if (count > 4 || offset + count > bytes.length) throw new Error('ber_length_short');
    length = 0;
    for (let index = 0; index < count; index++) length = length * 256 + bytes[offset++];
  }
  const end = offset + length;
  if (end > bytes.length) throw new Error('ber_value_short');
  const node = { class: initial >> 6, constructed: Boolean(initial & 32), tag: initial & 31,
    start, valueStart: offset, end, raw: bytes.subarray(offset, end).toString('hex') };
  if (node.constructed) {
    node.children = [];
    while (offset < end) { const child = definiteTlv(bytes.subarray(0, end), offset); node.children.push(child); offset = child.end; }
  }
  return node;
}
export function inspect(bytes) {
  const root = definiteTlv(bytes);
  if (root.end !== bytes.length) throw new Error('simple_ber_trailing');
  return { kind: 'definite-ber-record', root };
}
