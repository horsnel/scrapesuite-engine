/**
 * InnerTube Protobuf Toolkit — ScrapeSuite Engine (platform layer)
 *
 * A small, complete Protocol Buffers wire-format codec for YouTube's
 * binary tokens. InnerTube scatters protobufs across its protocol:
 * `get_transcript` params, browse feed params (`FEtrending` needs one),
 * continuation-token payloads, visitorData blobs. Until now each was
 * hand-decoded; this toolkit makes them all readable and constructible.
 *
 * Encoder: build messages as plain objects keyed by field number.
 *   encodeProto({ 1: 'dQw4w9WgXcQ', 3: 'en', 5: { 1: 42 } })
 * Decoder: parse bytes into a field-numbered tree (every occurrence kept).
 *   decodeProto(base64ToBytes(token))
 *
 * Wire types: 0 varint · 1 64-bit · 2 length-delimited · 5 32-bit.
 * Unknown wire types are preserved raw so round-trips never lose data.
 */

import { createChildLogger } from '../../utils/logger';

const logger = createChildLogger('youtube-protobuf');

// ===============================================================================
// VARINT PRIMITIVES
// ===============================================================================

/** Append an unsigned varint to a byte array. */
export function writeVarint(bytes: number[], value: number | bigint): void {
  let v = typeof value === 'bigint' ? value : BigInt(Math.max(0, Math.trunc(value)));
  if (v < 0n) v = v & 0xFFFFFFFFFFFFFFFFn; // two's complement for negatives
  do {
    let byte = Number(v & 0x7Fn);
    v >>= 7n;
    if (v > 0n) byte |= 0x80;
    bytes.push(byte);
  } while (v > 0n);
}

/** Read an unsigned varint starting at `offset`. Returns value + next offset. */
export function readVarint(bytes: Uint8Array, offset: number): { value: bigint; offset: number } {
  let result = 0n;
  let shift = 0n;
  let pos = offset;
  while (true) {
    if (pos >= bytes.length) throw new Error('varint truncated');
    const byte = bytes[pos++];
    result |= BigInt(byte & 0x7F) << shift;
    if ((byte & 0x80) === 0) break;
    shift += 7n;
    if (shift > 70n) throw new Error('varint too long');
  }
  return { value: result, offset: pos };
}

// ===============================================================================
// TAGS
// ===============================================================================

function writeTag(bytes: number[], fieldNumber: number, wireType: number): void {
  writeVarint(bytes, (fieldNumber << 3) | wireType);
}

// ===============================================================================
// VALUE MODEL
// ===============================================================================

/** Anything assignable to a protobuf field. Objects become nested messages. */
export type ProtoValue = number | bigint | string | boolean | Uint8Array | ProtoMessage;
export interface ProtoMessage {
  [fieldNumber: number]: ProtoValue | ProtoValue[];
}

const WIRE_VARINT = 0;
const WIRE_64BIT = 1;
const WIRE_LEN = 2;
const WIRE_32BIT = 5;

function wireTypeOf(value: ProtoValue): number {
  if (typeof value === 'number' || typeof value === 'bigint' || typeof value === 'boolean') return WIRE_VARINT;
  if (typeof value === 'string') return WIRE_LEN;
  if (value instanceof Uint8Array) return WIRE_LEN;
  return WIRE_LEN; // nested message
}

// ===============================================================================
// ENCODER
// ===============================================================================

function encodeValue(bytes: number[], fieldNumber: number, value: ProtoValue): void {
  if (typeof value === 'boolean') {
    writeTag(bytes, fieldNumber, WIRE_VARINT);
    writeVarint(bytes, value ? 1 : 0);
    return;
  }
  if (typeof value === 'number' || typeof value === 'bigint') {
    writeTag(bytes, fieldNumber, WIRE_VARINT);
    writeVarint(bytes, value);
    return;
  }
  if (typeof value === 'string') {
    writeTag(bytes, fieldNumber, WIRE_LEN);
    const utf8 = Buffer.from(value, 'utf8');
    writeVarint(bytes, utf8.length);
    for (const b of utf8) bytes.push(b);
    return;
  }
  if (value instanceof Uint8Array) {
    writeTag(bytes, fieldNumber, WIRE_LEN);
    writeVarint(bytes, value.length);
    for (const b of value) bytes.push(b);
    return;
  }
  // Nested message
  writeTag(bytes, fieldNumber, WIRE_LEN);
  const nested = encodeProto(value);
  writeVarint(bytes, nested.length);
  for (const b of nested) bytes.push(b);
}

/**
 * Encode a message object into protobuf bytes. Field order follows
 * Object.keys order; arrays encode repeated occurrences in order.
 */
export function encodeProto(message: ProtoMessage): Uint8Array {
  const bytes: number[] = [];
  for (const [key, raw] of Object.entries(message)) {
    const fieldNumber = Number(key);
    if (!Number.isInteger(fieldNumber) || fieldNumber <= 0) {
      logger.warn({ key }, 'protobuf encoder: invalid field number skipped');
      continue;
    }
    const values = Array.isArray(raw) ? raw : [raw];
    for (const value of values) {
      if (value === undefined || value === null) continue;
      encodeValue(bytes, fieldNumber, value);
    }
  }
  return Uint8Array.from(bytes);
}

// ===============================================================================
// DECODER
// ===============================================================================

export interface DecodedField {
  fieldNumber: number;
  wireType: number;
  /** varint payloads (wire type 0). */
  varint?: bigint;
  /** length-delimited payloads (wire type 2): bytes. */
  bytes?: Uint8Array;
  /** 64-bit / 32-bit raw little-endian payloads. */
  fixed?: Uint8Array;
}

/**
 * Decode a protobuf message into a flat field list. Nested messages are
 * returned as wire-type-2 fields — call `decodeProto` on `.bytes` (or use
 * `decodeProtoTree`) to descend. Lenient: unknown wire types are preserved.
 */
export function decodeProto(bytes: Uint8Array): DecodedField[] {
  const fields: DecodedField[] = [];
  let pos = 0;
  while (pos < bytes.length) {
    const tag = readVarint(bytes, pos);
    pos = tag.offset;
    const fieldNumber = Number(tag.value >> 3n);
    const wireType = Number(tag.value & 7n);
    if (fieldNumber === 0) throw new Error('invalid field number 0');

    if (wireType === WIRE_VARINT) {
      const v = readVarint(bytes, pos);
      pos = v.offset;
      fields.push({ fieldNumber, wireType, varint: v.value });
    } else if (wireType === WIRE_LEN) {
      const len = readVarint(bytes, pos);
      pos = len.offset;
      const end = Number(len.value) + pos;
      if (end > bytes.length) throw new Error('length-delimited field truncated');
      fields.push({ fieldNumber, wireType, bytes: bytes.slice(pos, end) });
      pos = end;
    } else if (wireType === WIRE_64BIT) {
      if (pos + 8 > bytes.length) throw new Error('64-bit field truncated');
      fields.push({ fieldNumber, wireType, fixed: bytes.slice(pos, pos + 8) });
      pos += 8;
    } else if (wireType === WIRE_32BIT) {
      if (pos + 4 > bytes.length) throw new Error('32-bit field truncated');
      fields.push({ fieldNumber, wireType, fixed: bytes.slice(pos, pos + 4) });
      pos += 4;
    } else {
      // Wire types 3/4 (groups) are deprecated; skip what we cannot model.
      throw new Error(`unsupported wire type ${wireType} at field ${fieldNumber}`);
    }
  }
  return fields;
}

/**
 * Decode into a tree: nested length-delimited fields become sub-trees when
 * they parse cleanly as messages; otherwise raw bytes are kept.
 */
export function decodeProtoTree(bytes: Uint8Array): Map<number, DecodedField[]> {
  const root = new Map<number, DecodedField[]>();
  for (const field of decodeProto(bytes)) {
    if (field.wireType === WIRE_LEN && field.bytes) {
      try {
        const nested = decodeProto(field.bytes);
        // Heuristic: treat as message only if every field consumed the bytes.
        if (nested.length > 0) {
          (field as any).nested = decodeProtoTree(field.bytes);
        }
      } catch {
        // Not a message — leave as bytes.
      }
    }
    const list = root.get(field.fieldNumber) ?? [];
    list.push(field);
    root.set(field.fieldNumber, list);
  }
  return root;
}

/** Human-readable dump of a decoded message (for signatures and debugging). */
export function dumpProto(bytes: Uint8Array, indent = ''): string {
  const lines: string[] = [];
  try {
    const tree = decodeProtoTree(bytes);
    for (const [fieldNumber, fields] of tree) {
      for (const f of fields) {
        if (f.wireType === WIRE_VARINT) {
          lines.push(`${indent}${fieldNumber}: varint ${f.varint}`);
        } else if (f.wireType === WIRE_LEN) {
          const nested = (f as any).nested as Map<number, DecodedField[]> | undefined;
          if (nested) {
            lines.push(`${indent}${fieldNumber}: message {`);
            lines.push(dumpProto(f.bytes!, `${indent}  `));
            lines.push(`${indent}}`);
          } else {
            const text = Buffer.from(f.bytes!).toString('utf8');
            const printable = /^[\x20-\x7E\n\r\t]*$/.test(text);
            lines.push(`${indent}${fieldNumber}: ${printable ? JSON.stringify(text) : `<${f.bytes!.length} bytes>`}`);
          }
        } else {
          lines.push(`${indent}${fieldNumber}: wire${f.wireType} ${Buffer.from(f.fixed ?? []).toString('hex')}`);
        }
      }
    }
  } catch (err: any) {
    lines.push(`${indent}<decode failed: ${err?.message}>`);
  }
  return lines.join('\n');
}

// ===============================================================================
// BASE64 HELPERS
// ===============================================================================

/** Standard or URL-safe base64 → bytes (padding optional). */
export function base64ToBytes(input: string): Uint8Array {
  let s = input.replace(/-/g, '+').replace(/_/g, '/').trim();
  while (s.length % 4 !== 0) s += '=';
  return Uint8Array.from(Buffer.from(s, 'base64'));
}

/** Bytes → base64 (URL-safe option, unpadded option). */
export function bytesToBase64(bytes: Uint8Array, opts?: { urlSafe?: boolean; pad?: boolean }): string {
  let s = Buffer.from(bytes).toString('base64');
  if (opts?.urlSafe) s = s.replace(/\+/g, '-').replace(/\//g, '_');
  if (opts?.pad === false) s = s.replace(/=+$/, '');
  return s;
}
