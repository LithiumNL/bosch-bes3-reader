'use strict';

function parseHexBytes(text) {
  const raw = String(text || '').trim();
  if (!raw) return Buffer.alloc(0);

  const compact = raw
    .replace(/0x/gi, '')
    .replace(/[\s,:_-]+/g, '');

  if (!compact || compact.length % 2 !== 0 || /[^0-9a-f]/i.test(compact)) {
    throw new Error('Hex data must contain complete bytes, e.g. "08 04" or "0x08 0x04".');
  }
  return Buffer.from(compact, 'hex');
}

function formatAddress(addr) {
  return '0x' + Number(addr).toString(16).padStart(4, '0');
}

function resolveAddress(input, registry) {
  const text = String(input || '').trim();
  if (!text) throw new Error('Missing address.');

  let addr = null;
  if (/^0x[0-9a-f]+$/i.test(text)) addr = parseInt(text.slice(2), 16);
  else if (/^[0-9]+$/.test(text)) addr = parseInt(text, 10);

  const addresses = registry && Array.isArray(registry.addresses) ? registry.addresses : [];

  if (addr != null) {
    if (!Number.isInteger(addr) || addr < 0 || addr > 0x7fff) {
      throw new Error('Logical address must be between 0x0000 and 0x7fff.');
    }
    return {
      address: addr,
      entry: addresses.find((e) => e.address === addr) || null,
    };
  }

  const needle = text.toLowerCase();
  const exactQualified = addresses.filter(
    (e) => (e.component + '.' + e.name).toLowerCase() === needle
  );
  if (exactQualified.length === 1) {
    return { address: exactQualified[0].address, entry: exactQualified[0] };
  }

  const exactName = addresses.filter((e) => String(e.name).toLowerCase() === needle);
  if (exactName.length === 1) {
    return { address: exactName[0].address, entry: exactName[0] };
  }
  if (exactName.length > 1) {
    throw new Error(
      'Address name is ambiguous. Use Component.NAME: ' +
      exactName.slice(0, 8).map((e) => e.component + '.' + e.name).join(', ')
    );
  }

  const partial = addresses.filter(
    (e) =>
      (e.component + '.' + e.name).toLowerCase().includes(needle)
  );
  if (partial.length === 1) {
    return { address: partial[0].address, entry: partial[0] };
  }
  if (partial.length > 1) {
    throw new Error(
      'Address search has multiple matches: ' +
      partial.slice(0, 8).map((e) => e.component + '.' + e.name).join(', ')
    );
  }

  throw new Error('Unknown address/name: ' + text);
}

function tokenize(line) {
  const tokens = [];
  const re = /"([^"]*)"|'([^']*)'|(\S+)/g;
  let m;
  while ((m = re.exec(line)) !== null) {
    tokens.push(m[1] ?? m[2] ?? m[3]);
  }
  return tokens;
}

function parseCommand(line) {
  const tokens = tokenize(String(line || '').trim());
  if (!tokens.length) return { command: 'empty', args: [] };

  const command = tokens[0].toLowerCase();
  const args = tokens.slice(1);

  switch (command) {
    case '?':
    case 'help':
      return { command: 'help', args };
    case 'q':
    case 'quit':
    case 'exit':
      return { command: 'quit', args };
    case 'read':
    case 'r':
      if (args.length !== 1) throw new Error('Usage: read <address|Component.NAME>');
      return { command: 'read', target: args[0], args };
    case 'write':
    case 'w':
      if (args.length < 2) throw new Error('Usage: write <address|Component.NAME> <payload-hex>');
      return { command: 'write', target: args[0], payloadText: args.slice(1).join(' '), args };
    case 'rpc':
      if (args.length < 1) throw new Error('Usage: rpc <address|Component.NAME> [argument-hex]');
      return { command: 'rpc', target: args[0], payloadText: args.slice(1).join(' '), args };
    case 'raw':
      if (args.length < 1) throw new Error('Usage: raw <complete-frame-hex>');
      return { command: 'raw', payloadText: args.join(' '), args };
    case 'listen':
      if (args.length > 1) throw new Error('Usage: listen [seconds]');
      return { command: 'listen', seconds: args.length ? Number(args[0]) : 10, args };
    case 'find':
    case 'registry':
      if (args.length < 1) throw new Error('Usage: find <name-fragment>');
      return { command: 'find', query: args.join(' '), args };
    case 'capture':
    case 'status':
      return { command: 'status', args };
    default:
      throw new Error('Unknown command: ' + tokens[0] + '. Type "help".');
  }
}

function findRegistryEntries(query, registry, limit = 20) {
  const needle = String(query || '').trim().toLowerCase();
  if (!needle) return [];
  const addresses = registry && Array.isArray(registry.addresses) ? registry.addresses : [];
  return addresses
    .filter((e) => {
      const text = [
        e.component,
        e.name,
        e.component + '.' + e.name,
        formatAddress(e.address),
      ].join(' ').toLowerCase();
      return text.includes(needle);
    })
    .slice(0, limit);
}

module.exports = {
  parseHexBytes,
  formatAddress,
  resolveAddress,
  parseCommand,
  findRegistryEntries,
};
