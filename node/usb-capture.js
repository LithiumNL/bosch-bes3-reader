// Lossless local capture writer for Bosch BES3 USB research.
//
// Captures are local-only by design. Raw protocol data can contain bike-specific
// identifiers, serials, certificates, or other private data.
//
// Files:
//   session.json  metadata and final counters
//   events.jsonl  one lossless event per line, with UTC + monotonic timestamps
//
// Raw bytes are stored as hexadecimal strings. Decoded views are derived later.

'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

function timestampForPath(date = new Date()) {
  return date.toISOString().replace(/[:.]/g, '-');
}

function defaultCaptureDirectory(baseDir) {
  return path.join(baseDir, timestampForPath());
}

function toHex(data) {
  if (data == null) return null;
  return Buffer.from(data).toString('hex').match(/.{1,2}/g)?.join(' ') || '';
}

class UsbCaptureSession {
  constructor(directory, metadata = {}) {
    this.directory = path.resolve(directory);
    this.eventsPath = path.join(this.directory, 'events.jsonl');
    this.sessionPath = path.join(this.directory, 'session.json');
    this.startedMono = process.hrtime.bigint();
    this.eventIndex = 0;
    this.closed = false;
    this.counts = {};

    fs.mkdirSync(this.directory, { recursive: true });

    this.session = {
      format: 'bosch-bes3-usb-capture',
      format_version: 1,
      session_id: typeof crypto.randomUUID === 'function'
        ? crypto.randomUUID()
        : crypto.randomBytes(16).toString('hex'),
      started_at: new Date().toISOString(),
      ended_at: null,
      node_version: process.version,
      platform: process.platform,
      arch: process.arch,
      metadata,
      event_count: 0,
      counts: {},
    };

    this._writeSession();
  }

  _writeSession() {
    fs.writeFileSync(this.sessionPath, JSON.stringify(this.session, null, 2) + '\n');
  }

  record(event) {
    if (this.closed) return;

    const nowMono = process.hrtime.bigint();
    const layer = event.layer || 'unknown';
    const direction = event.direction || 'unknown';
    const key = layer + ':' + direction;
    this.counts[key] = (this.counts[key] || 0) + 1;

    const row = {
      v: 1,
      index: this.eventIndex++,
      ts_utc: new Date().toISOString(),
      t_us: Number((nowMono - this.startedMono) / 1000n),
      ...event,
    };

    fs.appendFileSync(this.eventsPath, JSON.stringify(row) + '\n');
  }

  close(extra = {}) {
    if (this.closed) return;
    this.closed = true;
    this.session.ended_at = new Date().toISOString();
    this.session.event_count = this.eventIndex;
    this.session.counts = { ...this.counts };
    Object.assign(this.session, extra);
    this._writeSession();
  }
}

module.exports = {
  UsbCaptureSession,
  defaultCaptureDirectory,
  timestampForPath,
  toHex,
};
