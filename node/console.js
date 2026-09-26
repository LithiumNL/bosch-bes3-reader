#!/usr/bin/env node
'use strict';

const readline = require('readline');
const path = require('path');

const {
  MessageType,
  buildReadRequestFrame,
  buildWriteFrame,
  buildRpcCallFrame,
  buildRpcCallFrameWithArg,
  parseReadResponseFrame,
  parseNotifyMessage,
  decodeValue,
  toHex,
} = require('../src/protocol');
const { decodeTyped } = require('../src/messageTypes');
const { ADDRESS_REGISTRY } = require('../src/address-registry.generated');
const { inspectFrame } = require('../src/frame-inspector');
const { Bes3UsbTransport, findDevice } = require('./transport-node-usb');
const { UsbCaptureSession, defaultCaptureDirectory } = require('./usb-capture');
const {
  parseHexBytes,
  formatAddress,
  resolveAddress,
  parseCommand,
  findRegistryEntries,
  createCompleter,
} = require('./console-core');

const KEEP_ALIVE_ADDR = 0x2106;
const KEEP_ALIVE_INTERVAL_MS = 800;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function argValue(name) {
  const prefix = '--' + name + '=';
  const hit = process.argv.find((a) => a.startsWith(prefix));
  return hit ? hit.slice(prefix.length) : null;
}

const ACTIVE = process.argv.includes('--active');
const OFFLINE = process.argv.includes('--offline');
const captureArg = argValue('capture');
const CAPTURE_DIR = captureArg
  ? path.resolve(captureArg)
  : defaultCaptureDirectory(path.resolve(__dirname, '..', 'local-captures'));

let running = true;
let transport = null;
let capture = null;
let seqCounter = 0;
let keepAliveTimer = null;
let keepAlivePending = false;
let rxPromise = null;
let usbQueue = Promise.resolve();
const waiters = [];

function nextSeq() {
  seqCounter = (seqCounter + 1) & 0x0f;
  return seqCounter;
}

function withUsb(fn) {
  const run = usbQueue.then(fn, fn);
  usbQueue = run.catch(() => {});
  return run;
}

function labelFor(addr) {
  const entry = ADDRESS_REGISTRY.addresses.find((e) => e.address === addr);
  return entry ? entry.component + '.' + entry.name : formatAddress(addr);
}

function makeWaiter(predicate, timeoutMs, quiet = false) {
  let resolvePromise;
  let settled = false;
  const promise = new Promise((resolve) => {
    resolvePromise = resolve;
  });

  const waiter = {
    predicate,
    quiet,
    resolve(value) {
      if (settled) return;
      settled = true;
      clearTimeout(waiter.timer);
      resolvePromise(value);
    },
    timer: null,
  };

  waiter.timer = setTimeout(() => {
    const i = waiters.indexOf(waiter);
    if (i >= 0) waiters.splice(i, 1);
    waiter.resolve(null);
  }, timeoutMs);

  waiters.push(waiter);

  return {
    promise,
    cancel() {
      const i = waiters.indexOf(waiter);
      if (i >= 0) waiters.splice(i, 1);
      waiter.resolve(null);
    },
  };
}

function dispatchWaiter(parsed) {
  for (let i = 0; i < waiters.length; i++) {
    const waiter = waiters[i];
    let matches = false;
    try {
      matches = waiter.predicate(parsed);
    } catch (_) {}
    if (!matches) continue;
    waiters.splice(i, 1);
    waiter.resolve(parsed);
    return waiter.quiet;
  }
  return false;
}

function printIncoming(raw) {
  const parsed = parseReadResponseFrame(raw);
  if (parsed) {
    const addr = (parsed.addrHigh << 8) | parsed.addrLow;
    const quiet = dispatchWaiter(parsed);
    if (quiet) return;

    const payload = parsed.payload && parsed.payload.length ? ' payload=' + toHex(parsed.payload) : '';
    console.log(
      '\nRX ' +
      (Object.entries(MessageType).find(([, value]) => value === parsed.type)?.[0] || ('TYPE_' + parsed.type)) +
      ' ' + labelFor(addr) +
      ' seq=' + parsed.seq +
      ' ' + parsed.statusName +
      payload
    );
    return;
  }

  const notify = parseNotifyMessage(raw);
  if (notify) {
    console.log(
      '\nRX NOTIFY ' + labelFor(notify.addr) +
      (notify.payload.length ? ' payload=' + toHex(notify.payload) : '')
    );
    return;
  }

  const inspected = inspectFrame(raw, 'bike->host');
  if (inspected && inspected.ok) {
    console.log('\nRX ' + (inspected.type_name || inspected.kind || 'FRAME') + ' raw=' + toHex(raw));
  } else {
    console.log('\nRX RAW ' + toHex(raw));
  }
}

async function rxPump() {
  while (running) {
    try {
      const raw = await withUsb(() => transport.readNextFrame(2, 5));
      if (raw) printIncoming(raw);
      else await sleep(8);
    } catch (err) {
      if (!running) break;
      console.error('\nRX error:', err.message);
      await sleep(100);
    }
  }
}

async function sendFrame(frame, options = {}) {
  if (!options.quiet) console.log('TX ' + (options.description || 'RAW') + ' raw=' + toHex(frame));
  await withUsb(() => transport.doMcspWrite(frame));
}

async function requestResponse(addr, frame, expectedType, seq, options = {}) {
  const waiter = makeWaiter(
    (parsed) =>
      ((parsed.addrHigh << 8) | parsed.addrLow) === addr &&
      parsed.type === expectedType &&
      parsed.seq === seq,
    options.timeoutMs || 1200,
    !!options.quiet
  );

  try {
    await sendFrame(frame, options);
  } catch (err) {
    waiter.cancel();
    throw err;
  }

  return waiter.promise;
}

function showDecoded(addr, parsed) {
  if (!parsed) {
    console.log('=> timeout');
    return;
  }
  if (!parsed.ok) {
    console.log('=> ' + parsed.statusName);
    return;
  }

  let decoded = null;
  try {
    decoded = decodeTyped(addr, parsed.payload) || decodeValue(parsed.payload);
  } catch (_) {
    decoded = decodeValue(parsed.payload);
  }

  const shown = decoded && decoded.display != null
    ? decoded.display
    : (parsed.payload.length ? toHex(parsed.payload) : '(empty)');
  console.log('=> ' + shown);
}

function requireOnline(command) {
  if (!OFFLINE) return;
  throw new Error(
    command.toUpperCase() +
    ' is unavailable in offline mode. Restart without "--offline" and connect a powered-on bike.'
  );
}

function requireActive(command) {
  if (ACTIVE) return;
  throw new Error(
    command.toUpperCase() +
    ' is disabled in safe mode. Restart with "npm run console -- --active" to enable RPC/WRITE/RAW sending.'
  );
}

function recordConsoleCommand(cmd, extra = {}) {
  if (!capture) return;
  capture.record({
    layer: 'console',
    event: 'command',
    direction: 'local',
    command: cmd.command,
    ...extra,
  });
}

async function doRead(cmd) {
  requireOnline('read');
  const { address, entry } = resolveAddress(cmd.target, ADDRESS_REGISTRY);
  const seq = nextSeq();
  const frame = buildReadRequestFrame(address, seq);
  recordConsoleCommand(cmd, {
    address: formatAddress(address),
    name: entry ? entry.component + '.' + entry.name : null,
  });

  const parsed = await requestResponse(address, frame, MessageType.READ_RESPONSE, seq, {
    description: 'READ ' + labelFor(address) + ' seq=' + seq,
  });
  showDecoded(address, parsed);
}

async function doWrite(cmd) {
  requireOnline('write');
  requireActive('write');
  const { address, entry } = resolveAddress(cmd.target, ADDRESS_REGISTRY);
  const payload = parseHexBytes(cmd.payloadText);
  const seq = nextSeq();
  const frame = buildWriteFrame(address, seq, payload);
  recordConsoleCommand(cmd, {
    address: formatAddress(address),
    name: entry ? entry.component + '.' + entry.name : null,
    payload_hex: toHex(payload),
  });

  const parsed = await requestResponse(address, frame, MessageType.WRITE_RESPONSE, seq, {
    description: 'WRITE ' + labelFor(address) + ' seq=' + seq,
  });
  showDecoded(address, parsed);
}

async function doRpc(cmd) {
  requireOnline('rpc');
  requireActive('rpc');
  const { address, entry } = resolveAddress(cmd.target, ADDRESS_REGISTRY);
  const payload = parseHexBytes(cmd.payloadText || '');
  const seq = nextSeq();
  const frame = payload.length
    ? buildRpcCallFrameWithArg(address, seq, payload)
    : buildRpcCallFrame(address, seq);

  recordConsoleCommand(cmd, {
    address: formatAddress(address),
    name: entry ? entry.component + '.' + entry.name : null,
    payload_hex: toHex(payload),
  });

  const parsed = await requestResponse(address, frame, MessageType.RPC_RESPONSE, seq, {
    description: 'RPC ' + labelFor(address) + ' seq=' + seq,
  });
  showDecoded(address, parsed);
}

async function doRaw(cmd) {
  requireOnline('raw');
  requireActive('raw');
  const frame = parseHexBytes(cmd.payloadText);
  if (!frame.length) throw new Error('RAW frame is empty.');

  recordConsoleCommand(cmd, { raw_hex: toHex(frame) });
  await sendFrame(frame, { description: 'RAW' });
  console.log('=> sent; incoming frames continue to be captured by the RX pump');
}

function showFind(cmd) {
  const hits = findRegistryEntries(cmd.query, ADDRESS_REGISTRY, 20);
  if (!hits.length) {
    console.log('No registry matches.');
    return;
  }
  for (const e of hits) {
    const flags = [
      e.readable === true ? 'R' : '-',
      e.writable === true ? 'W' : '-',
    ].join('');
    console.log(
      formatAddress(e.address) + '  ' + flags.padEnd(3) + ' ' + e.component + '.' + e.name
    );
  }
}

function showHelp() {
  console.log(`
Commands:
  read <addr|Component.NAME>              Read a datapoint
  find <text>                             Search the address registry
  listen [seconds]                        Leave RX capture running without sending
  capture                                 Show capture path and mode
  rpc <addr|Component.NAME> [arg hex]     Send an RPC (--active required)
  write <addr|Component.NAME> <hex>       Send a WRITE (--active required)
  raw <complete frame hex>                Send exact MCSP bytes (--active required)
  help                                    Show this help
  quit                                    Close capture and USB session

TAB completion:
  re<TAB>                                  Completes command names
  read Rem<TAB>                            Completes components/datapoints
  write Rem<TAB>                           Shows writable targets only
  find speed<TAB>                          Suggests matching names/components

Examples:
  read 0x2183
  read RemoteControl.TIME_FORMAT
  find maximum_assistance
  rpc 0x1085 "08 04"
  write 0x2183 "08 01"
  raw "30 07 0e 10 90 85 48 08 04"

Online captures are lossless and remain the source of truth. Safe mode permits
READ plus passive RX capture. --active is intentionally required for commands
that may change state; arbitrary RPCs can be mutating too.

Offline UI test mode:
  npm run console -- --offline             Registry/help/TAB completion, no USB
`.trim());
}

async function handleCommand(line) {
  const cmd = parseCommand(line);
  if (cmd.command === 'empty') return;
  if (cmd.command === 'help') return showHelp();
  if (cmd.command === 'quit') {
    running = false;
    return;
  }
  if (cmd.command === 'read') return doRead(cmd);
  if (cmd.command === 'write') return doWrite(cmd);
  if (cmd.command === 'rpc') return doRpc(cmd);
  if (cmd.command === 'raw') return doRaw(cmd);
  if (cmd.command === 'find') return showFind(cmd);
  if (cmd.command === 'status') {
    console.log('Capture: ' + (OFFLINE ? 'disabled (offline mode)' : CAPTURE_DIR));
    console.log(
      'Mode: ' +
      (OFFLINE ? 'OFFLINE (registry/help/TAB only)' :
        ACTIVE ? 'ACTIVE (RPC/WRITE/RAW enabled)' : 'safe/read-only')
    );
    return;
  }
  if (cmd.command === 'listen') {
    requireOnline('listen');
    if (!Number.isFinite(cmd.seconds) || cmd.seconds <= 0 || cmd.seconds > 3600) {
      throw new Error('listen seconds must be > 0 and <= 3600.');
    }
    console.log('Listening for ' + cmd.seconds + 's...');
    await sleep(cmd.seconds * 1000);
  }
}

function startKeepAlive() {
  keepAliveTimer = setInterval(() => {
    if (!running || keepAlivePending) return;
    keepAlivePending = true;

    (async () => {
      const seq = nextSeq();
      const frame = buildRpcCallFrame(KEEP_ALIVE_ADDR, seq);
      await requestResponse(
        KEEP_ALIVE_ADDR,
        frame,
        MessageType.RPC_RESPONSE,
        seq,
        { quiet: true, timeoutMs: 700, description: 'KEEPALIVE' }
      );
    })()
      .catch(() => {})
      .finally(() => {
        keepAlivePending = false;
      });
  }, KEEP_ALIVE_INTERVAL_MS);
}

async function shutdown() {
  running = false;
  if (keepAliveTimer) clearInterval(keepAliveTimer);

  for (const waiter of waiters.splice(0)) waiter.resolve(null);

  try {
    if (rxPromise) await rxPromise;
  } catch (_) {}

  if (transport) {
    try {
      await withUsb(async () => transport.close());
    } catch (_) {}
  }
  if (capture) {
    capture.close({ status: 'completed', console_mode: ACTIVE ? 'active' : 'safe' });
  }
}

async function main() {
  if (!OFFLINE) {
    const device = findDevice();
    if (!device) {
      throw new Error('No Bosch Smart System USB device found. Connect USB-C and power the bike on, or use --offline to test the console UI.');
    }

    capture = new UsbCaptureSession(CAPTURE_DIR, {
      tool: 'node/console.js',
      mode: ACTIVE ? 'interactive-active' : 'interactive-safe',
    });

    transport = new Bes3UsbTransport(device, { capture });
    await transport.open();
  }

  console.log('BES3 research console');
  console.log('Capture: ' + (OFFLINE ? 'disabled (offline mode)' : CAPTURE_DIR));
  console.log(
    'Mode: ' +
    (OFFLINE ? 'OFFLINE — registry/help/TAB completion only' :
      ACTIVE ? 'ACTIVE — RPC/WRITE/RAW enabled' : 'safe/read-only')
  );
  if (OFFLINE && ACTIVE) {
    console.log('Note: --active has no effect while --offline is enabled.');
  }
  console.log('Type "help" for commands. Press TAB for context-aware suggestions.');

  if (!OFFLINE) {
    rxPromise = rxPump();
    startKeepAlive();
  }

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    terminal: true,
    prompt: 'bes3> ',
    completer: createCompleter(ADDRESS_REGISTRY),
  });

  const stop = () => {
    running = false;
    rl.close();
  };
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);

  rl.prompt();
  for await (const line of rl) {
    try {
      await handleCommand(line);
    } catch (err) {
      console.error('Error: ' + err.message);
    }
    if (!running) break;
    rl.prompt();
  }

  await shutdown();
  console.log(OFFLINE ? 'Offline console closed.' : 'Capture closed: ' + CAPTURE_DIR);
}

main().catch(async (err) => {
  console.error('Fatal error:', err.message);
  try {
    await shutdown();
  } catch (_) {}
  process.exitCode = 1;
});
