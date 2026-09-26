// Node-specific USB transport (uses the usb npm package, libusb-backed).
// Implements MCSP framing over vendor control + bulk transfers.
//
// Optional lossless capture:
//   new Bes3UsbTransport(device, { capture: UsbCaptureSession })
//
// Every user-space-visible USB transaction and unmodified MCSP frame is logged
// before semantic decoding, so old sessions can be replayed later.

'use strict';

const usb = require('usb');

const VENDOR_ID = 0x108c;
const PRODUCT_IDS = [448, 452, 454, 462];
const EP_IN = 3;
const EP_OUT = 4;

const REQ_GET_IN_STATE = 0x44;
const REQ_SET_IN_DONE = 0x45;
const REQ_GET_OUT_STATE = 0x47;
const REQ_SET_OUT_SIZE = 0x48;

const BM_VENDOR_IFACE_OUT = 0x41;
const BM_VENDOR_IFACE_IN = 0xc1;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function hexByte(n) {
  return '0x' + Number(n).toString(16).padStart(2, '0');
}

function toHex(data) {
  if (data == null) return null;
  return Buffer.from(data).toString('hex').match(/.{1,2}/g)?.join(' ') || '';
}

function rawControlTransfer(device, bmRequestType, bRequest, wValue, wIndex, dataOrLength) {
  return new Promise((resolve, reject) => {
    device.controlTransfer(bmRequestType, bRequest, wValue, wIndex, dataOrLength, (err, data) => {
      if (err) reject(err);
      else resolve(data);
    });
  });
}

function findDevice() {
  const devices = usb.getDeviceList();
  return devices.find(
    (d) => d.deviceDescriptor.idVendor === VENDOR_ID && PRODUCT_IDS.includes(d.deviceDescriptor.idProduct)
  ) || null;
}

class Bes3UsbTransport {
  constructor(device, options = {}) {
    this.device = device;
    this.iface = null;
    this.epIn = null;
    this.epOut = null;
    this.capture = options.capture || null;
  }

  _record(event) {
    if (!this.capture || typeof this.capture.record !== 'function') return;
    try {
      this.capture.record(event);
    } catch (_) {
      // Logging must never interfere with bike communication.
    }
  }

  async _controlTransfer(bmRequestType, bRequest, wValue, wIndex, dataOrLength, label) {
    const isIn = !!(bmRequestType & 0x80);
    const outData = !isIn && Buffer.isBuffer(dataOrLength) ? dataOrLength : null;
    const requestedLength = isIn && typeof dataOrLength === 'number' ? dataOrLength : null;

    this._record({
      layer: 'usb-control',
      event: 'submit',
      direction: 'host->bike',
      label: label || null,
      bm_request_type: hexByte(bmRequestType),
      b_request: hexByte(bRequest),
      w_value: wValue,
      w_index: wIndex,
      requested_length: requestedLength,
      data_hex: outData ? toHex(outData) : null,
      data_length: outData ? outData.length : null,
    });

    try {
      const data = await rawControlTransfer(
        this.device, bmRequestType, bRequest, wValue, wIndex, dataOrLength
      );

      this._record({
        layer: 'usb-control',
        event: 'complete',
        direction: isIn ? 'bike->host' : 'host->bike',
        label: label || null,
        bm_request_type: hexByte(bmRequestType),
        b_request: hexByte(bRequest),
        status: 'ok',
        data_hex: data ? toHex(data) : null,
        data_length: data ? data.length : 0,
      });

      return data;
    } catch (err) {
      this._record({
        layer: 'usb-control',
        event: 'complete',
        direction: isIn ? 'bike->host' : 'host->bike',
        label: label || null,
        bm_request_type: hexByte(bmRequestType),
        b_request: hexByte(bRequest),
        status: 'error',
        error: err && err.message ? err.message : String(err),
      });
      throw err;
    }
  }

  async open() {
    this.device.open();
    this.iface = this.device.interface(0);

    try {
      this.iface.claim();
    } catch (e) {
      if (this.iface.isKernelDriverActive && this.iface.isKernelDriverActive()) {
        this.iface.detachKernelDriver();
        this.iface.claim();
      } else {
        throw e;
      }
    }

    this.epOut = this.iface.endpoints.find(
      (e) => e.address === EP_OUT || e.address === (EP_OUT | 0x00)
    );
    this.epIn = this.iface.endpoints.find((e) => e.address === (EP_IN | 0x80));

    if (!this.epIn || !this.epOut) {
      throw new Error('Could not find expected bulk endpoints (in=' + EP_IN + ', out=' + EP_OUT + ')');
    }

    const d = this.device.deviceDescriptor || {};
    this._record({
      layer: 'session',
      event: 'usb-open',
      direction: 'local',
      usb: {
        vendor_id: d.idVendor,
        product_id: d.idProduct,
        bcd_device: d.bcdDevice,
        interface: 0,
        endpoint_in: this.epIn.address,
        endpoint_out: this.epOut.address,
      },
      privacy_note: 'USB string descriptors are intentionally not queried by the capture layer.',
    });

    // The BRC3600 / LED Remote exposes a USB<->serial bridge. The stock Bosch
    // tool and the working WebUSB transport initialise it before MessageBus
    // traffic. Without this sequence, bulk OUT can ACK locally while frames
    // never reach the bike bus, causing an all-timeout sweep.
    await this.init();
  }

  async init() {
    const cfg = Buffer.from([0x00, 0x80, 0x00, 0x00, 0x00, 0x04, 0x00, 0x00, 0x00]);

    await this._controlTransfer(BM_VENDOR_IFACE_IN, 0x01, 0, 0, 1, 'BRIDGE_STATUS');
    await this._controlTransfer(BM_VENDOR_IFACE_OUT, 0x00, 0, 0, Buffer.alloc(0), 'BRIDGE_INIT_00');
    await this._controlTransfer(BM_VENDOR_IFACE_OUT, 0x43, 0, 0, cfg, 'BRIDGE_CONFIG_43');
    await this._controlTransfer(BM_VENDOR_IFACE_OUT, 0x23, 0, 0, cfg, 'BRIDGE_CONFIG_23');
    await this._controlTransfer(BM_VENDOR_IFACE_OUT, 0x41, 0, 0, Buffer.alloc(0), 'BRIDGE_INIT_41');
    await this._controlTransfer(BM_VENDOR_IFACE_OUT, 0x21, 0, 0, Buffer.alloc(0), 'BRIDGE_INIT_21');

    // MCSP session setup. Replies are drained so they cannot be mistaken for a
    // later datapoint response. The capture layer still retains every TX/RX.
    const handshake = [
      [0x10, 0x02, 0x01, 0x03],
      [0x10, 0x03, 0x04, 0x04, 0x00],
      [0x10, 0x06, 0x02, 0x01, 0x00, 0x10, 0x00, 0x00],
      [0x10, 0x06, 0x02, 0x02, 0x00, 0x10, 0x00, 0x00],
      [0x10, 0x06, 0x02, 0x03, 0x00, 0x10, 0x00, 0x00],
      [0x10, 0x06, 0x02, 0x04, 0x00, 0x00, 0x00, 0x00],
      [0x10, 0x06, 0x02, 0x05, 0x00, 0x00, 0x00, 0x00],
      [0x10, 0x06, 0x02, 0x06, 0x00, 0x00, 0x00, 0x00],
      [0x10, 0x06, 0x02, 0x07, 0x00, 0x00, 0x00, 0x00],
    ];

    for (const frame of handshake) {
      await this.doMcspWrite(Buffer.from(frame));
      for (let i = 0; i < 4; i++) {
        if (!(await this.readNextFrame(2, 3))) break;
      }
    }

    this._record({
      layer: 'session',
      event: 'bridge-init-complete',
      direction: 'local',
    });
  }

  close() {
    this._record({ layer: 'session', event: 'usb-close', direction: 'local' });

    try {
      this.iface.release(true, () => {
        try {
          this.device.close();
        } catch (_) {}
      });
    } catch (_) {}
  }

  bulkOut(data) {
    const bytes = Buffer.from(data);

    this._record({
      layer: 'usb-bulk',
      event: 'transfer',
      direction: 'host->bike',
      endpoint: hexByte(this.epOut.address),
      data_length: bytes.length,
      data_hex: toHex(bytes),
    });

    return new Promise((resolve, reject) => {
      this.epOut.transfer(bytes, (err) => {
        if (err) {
          this._record({
            layer: 'usb-bulk',
            event: 'result',
            direction: 'host->bike',
            endpoint: hexByte(this.epOut.address),
            status: 'error',
            error: err.message,
          });
          reject(err);
        } else {
          this._record({
            layer: 'usb-bulk',
            event: 'result',
            direction: 'host->bike',
            endpoint: hexByte(this.epOut.address),
            status: 'ok',
          });
          resolve();
        }
      });
    });
  }

  bulkIn(length) {
    this._record({
      layer: 'usb-bulk',
      event: 'request',
      direction: 'host->bike',
      endpoint: hexByte(this.epIn.address),
      requested_length: length,
    });

    return new Promise((resolve, reject) => {
      this.epIn.transfer(length, (err, data) => {
        if (err) {
          this._record({
            layer: 'usb-bulk',
            event: 'transfer',
            direction: 'bike->host',
            endpoint: hexByte(this.epIn.address),
            status: 'error',
            error: err.message,
          });
          reject(err);
        } else {
          this._record({
            layer: 'usb-bulk',
            event: 'transfer',
            direction: 'bike->host',
            endpoint: hexByte(this.epIn.address),
            status: 'ok',
            data_length: data ? data.length : 0,
            data_hex: data ? toHex(data) : null,
          });
          resolve(data);
        }
      });
    });
  }

  async doMcspWrite(payload) {
    const mcsp = Buffer.from(payload);

    this._record({
      layer: 'mcsp',
      event: 'frame',
      direction: 'host->bike',
      data_length: mcsp.length,
      raw_hex: toHex(mcsp),
    });

    const lengthBuf = Buffer.alloc(4);
    lengthBuf.writeUInt32LE(payload.length, 0);
    await this._controlTransfer(
      BM_VENDOR_IFACE_OUT, REQ_SET_OUT_SIZE, 0, 0, lengthBuf, 'SET_OUT_SIZE'
    );

    const padding = payload.length % 64;
    const padded = padding > 0
      ? Buffer.concat([mcsp, Buffer.alloc(64 - padding)])
      : mcsp;

    await this.bulkOut(padded);

    for (let tries = 0; tries < 10; tries++) {
      const ack = await this._controlTransfer(
        BM_VENDOR_IFACE_IN, REQ_GET_OUT_STATE, 0, 0, 3, 'GET_OUT_STATE'
      );

      if (!ack || ack.length < 3) {
        await sleep(20);
        continue;
      }

      if (ack[1] === 3) {
        await sleep(20);
        continue;
      }

      if (ack[2] !== 0) {
        throw new Error('Write error, status byte = ' + ack[2]);
      }

      return;
    }

    throw new Error('Write ACK timeout');
  }

  async readNextFrame(maxPolls = 50, pollDelayMs = 5) {
    for (let i = 0; i < maxPolls; i++) {
      const lenBuf = await this._controlTransfer(
        BM_VENDOR_IFACE_IN, REQ_GET_IN_STATE, 0, 0, 7, 'GET_IN_STATE'
      );

      if (!lenBuf || lenBuf.length < 4) {
        await sleep(pollDelayMs);
        continue;
      }

      const length = lenBuf.readUInt32LE(0);

      if (length === 0) {
        await sleep(pollDelayMs);
        continue;
      }

      if (length > 65536) {
        this._record({
          layer: 'mcsp',
          event: 'invalid-length',
          direction: 'bike->host',
          length,
        });
        await sleep(pollDelayMs);
        continue;
      }

      const data = await this.bulkIn(length);

      await this._controlTransfer(
        BM_VENDOR_IFACE_OUT, REQ_SET_IN_DONE, 0, 0, Buffer.alloc(0), 'SET_IN_DONE'
      );

      this._record({
        layer: 'mcsp',
        event: 'frame',
        direction: 'bike->host',
        data_length: data ? data.length : 0,
        raw_hex: data ? toHex(data) : null,
      });

      return data;
    }

    return null;
  }
}

module.exports = { Bes3UsbTransport, findDevice, VENDOR_ID, PRODUCT_IDS };
