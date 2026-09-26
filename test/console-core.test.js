'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  parseHexBytes,
  formatAddress,
  resolveAddress,
  parseCommand,
  findRegistryEntries,
} = require('../node/console-core');

const registry = {
  addresses: [
    { component: 'RemoteControl', name: 'TIME_FORMAT', address: 0x2183, readable: true, writable: true },
    { component: 'DriveUnit', name: 'MAXIMUM_ASSISTANCE_SPEED', address: 0x1820, readable: true, writable: false },
    { component: 'Other', name: 'TIME_FORMAT', address: 0x1111, readable: true, writable: false },
  ],
};

test('parseHexBytes accepts spaced and 0x-prefixed bytes', () => {
  assert.equal(parseHexBytes('08 04').toString('hex'), '0804');
  assert.equal(parseHexBytes('0x08 0x04').toString('hex'), '0804');
  assert.equal(parseHexBytes('30:07:0e:10').toString('hex'), '30070e10');
});

test('parseHexBytes rejects incomplete or non-hex input', () => {
  assert.throws(() => parseHexBytes('0'), /complete bytes/);
  assert.throws(() => parseHexBytes('gg'), /complete bytes/);
});

test('resolveAddress handles numeric and qualified registry names', () => {
  assert.equal(resolveAddress('0x2183', registry).address, 0x2183);
  assert.equal(resolveAddress('8579', registry).address, 0x2183);
  assert.equal(resolveAddress('RemoteControl.TIME_FORMAT', registry).address, 0x2183);
});

test('resolveAddress requires qualification for ambiguous names', () => {
  assert.throws(() => resolveAddress('TIME_FORMAT', registry), /ambiguous/);
});

test('parseCommand keeps quoted payloads together', () => {
  assert.deepEqual(parseCommand('read RemoteControl.TIME_FORMAT'), {
    command: 'read',
    target: 'RemoteControl.TIME_FORMAT',
    args: ['RemoteControl.TIME_FORMAT'],
  });

  const rpc = parseCommand('rpc 0x1085 "08 04"');
  assert.equal(rpc.command, 'rpc');
  assert.equal(rpc.target, '0x1085');
  assert.equal(rpc.payloadText, '08 04');

  const raw = parseCommand('raw "30 07 0e 10 90 85 48 08 04"');
  assert.equal(raw.payloadText, '30 07 0e 10 90 85 48 08 04');
});

test('findRegistryEntries searches component/name/address text', () => {
  assert.equal(findRegistryEntries('maximum_assistance', registry).length, 1);
  assert.equal(findRegistryEntries('0x2183', registry)[0].name, 'TIME_FORMAT');
  assert.equal(formatAddress(0x1085), '0x1085');
});
