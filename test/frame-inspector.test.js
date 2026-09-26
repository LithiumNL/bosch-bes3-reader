'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { inspectFrame } = require('../src/frame-inspector');

test('wire 0x9085 decodes to logical 0x1085 and 0x48 is RPC seq 8', () => {
  const frame = Buffer.from('30 07 0e 10 90 85 48 08 04', 'hex');
  const r = inspectFrame(frame, 'host->bike');

  assert.equal(r.ok, true);
  assert.equal(r.destination.wire, '0x9085');
  assert.equal(r.destination.logical_hex, '0x1085');
  assert.equal(r.type_name, 'RPC');
  assert.equal(r.sequence, 8);
  assert.equal(r.payload_hex, '08 04');
});

test('implicit-success response preserves source logical address', () => {
  const frame = Buffer.from('30 05 10 85 8e 10 50', 'hex');
  const r = inspectFrame(frame, 'bike->host');

  assert.equal(r.ok, true);
  assert.equal(r.source.logical_hex, '0x1085');
  assert.equal(r.destination.logical_hex, '0x0e10');
  assert.equal(r.type_name, 'RPC_RESPONSE');
  assert.equal(r.sequence, 0);
  assert.equal(r.status_name, 'SUCCESS');
  assert.equal(r.implicit_success, true);
});
