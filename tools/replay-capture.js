#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const { inspectFrame } = require('../src/frame-inspector');
const { ADDRESS_REGISTRY } = require('../src/address-registry.generated');

function usage() {
  console.error('Usage: node tools/replay-capture.js <capture-dir|events.jsonl> [--json]');
  process.exit(2);
}

function findEntry(addr) {
  return ADDRESS_REGISTRY.addresses.find((e) => e.address === addr) || null;
}

function hexToBytes(hex) {
  return Buffer.from((hex || '').replace(/\s+/g, ''), 'hex');
}

const args = process.argv.slice(2);
const jsonMode = args.includes('--json');
const target = args.find((a) => !a.startsWith('--'));
if (!target) usage();

const eventsPath = fs.statSync(target).isDirectory()
  ? path.join(target, 'events.jsonl')
  : target;

const lines = fs.readFileSync(eventsPath, 'utf8').split(/\r?\n/).filter(Boolean);
let count = 0;

for (const line of lines) {
  let event;
  try {
    event = JSON.parse(line);
  } catch (_) {
    continue;
  }

  if (event.layer !== 'mcsp' || event.event !== 'frame' || !event.raw_hex) continue;

  const decoded = inspectFrame(
    hexToBytes(event.raw_hex),
    event.direction === 'host->bike' ? 'host->bike' : 'bike->host'
  );

  const logicalAddress = decoded.ok
    ? (decoded.direction === 'host->bike' ? decoded.destination?.logical : decoded.source?.logical)
    : null;
  const entry = logicalAddress == null ? null : findEntry(logicalAddress);

  const row = {
    index: event.index,
    ts_utc: event.ts_utc,
    t_us: event.t_us,
    direction: event.direction,
    frame: decoded,
    registry: entry ? {
      component: entry.component,
      name: entry.name,
      address: '0x' + entry.address.toString(16).padStart(4, '0'),
    } : null,
  };

  if (jsonMode) {
    console.log(JSON.stringify(row));
  } else {
    const t = event.t_us == null ? '?' : (event.t_us / 1000).toFixed(3);
    const arrow = event.direction === 'host->bike' ? 'TX' : 'RX';
    const type = decoded.type_name || decoded.error || 'UNKNOWN';
    const addr = logicalAddress == null ? '----' : '0x' + logicalAddress.toString(16).padStart(4, '0');
    const name = entry ? entry.component + '.' + entry.name : '(unknown)';
    const seq = decoded.sequence == null ? '' : ' seq=' + decoded.sequence;
    const status = decoded.status_name ? ' ' + decoded.status_name : '';
    console.log(t.padStart(10) + ' ms  ' + arrow + '  ' + type.padEnd(20) + ' ' + addr + '  ' + name + seq + status);
  }

  count++;
}

if (!jsonMode) console.log('\nReplayed ' + count + ' MCSP frames from ' + eventsPath);
