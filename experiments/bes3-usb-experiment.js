#!/usr/bin/env node
'use strict';

/**
 * Bosch BES3 USB experiment
 *
 * Purpose:
 *  - connect to a Bosch Smart System over USB using LithiumNL/bosch-bes3-reader
 *  - log important speed/tuning/container state
 *  - log active issue lists
 *  - prove a benign WRITE works by toggling RemoteControl.TIME_FORMAT (0x2183)
 *  - power-cycle and check persistence
 *  - optionally probe raw/wire 0x9085 as logical 0x1085 with the known READ-ONLY
 *    Information Manager commands 4 (GET_ISSUE_COUNT) and 5
 *    (READ_ISSUE_BY_NUMBER)
 *  - restore TIME_FORMAT, power-cycle again, and compare everything
 *
 * It deliberately does NOT write speed/region/tuning values and does NOT attempt
 * to forge signatures/MACs or install configuration containers.
 *
 * Requirements:
 *  - Clone https://github.com/LithiumNL/bosch-bes3-reader
 *  - cd node && npm install
 *  - Put this file anywhere inside that repo (repo root or node/ is easiest)
 *  - Run with: node bes3-usb-experiment.js
 *  - Optional: node bes3-usb-experiment.js --full
 *
 * --full performs three complete sweeps of every registry entry marked readable:
 * baseline, after the 0x1085 probe, and final after restoration. This can take
 * several minutes.
 */

const fs = require('fs');
const path = require('path');
const readline = require('readline');

function findRepoRoot() {
  const candidates = [
    process.cwd(),
    __dirname,
    path.resolve(__dirname, '..'),
    path.resolve(process.cwd(), '..'),
  ];
  for (const p of candidates) {
    if (
      fs.existsSync(path.join(p, 'src', 'protocol.js')) &&
      fs.existsSync(path.join(p, 'src', 'address-registry.generated.js')) &&
      fs.existsSync(path.join(p, 'node', 'transport-node-usb.js'))
    ) return p;
  }
  throw new Error(
    'bosch-bes3-reader repo niet gevonden. Plaats dit script in de repo en voer het daar uit.'
  );
}

const ROOT = findRepoRoot();

const {
  MessageType,
  buildReadRequestFrame,
  buildWriteFrame,
  buildRpcCallFrame,
  buildRpcCallFrameWithArg,
  encodeEnumArg,
  encodeExecuteInformationManagerCommandArg,
  decodeExecuteInformationManagerCommandReturn,
  diagnosticReturnValueName,
  parseReadResponseFrame,
  decodeValue,
} = require(path.join(ROOT, 'src', 'protocol.js'));

const { decodeTyped } = require(path.join(ROOT, 'src', 'messageTypes.js'));
const { ADDRESS_REGISTRY } = require(path.join(ROOT, 'src', 'address-registry.generated.js'));
const {
  Bes3UsbTransport,
  findDevice,
} = require(path.join(ROOT, 'node', 'transport-node-usb.js'));
const {
  UsbCaptureSession,
} = require(path.join(ROOT, 'node', 'usb-capture.js'));

const FULL = process.argv.includes('--full');
const NO_WRITE = process.argv.includes('--no-write');

const KEEP_ALIVE_ADDR = 0x2106; // RESET_INACTIVITY_SHUTDOWN_TIMER
const TIME_FORMAT_ADDR = 0x2183;

const sleep = ms => new Promise(r => setTimeout(r, ms));

const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout,
});
function ask(q) {
  return new Promise(resolve => rl.question(q, a => resolve(a.trim())));
}
async function confirm(q, defaultYes = true) {
  const suffix = defaultYes ? ' [Y/n] ' : ' [y/N] ';
  const a = (await ask(q + suffix)).toLowerCase();
  if (!a) return defaultYes;
  return a === 'y' || a === 'yes' || a === 'j' || a === 'ja';
}

function isoSafe() {
  return new Date().toISOString().replace(/[:.]/g, '-');
}
function hex(bytes) {
  if (!bytes) return '';
  return Buffer.from(bytes).toString('hex').match(/.{1,2}/g)?.join(' ') || '';
}

const outDir = path.join(process.cwd(), 'experiment-logs', isoSafe());
fs.mkdirSync(outDir, { recursive: true });
const frameLog = path.join(outDir, 'frames.jsonl');

function eventLog(obj) {
  fs.appendFileSync(
    frameLog,
    JSON.stringify({ ts: new Date().toISOString(), ...obj }) + '\n'
  );
}

let seqCounter = 0;
function nextSeq() {
  seqCounter = (seqCounter + 1) & 0x0f;
  return seqCounter;
}

let transport = null;
let keepAliveTimer = null;
let transportBusy = false;
let rawCapture = null;

async function drain(max = 8) {
  if (!transport) return;
  for (let i = 0; i < max; i++) {
    const raw = await transport.readNextFrame(1, 2);
    if (!raw) break;
    eventLog({ direction: 'RX', op: 'drain', raw: hex(raw) });
  }
}

function startKeepAlive() {
  stopKeepAlive();
  keepAliveTimer = setInterval(async () => {
    if (!transport || transportBusy) return;
    transportBusy = true;
    try {
      const seq = nextSeq();
      const frame = buildRpcCallFrame(KEEP_ALIVE_ADDR, seq);
      eventLog({
        direction: 'TX',
        op: 'keepalive',
        logicalAddr: '0x' + KEEP_ALIVE_ADDR.toString(16),
        seq,
        raw: hex(frame),
      });
      await transport.doMcspWrite(frame);
    } catch (_) {
      // bike may be shutting down / power-cycling
    } finally {
      transportBusy = false;
    }
  }, 800);
}
function stopKeepAlive() {
  if (keepAliveTimer) clearInterval(keepAliveTimer);
  keepAliveTimer = null;
}

async function openSession(waitMs = 30000) {
  const deadline = Date.now() + waitMs;
  let device = null;
  while (Date.now() < deadline) {
    device = findDevice();
    if (device) break;
    await sleep(500);
  }
  if (!device) throw new Error('Geen Bosch Smart System USB-device gevonden.');

  transport = new Bes3UsbTransport(device, { capture: rawCapture });
  await transport.open();
  await sleep(150);
  await drain();
  startKeepAlive();
  console.log('USB verbonden.');
}

async function closeSession() {
  stopKeepAlive();
  if (transport) {
    try { transport.close(); } catch (_) {}
  }
  transport = null;
  await sleep(600);
}

async function waitForResponse(addr, expectedType, seq, timeoutMs, opName) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const raw = await transport.readNextFrame(4, 4);
    if (!raw) continue;

    const parsed = parseReadResponseFrame(raw);
    eventLog({
      direction: 'RX',
      op: opName,
      raw: hex(raw),
      parsed: parsed ? {
        addr: '0x' + (((parsed.addrHigh << 8) | parsed.addrLow) >>> 0).toString(16),
        type: parsed.type,
        seq: parsed.seq,
        ok: parsed.ok,
        statusName: parsed.statusName,
        payload: hex(parsed.payload),
      } : null,
    });

    if (!parsed) continue;
    if (parsed.addrHigh !== (addr >> 8) || parsed.addrLow !== (addr & 0xff)) continue;
    if (parsed.type !== expectedType || parsed.seq !== seq) continue;
    return parsed;
  }
  return null;
}

async function readOne(addr, label = '') {
  transportBusy = true;
  try {
    await drain(5);
    const seq = nextSeq();
    const frame = buildReadRequestFrame(addr, seq);
    eventLog({
      direction: 'TX',
      op: 'READ',
      label,
      logicalAddr: '0x' + addr.toString(16).padStart(4, '0'),
      seq,
      raw: hex(frame),
    });
    await transport.doMcspWrite(frame);

    const parsed = await waitForResponse(addr, MessageType.READ_RESPONSE, seq, 650, 'READ');
    if (!parsed) return { status: 'timeout' };
    if (!parsed.ok) return { status: 'declined', statusName: parsed.statusName };

    const typed = decodeTyped(addr, parsed.payload);
    const decoded = typed || decodeValue(parsed.payload);
    return {
      status: 'ok',
      payloadHex: hex(parsed.payload),
      typed: !!typed,
      display: decoded?.display ?? null,
      value: decoded?.value ?? null,
      label: decoded?.label ?? null,
    };
  } finally {
    transportBusy = false;
  }
}

async function writeEnum(addr, value, label = '') {
  transportBusy = true;
  try {
    await drain(5);
    const seq = nextSeq();
    const payload = encodeEnumArg(value);
    const frame = buildWriteFrame(addr, seq, payload);
    eventLog({
      direction: 'TX',
      op: 'WRITE_ENUM',
      label,
      logicalAddr: '0x' + addr.toString(16).padStart(4, '0'),
      value,
      seq,
      raw: hex(frame),
    });
    await transport.doMcspWrite(frame);

    const parsed = await waitForResponse(addr, MessageType.WRITE_RESPONSE, seq, 800, 'WRITE_ENUM');
    if (!parsed) return { status: 'timeout' };
    if (!parsed.ok) return { status: 'declined', statusName: parsed.statusName };
    return { status: 'ok', payloadHex: hex(parsed.payload) };
  } finally {
    transportBusy = false;
  }
}

async function rpcInfoManager(addr, command, entryNumber = 0, label = '') {
  transportBusy = true;
  try {
    await drain(5);
    const seq = nextSeq();
    const arg = encodeExecuteInformationManagerCommandArg(command, entryNumber);
    const frame = buildRpcCallFrameWithArg(addr, seq, arg);

    eventLog({
      direction: 'TX',
      op: 'RPC_INFO_MANAGER',
      label,
      logicalAddr: '0x' + addr.toString(16).padStart(4, '0'),
      note: addr === 0x1085 ? 'wire destination bytes are expected to contain 90 85' : undefined,
      command,
      entryNumber,
      seq,
      raw: hex(frame),
    });

    await transport.doMcspWrite(frame);
    const parsed = await waitForResponse(addr, MessageType.RPC_RESPONSE, seq, 900, 'RPC_INFO_MANAGER');
    if (!parsed) return { status: 'timeout' };
    if (!parsed.ok) return { status: 'declined', statusName: parsed.statusName };

    const decoded = decodeExecuteInformationManagerCommandReturn(parsed.payload);
    return {
      status: 'ok',
      payloadHex: hex(parsed.payload),
      ...decoded,
      returnValueName: diagnosticReturnValueName(decoded.returnValue),
    };
  } finally {
    transportBusy = false;
  }
}

function registryEntry(component, name) {
  return ADDRESS_REGISTRY.addresses.find(
    e => e.component === component && e.name === name
  );
}

const focusSpecs = [
  ['DriveUnit', 'MAXIMUM_LEGAL_BIKE_SPEED'],
  ['DriveUnit', 'MAXIMUM_ASSISTANCE_SPEED'],
  ['DriveUnit', 'REGIO_SPEED_APPLICATION_REQUIRED'],
  ['DriveUnit', 'REGIO_SPEED_APPLICATION_AVAILABLE'],
  ['DriveUnit', 'SPEED_SOURCE'],
  ['DriveUnit', 'MAXIMUM_ASSISTANCE_SPEED_IBD'],
  ['DriveUnit', 'IN_SOFTWARE_INSTALLATION_STATE'],
  ['DriveUnit', 'SPEED_MANIPULATION_STATUS'],
  ['DriveUnit', 'TUNING_DETECTION'],
  ['DriveUnit', 'SPEED_RANGE'],
  ['DriveUnit', 'REGIO_SPEED_CONFIGURATION'],
  ['DriveUnit', 'IS_SPEED_PEDELEC'],
  ['DriveUnit', 'SPEED_TUNING_PREDICTED'],
  ['DriveUnit', 'TUNING_DETECTION_CONFIG'],

  ['BoschDiagnoseApp', 'CONFIGURATION_CONTAINERS'],

  ['RemoteControl', 'TIME_FORMAT'],
  ['RemoteControl', 'CURRENT_MANIFEST'],
  ['RemoteControl', 'SOFTWARE_UPDATE_AVAILABLE_FOR_INSTALLATION'],
  ['RemoteControl', 'SOFTWARE_UPDATE_STATUS'],
  ['RemoteControl', 'STORED_SOFTWARE_UPDATE_STATUS'],
  ['RemoteControl', 'STORED_BOOTLOADER_ERROR_STATES'],
  ['RemoteControl', 'UPDATE_PLAN_INFO'],
  ['RemoteControl', 'STORED_CONTAINER_ERROR_INFO'],
  ['RemoteControl', 'COMPONENT_IDENTIFIER_READ_ERROR_INFO'],
  ['RemoteControl', 'STORED_COMPONENT_UNEXPECTED_RESTART_ERROR_INFO'],
  ['RemoteControl', 'STORED_UPDATE_STUCK_ERROR_INFO'],
  ['RemoteControl', 'LOGGER_CONFIG'],
];

const focusEntries = focusSpecs.map(([component, name]) => {
  const e = registryEntry(component, name);
  return e ? { component, name, addr: e.address } : { component, name, addr: null };
});

async function readFocus() {
  const out = {};
  console.log('\nBelangrijke waarden uitlezen...');
  for (const e of focusEntries) {
    const key = `${e.component}.${e.name}`;
    if (e.addr == null) {
      out[key] = { status: 'not-in-registry' };
      console.log(`  ${key}: niet in huidige registry`);
      continue;
    }
    const r = await readOne(e.addr, key);
    out[key] = {
      addr: '0x' + e.addr.toString(16).padStart(4, '0'),
      ...r,
    };
    const shown = r.status === 'ok'
      ? r.display
      : r.status === 'declined'
      ? `DECLINED ${r.statusName}`
      : r.status;
    console.log(`  ${key.padEnd(62)} ${shown}`);
    await sleep(20);
  }
  return out;
}

async function readIssues() {
  const result = {};
  const issueEndpoints = ADDRESS_REGISTRY.addresses.filter(
    e => e.name === 'EXECUTE_INFORMATION_MANAGER_COMMAND_BOSCH'
  );

  console.log('\nIssue-lijsten uitlezen...');
  for (const e of issueEndpoints) {
    const key = `${e.component}.EXECUTE_INFORMATION_MANAGER_COMMAND_BOSCH`;
    const count = await rpcInfoManager(e.address, 4, 0, `${key}:GET_ISSUE_COUNT`);
    if (count.status !== 'ok' || count.returnValue !== 0) {
      result[e.component] = { countResult: count, issues: [] };
      console.log(`  ${e.component.padEnd(24)} count: ${count.status}${count.statusName ? ' '+count.statusName : ''}`);
      continue;
    }

    const issues = [];
    for (let i = 0; i < (count.entryCount || 0); i++) {
      const rr = await rpcInfoManager(e.address, 5, i, `${key}:READ_ISSUE_BY_NUMBER(${i})`);
      issues.push(rr);
      await sleep(15);
    }
    result[e.component] = { countResult: count, issues };
    console.log(`  ${e.component.padEnd(24)} ${issues.length} issue(s)`);
  }
  return result;
}

async function fullSweep() {
  const result = {};
  const readable = ADDRESS_REGISTRY.addresses.filter(e => e.readable === true);
  console.log(`\nVolledige read-sweep: ${readable.length} registry-adressen...`);
  let n = 0;
  for (const e of readable) {
    const key = `${e.component}.${e.name}`;
    const r = await readOne(e.address, key);
    result[key] = {
      addr: '0x' + e.address.toString(16).padStart(4, '0'),
      ...r,
    };
    n++;
    if (n % 50 === 0) console.log(`  ${n}/${readable.length}`);
    await sleep(15);
  }
  return result;
}

async function makeSnapshot(label, includeFull = false) {
  console.log(`\n========== SNAPSHOT: ${label} ==========`);
  const snap = {
    label,
    timestamp: new Date().toISOString(),
    focus: await readFocus(),
    issues: await readIssues(),
  };
  if (includeFull) snap.full = await fullSweep();

  fs.writeFileSync(
    path.join(outDir, `${label}.json`),
    JSON.stringify(snap, null, 2)
  );
  return snap;
}

function normalizeForDiff(r) {
  if (!r) return null;
  return {
    status: r.status,
    statusName: r.statusName,
    payloadHex: r.payloadHex,
    value: r.value,
    display: r.display,
  };
}

function compareFocus(a, b) {
  const keys = new Set([
    ...Object.keys(a?.focus || {}),
    ...Object.keys(b?.focus || {}),
  ]);
  const changes = [];
  for (const k of [...keys].sort()) {
    const av = normalizeForDiff(a?.focus?.[k]);
    const bv = normalizeForDiff(b?.focus?.[k]);
    if (JSON.stringify(av) !== JSON.stringify(bv)) {
      changes.push({ key: k, before: av, after: bv });
    }
  }
  return changes;
}

function compareIssues(a, b) {
  const keys = new Set([
    ...Object.keys(a?.issues || {}),
    ...Object.keys(b?.issues || {}),
  ]);
  const changes = [];
  for (const k of [...keys].sort()) {
    const av = a?.issues?.[k] || null;
    const bv = b?.issues?.[k] || null;
    if (JSON.stringify(av) !== JSON.stringify(bv)) {
      changes.push({ component: k, before: av, after: bv });
    }
  }
  return changes;
}

async function powerCyclePrompt(number) {
  await closeSession();
  console.log(`\n--- POWERCYCLE ${number} ---`);
  console.log('1. Schakel de fiets volledig uit.');
  console.log('2. Wacht tot hij echt uit is.');
  console.log('3. Schakel hem weer in.');
  console.log('4. Laat USB aangesloten of sluit hem opnieuw aan.');
  await ask('Druk ENTER zodra de fiets weer aan en klaar is...');
  await openSession();
}

async function runValdrinReadOnlyProbe() {
  console.log('\n========== READ-ONLY 0x9085 / logical 0x1085 PROBE ==========');
  console.log('Dit voert GEEN speed-write uit.');
  console.log('We sturen alleen de bekende Information Manager RPC-commands 4 en 5.');
  console.log('Bij logical 0x1085 moet de raw TX-frame destination op de wire als 90 85 verschijnen.');

  const addr = 0x1085;
  const count = await rpcInfoManager(addr, 4, 0, 'VALDRIN_PROBE command=4 GET_ISSUE_COUNT');
  console.log('command 4 result:', count);

  const entry0 = await rpcInfoManager(addr, 5, 0, 'VALDRIN_PROBE command=5 READ_ISSUE_BY_NUMBER(0)');
  console.log('command 5 result:', entry0);

  const result = { count, entry0 };
  fs.writeFileSync(
    path.join(outDir, 'valdrin-readonly-probe.json'),
    JSON.stringify(result, null, 2)
  );
  return result;
}

async function main() {
  console.log('Bosch BES3 USB experiment');
  console.log('Repo:', ROOT);
  console.log('Logs:', outDir);
  console.log('Full sweep:', FULL ? 'JA' : 'NEE');
  console.log('Benign TIME_FORMAT write:', NO_WRITE ? 'UIT' : 'AAN');

  rawCapture = new UsbCaptureSession(
    path.join(outDir, 'raw-usb'),
    {
      tool: 'experiments/bes3-usb-experiment.js',
      purpose: 'TIME_FORMAT persistence + read-only 0x1085 probe',
      fullSweep: FULL,
      noWrite: NO_WRITE,
    }
  );
  console.log('Lossless raw USB capture:', path.join(outDir, 'raw-usb'));

  await openSession();

  const baseline = await makeSnapshot('01-baseline', FULL);

  const tfKey = 'RemoteControl.TIME_FORMAT';
  const originalTime = baseline.focus[tfKey];
  if (!originalTime || originalTime.status !== 'ok' || ![0, 1].includes(Number(originalTime.value))) {
    console.log('\nTIME_FORMAT kon niet betrouwbaar als 0/1 worden gelezen.');
    console.log('Benign write wordt overgeslagen, maar read-only onderzoek kan doorgaan.');
  }

  let afterWrite = null;
  let afterCycle1 = null;
  let afterProbe = null;
  let afterRestore = null;
  let finalSnap = null;

  if (!NO_WRITE && originalTime?.status === 'ok' && [0, 1].includes(Number(originalTime.value))) {
    const original = Number(originalTime.value);
    const toggled = original === 0 ? 1 : 0;

    console.log(`\nTIME_FORMAT nu: ${original} (${original === 0 ? '24h' : '12h'})`);
    console.log(`Testwaarde: ${toggled} (${toggled === 0 ? '24h' : '12h'})`);

    const ok = await confirm(
      'TIME_FORMAT tijdelijk omschakelen als positieve schrijf/persistentie-test?',
      true
    );
    if (ok) {
      const wr = await writeEnum(TIME_FORMAT_ADDR, toggled, 'benign TIME_FORMAT toggle');
      console.log('WRITE response:', wr);

      const verify = await readOne(TIME_FORMAT_ADDR, 'verify TIME_FORMAT after write');
      console.log('Directe read-back:', verify);

      afterWrite = await makeSnapshot('02-after-time-format-write', false);

      await powerCyclePrompt(1);
      afterCycle1 = await makeSnapshot('03-after-powercycle-1', FULL);

      const persisted = afterCycle1.focus[tfKey];
      console.log('\nTIME_FORMAT na powercycle 1:', persisted?.display, 'value=', persisted?.value);

      const probe = await confirm(
        'Nu de read-only 0x9085/logical-0x1085 command-4/5 probe uitvoeren?',
        true
      );
      if (probe) {
        await runValdrinReadOnlyProbe();
        afterProbe = await makeSnapshot('04-after-valdrin-readonly-probe', FULL);
      }

      console.log(`\nTIME_FORMAT terugzetten naar origineel: ${original} (${original === 0 ? '24h' : '12h'})`);
      const restore = await writeEnum(TIME_FORMAT_ADDR, original, 'restore original TIME_FORMAT');
      console.log('Restore WRITE response:', restore);
      console.log('Restore read-back:', await readOne(TIME_FORMAT_ADDR, 'verify restored TIME_FORMAT'));

      afterRestore = await makeSnapshot('05-after-time-format-restore', false);

      await powerCyclePrompt(2);
      finalSnap = await makeSnapshot('06-after-powercycle-2-final', FULL);
    }
  }

  if (!afterCycle1) {
    const probe = await confirm(
      'Read-only 0x9085/logical-0x1085 command-4/5 probe uitvoeren?',
      true
    );
    if (probe) {
      await runValdrinReadOnlyProbe();
      afterProbe = await makeSnapshot('04-after-valdrin-readonly-probe', FULL);
    }
  }

  const snapshots = {
    baseline,
    afterWrite,
    afterCycle1,
    afterProbe,
    afterRestore,
    final: finalSnap,
  };

  const pairs = [];
  function addDiff(name, a, b) {
    if (!a || !b) return;
    pairs.push({
      name,
      focusChanges: compareFocus(a, b),
      issueChanges: compareIssues(a, b),
    });
  }

  addDiff('baseline -> after TIME_FORMAT write', baseline, afterWrite);
  addDiff('after write -> after powercycle 1', afterWrite, afterCycle1);
  addDiff('after powercycle 1 -> after 0x1085 probe', afterCycle1, afterProbe);
  addDiff('baseline -> after 0x1085 probe', baseline, afterProbe);
  addDiff('after probe -> after TIME_FORMAT restore', afterProbe || afterCycle1, afterRestore);
  addDiff('baseline -> final after powercycle 2', baseline, finalSnap);

  const report = {
    createdAt: new Date().toISOString(),
    outputDirectory: outDir,
    fullSweepEnabled: FULL,
    snapshots: Object.fromEntries(
      Object.entries(snapshots).map(([k, v]) => [k, v ? `${v.label}.json` : null])
    ),
    diffs: pairs,
  };

  fs.writeFileSync(
    path.join(outDir, 'diff-report.json'),
    JSON.stringify(report, null, 2)
  );

  console.log('\n========== RESULTAAT ==========');
  for (const d of pairs) {
    console.log(`\n${d.name}`);
    console.log(`  Focus changes: ${d.focusChanges.length}`);
    for (const c of d.focusChanges) {
      console.log(`    ${c.key}`);
      console.log(`      before: ${JSON.stringify(c.before)}`);
      console.log(`      after : ${JSON.stringify(c.after)}`);
    }
    console.log(`  Issue-list changes: ${d.issueChanges.length}`);
    for (const c of d.issueChanges) {
      console.log(`    ${c.component}`);
    }
  }

  console.log('\nRaw TX/RX frames:', frameLog);
  console.log('Diff report:', path.join(outDir, 'diff-report.json'));
  console.log('Klaar.');

  await closeSession();
  if (rawCapture) rawCapture.close({ status: 'completed' });
  rl.close();
}

process.on('SIGINT', async () => {
  console.log('\nAfbreken...');
  try { await closeSession(); } catch (_) {}
  try { if (rawCapture) rawCapture.close({ status: 'aborted' }); } catch (_) {}
  rl.close();
  process.exit(130);
});

main().catch(async err => {
  console.error('\nFATAL:', err);
  try { await closeSession(); } catch (_) {}
  try {
    if (rawCapture) rawCapture.close({
      status: 'error',
      error: err && err.message ? err.message : String(err),
    });
  } catch (_) {}
  rl.close();
  process.exit(1);
});