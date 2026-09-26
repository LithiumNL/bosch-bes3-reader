#!/usr/bin/env node
'use strict';

const { inspectFrame } = require('../src/frame-inspector');
const { ADDRESS_REGISTRY } = require('../src/address-registry.generated');

function usage() {
  console.error('Usage: node tools/explain-frame.js [--direction=tx|rx|auto] "30 07 0e 10 90 85 48 08 04"');
  process.exit(2);
}

function parseHex(text) {
  const cleaned = text.replace(/0x/gi, '').replace(/[^0-9a-f]/gi, '');
  if (!cleaned || cleaned.length % 2 !== 0) throw new Error('Hex input must contain complete bytes');
  return Buffer.from(cleaned, 'hex');
}

function findEntry(addr) {
  return ADDRESS_REGISTRY.addresses.find((e) => e.address === addr) || null;
}

const args = process.argv.slice(2);
let direction = 'auto';
const dataParts = [];

for (const arg of args) {
  if (arg.startsWith('--direction=')) {
    const v = arg.split('=', 2)[1];
    direction = v === 'tx' ? 'host->bike' : v === 'rx' ? 'bike->host' : v;
  } else {
    dataParts.push(arg);
  }
}

if (!dataParts.length) usage();

let decoded;
try {
  decoded = inspectFrame(parseHex(dataParts.join(' ')), direction);
} catch (err) {
  console.error(err.message);
  process.exit(2);
}

const logicalAddress = decoded.ok
  ? (decoded.direction === 'host->bike' ? decoded.destination?.logical : decoded.source?.logical)
  : null;
const entry = logicalAddress == null ? null : findEntry(logicalAddress);

console.log('MCSP / MessageBus frame');
console.log('  direction:      ' + decoded.direction);
console.log('  raw:            ' + decoded.raw_hex);

if (!decoded.ok) {
  console.log('  error:          ' + decoded.error);
  process.exit(1);
}

if (decoded.source) {
  console.log('  source wire:    ' + decoded.source.wire);
  console.log('  source logical: ' + decoded.source.logical_hex);
}
if (decoded.destination) {
  console.log('  dest wire:      ' + decoded.destination.wire);
  console.log('  dest logical:   ' + decoded.destination.logical_hex);
}
console.log('  type:           ' + decoded.type_name);
if (decoded.sequence != null) console.log('  sequence:       ' + decoded.sequence);
if (decoded.status_name) console.log('  status:         ' + decoded.status_name);
console.log('  payload:        ' + (decoded.payload_hex || '(empty)'));

if (entry) {
  console.log('  registry:       ' + entry.component + '.' + entry.name);
}
