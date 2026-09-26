// Structural BES3 MCSP / MessageBus frame inspector.
// Keeps raw wire addresses separate from 15-bit logical addresses.

'use strict';

(function () {
  const MESSAGE_TYPE_NAMES = {
    0: 'READ',
    1: 'READ_RESPONSE',
    2: 'WRITE',
    3: 'WRITE_RESPONSE',
    4: 'RPC',
    5: 'RPC_RESPONSE',
    6: 'SUBSCRIBE',
    7: 'SUBSCRIBE_RESPONSE',
    8: 'UNSUBSCRIBE',
    9: 'UNSUBSCRIBE_RESPONSE',
  };

  const STATUS_NAMES = {
    0: 'SUCCESS',
    1: 'OVERLOADED',
    2: 'NO_ROUTE_FOUND',
    3: 'NOT_READY',
    4: 'UNSUPPORTED',
    6: 'DENIED',
    7: 'INVALID_VALUE',
    8: 'MALFORMED',
    9: 'TIMEOUT',
    10: 'TOO_LARGE',
  };

  function toHex(bytes) {
    return Array.from(bytes || [], (b) => b.toString(16).padStart(2, '0')).join(' ');
  }

  function hex16(n) {
    return '0x' + Number(n).toString(16).padStart(4, '0');
  }

  function normalizeBytes(input) {
    if (input instanceof Uint8Array) return input;
    if (Array.isArray(input)) return Uint8Array.from(input);
    if (typeof Buffer !== 'undefined' && Buffer.isBuffer(input)) return Uint8Array.from(input);
    throw new TypeError('Expected Buffer, Uint8Array, or byte array');
  }

  function decodeAddress(raw) {
    return {
      raw,
      wire: hex16(raw),
      logical: raw & 0x7fff,
      logical_hex: hex16(raw & 0x7fff),
      msb_flag: !!(raw & 0x8000),
    };
  }

  function inspectFrame(input, direction = 'auto') {
    const bytes = normalizeBytes(input);

    if (bytes.length < 2 || bytes[0] !== 0x30) {
      return { ok: false, error: 'not-mcsp-block', raw_hex: toHex(bytes) };
    }

    const declaredLength = bytes[1];
    const available = Math.max(0, bytes.length - 2);
    const bodyLength = Math.min(declaredLength, available);
    const body = bytes.slice(2, 2 + bodyLength);
    const extra = bytes.slice(2 + bodyLength);

    if (direction === 'auto') {
      direction = body.length >= 2 && body[0] === 0x0e && body[1] === 0x10
        ? 'host->bike'
        : 'bike->host';
    }

    const common = {
      ok: true,
      op: '0x30',
      direction,
      declared_length: declaredLength,
      available_body_length: available,
      truncated: available < declaredLength,
      raw_hex: toHex(bytes),
      body_hex: toHex(body),
      extra_hex: toHex(extra),
    };

    if (direction === 'host->bike') {
      if (body.length < 5) return { ...common, ok: false, error: 'request-body-too-short' };

      const sourceRaw = (body[0] << 8) | body[1];
      const destinationRaw = (body[2] << 8) | body[3];
      const typeSeq = body[4];
      const type = (typeSeq >> 4) & 0x0f;

      return {
        ...common,
        kind: 'request',
        source: decodeAddress(sourceRaw),
        destination: decodeAddress(destinationRaw),
        type,
        type_name: MESSAGE_TYPE_NAMES[type] || 'UNKNOWN(' + type + ')',
        sequence: typeSeq & 0x0f,
        type_sequence_byte: '0x' + typeSeq.toString(16).padStart(2, '0'),
        payload_hex: toHex(body.slice(5)),
      };
    }

    if (body.length >= 2 && (body[0] & 0x80)) {
      const sourceRaw = (body[0] << 8) | body[1];
      return {
        ...common,
        kind: 'notify',
        source: decodeAddress(sourceRaw),
        destination: null,
        type: null,
        type_name: 'NOTIFY',
        sequence: null,
        status: null,
        payload_hex: toHex(body.slice(2)),
      };
    }

    if (body.length < 5) return { ...common, ok: false, error: 'response-body-too-short' };

    const sourceRaw = (body[0] << 8) | body[1];
    const destinationRaw = (body[2] << 8) | body[3];
    const typeSeq = body[4];
    const type = (typeSeq >> 4) & 0x0f;
    const implicitSuccess = !!(destinationRaw & 0x8000);

    let payloadOffset = 5;
    let status = 0;

    if (!implicitSuccess) {
      if (body.length < 6) return { ...common, ok: false, error: 'response-status-missing' };
      status = body[5];
      payloadOffset = 6;
    }

    return {
      ...common,
      kind: 'response',
      source: decodeAddress(sourceRaw),
      destination: decodeAddress(destinationRaw),
      type,
      type_name: MESSAGE_TYPE_NAMES[type] || 'UNKNOWN(' + type + ')',
      sequence: typeSeq & 0x0f,
      type_sequence_byte: '0x' + typeSeq.toString(16).padStart(2, '0'),
      status,
      status_name: STATUS_NAMES[status] || 'UNKNOWN_ERROR(' + status + ')',
      implicit_success: implicitSuccess,
      payload_hex: toHex(body.slice(payloadOffset)),
    };
  }

  const api = { MESSAGE_TYPE_NAMES, STATUS_NAMES, inspectFrame, toHex };

  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else if (typeof window !== 'undefined') window.Bes3FrameInspector = api;
})();
