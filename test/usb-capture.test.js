'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { UsbCaptureSession } = require('../node/usb-capture');

test('capture writer stores JSONL events and session summary', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bes3-cap-'));
  const cap = new UsbCaptureSession(dir, { test: true });

  cap.record({
    layer: 'mcsp',
    event: 'frame',
    direction: 'host->bike',
    raw_hex: '30 07 0e 10 90 85 48 08 04',
  });
  cap.close({ status: 'completed' });

  const lines = fs.readFileSync(path.join(dir, 'events.jsonl'), 'utf8').trim().split('\n');
  assert.equal(lines.length, 1);

  const event = JSON.parse(lines[0]);
  assert.equal(event.raw_hex, '30 07 0e 10 90 85 48 08 04');
  assert.equal(typeof event.t_us, 'number');

  const session = JSON.parse(fs.readFileSync(path.join(dir, 'session.json'), 'utf8'));
  assert.equal(session.event_count, 1);
  assert.equal(session.status, 'completed');
  assert.ok(session.ended_at);
});
