// Web Bluetooth: smart trainers, power meters and heart rate monitors.
//
// Trainers are tried in this order:
//   FTMS         the Bluetooth standard: Wahoo KICKR (recent firmware), Tacx/Garmin,
//                Elite, Saris, Zwift Hub, JetBlack, Kinetic, Magene, Van Rysel, ...
//   Tacx FE-C    older Tacx firmware
//   Wahoo        older KICKR / KICKR Core / SNAP firmware (Wahoo's own extension)
//   Power only   power meters and trainers that only report: no resistance control

const FTMS = 0x1826, INDOOR_BIKE_DATA = 0x2ad2, FTMS_CONTROL = 0x2ad9;
const CPS = 0x1818, CP_MEASUREMENT = 0x2a63;
const HRS = 0x180d, HR_MEASUREMENT = 0x2a37;
const TACX = '6e40fec1-b5a3-f393-e0a9-e50e24dcca9e';
const TACX_NOTIFY = '6e40fec2-b5a3-f393-e0a9-e50e24dcca9e';
const TACX_WRITE = '6e40fec3-b5a3-f393-e0a9-e50e24dcca9e';
const WAHOO_CONTROL = 'a026e005-0a7d-4ab3-97fa-f1500f9feb8b'; // lives inside the Cycling Power service
const le16 = (n) => [n & 0xff, (n >> 8) & 0xff];
const clamp16 = (n) => Math.max(0, Math.min(65535, Math.round(n)));

export const bluetoothAvailable = () => typeof navigator !== 'undefined' && !!navigator.bluetooth;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

class Device {
  constructor() {
    this.device = null;
    this.connected = false;
    this.name = '';
    this.lastData = 0;
    this.onstatus = () => {};
    this._wanted = false;
  }

  async _open(options) {
    const device = await navigator.bluetooth.requestDevice(options);
    if (this.device) this.disconnect();
    this.device = device;
    this.name = device.name || 'Unknown device';
    this._wanted = true;
    const session = (this._session = {}); // one per connect, so old listeners and retry loops stand down
    device.addEventListener('gattserverdisconnected', () => this._session === session && this._lost(device, session));
    try {
      await this._setup();
    } catch (e) {
      if (this._session === session) {
        this._wanted = false;
        this._session = null;
        this.device = null;
        try { device.gatt?.disconnect(); } catch {}
        this._reset();
        this.onstatus();
      }
      throw e;
    }
    if (this._session !== session) return;
    this.connected = true;
    this.onstatus();
  }

  async _lost(device, session) {
    if (device !== this.device || this._retrying) return;
    this._retrying = true;
    this.connected = false;
    this._reset();
    this.onstatus();
    const mine = () => this._wanted && device === this.device && this._session === session;
    try {
      await this._retry(mine);
    } finally {
      this._retrying = false;
    }
  }

  async _retry(mine) {
    for (let i = 0; i < 30 && mine(); i++) {
      await sleep(2000);
      if (!mine() || this.connected) return;
      try {
        await this._setup();
        if (!mine()) return;
        this.connected = true;
        this.onstatus();
        return;
      } catch (e) {
        console.warn('Reconnect failed', e);
      }
    }
  }

  disconnect() {
    this._wanted = false;
    this._session = null;
    this.connected = false;
    try { this.device?.gatt?.disconnect(); } catch {}
    this._reset();
    this.onstatus();
  }

  get fresh() {
    return this.connected && performance.now() - this.lastData < 4000;
  }

  _reset() {}
}

export class Trainer extends Device {
  constructor() {
    super();
    this.power = 0;
    this.cadence = 0;
    this.speed = 0; // km/h as reported by the trainer (flywheel speed)
    this.protocol = '';
    this.canControl = false;
    this._queue = Promise.resolve();
    this._crank = null;
  }

  connect() {
    return this._open({
      filters: [
        { services: [FTMS] }, { services: [CPS] }, { services: [TACX] },
        ...['Tacx', 'TACX', 'KICKR', 'Wahoo', 'Elite', 'Saris', 'Zwift', 'DIRETO', 'SUITO'].map((namePrefix) => ({ namePrefix })),
      ],
      optionalServices: [FTMS, CPS, TACX],
    });
  }

  _reset() {
    this.power = 0;
    this.cadence = 0;
    this.speed = 0;
    this._control = null;
    this._fec = null;
    this._wahoo = null;
    this._crank = null;
    this._queue = Promise.resolve();
  }

  // Total weight of rider and bike in kg. Wahoo's own protocol needs it.
  setRider(mass) {
    this._mass = mass;
    this._wahooSim();
  }
  _wahooSim(crr = 0.004, cw = 0.51) {
    if (!this._wahoo) return;
    this._write(this._wahoo, [0x43, ...le16(clamp16((this._mass || 85) * 100)), ...le16(clamp16(crr * 10000)), ...le16(clamp16(cw * 1000))]);
  }

  async _setup() {
    const server = await this.device.gatt.connect();
    this._reset();
    this.canControl = false;
    this.protocol = '';

    const ftms = await server.getPrimaryService(FTMS).catch(() => null);
    if (ftms) {
      const data = await ftms.getCharacteristic(INDOOR_BIKE_DATA);
      data.addEventListener('characteristicvaluechanged', (e) => this._onBikeData(e.target.value));
      await data.startNotifications();
      this.protocol = 'FTMS';
      const control = await ftms.getCharacteristic(FTMS_CONTROL).catch(() => null);
      if (control) {
        control.addEventListener('characteristicvaluechanged', (e) => {
          const v = e.target.value;
          if (v.byteLength >= 3 && v.getUint8(0) === 0x80 && v.getUint8(2) !== 0x01) {
            console.warn(`Trainer rejected command 0x${v.getUint8(1).toString(16)} (result ${v.getUint8(2)})`);
          }
        });
        await control.startNotifications().catch(() => {});
        this._control = control;
        this.canControl = true;
        await this._write(control, [0x00]); // request control
        await this._write(control, [0x07]); // start / resume
      }
      return;
    }

    const tacx = await server.getPrimaryService(TACX).catch(() => null);
    if (tacx) {
      const rx = await tacx.getCharacteristic(TACX_NOTIFY);
      rx.addEventListener('characteristicvaluechanged', (e) => this._onFec(e.target.value));
      await rx.startNotifications();
      this._fec = await tacx.getCharacteristic(TACX_WRITE);
      this.protocol = 'FE-C';
      this.canControl = true;
      return;
    }

    const cps = await server.getPrimaryService(CPS).catch(() => null);
    if (cps) {
      const m = await cps.getCharacteristic(CP_MEASUREMENT);
      m.addEventListener('characteristicvaluechanged', (e) => this._onPower(e.target.value));
      await m.startNotifications();
      this.protocol = 'Power only';
      const wahoo = await cps.getCharacteristic(WAHOO_CONTROL).catch(() => null);
      if (wahoo) {
        await wahoo.startNotifications().catch(() => {});
        this._wahoo = wahoo;
        this.protocol = 'Wahoo';
        this.canControl = true;
        await this._write(wahoo, [0x20, 0xee, 0xfc]); // unlock
        this._wahooSim();
      }
      return;
    }
    throw new Error('This device does not offer a trainer or power service.');
  }

  _write(characteristic, bytes) {
    const run = () => {
      const data = Uint8Array.from(bytes);
      return characteristic.writeValueWithResponse
        ? characteristic.writeValueWithResponse(data)
        : characteristic.writeValue(data);
    };
    this._queue = this._queue.then(run, run).catch((e) => console.warn('Trainer write failed', e));
    return this._queue;
  }

  // Tell the trainer what slope to simulate (percent).
  setGrade(gradePct, crr = 0.004, cw = 0.51) {
    if (!this.connected) return;
    if (this._control) {
      const g = Math.round(gradePct * 100);
      this._write(this._control, [0x11, 0, 0, g & 0xff, (g >> 8) & 0xff, Math.round(crr / 0.0001), Math.round(cw / 0.01)]);
    } else if (this._fec) {
      const g = Math.round((gradePct + 200) / 0.01);
      const msg = [0xa4, 0x09, 0x4f, 0x05, 0x33, 0xff, 0xff, 0xff, 0xff, g & 0xff, (g >> 8) & 0xff, Math.round(crr / 0.00005)];
      msg.push(msg.reduce((a, b) => a ^ b, 0));
      this._write(this._fec, msg);
    } else if (this._wahoo) {
      this._write(this._wahoo, [0x46, ...le16(clamp16((gradePct / 100 + 1) * 32768))]);
    }
  }

  // FTMS Indoor Bike Data
  _onBikeData(v) {
    const flags = v.getUint16(0, true);
    let o = 2;
    const has = (bit) => flags & (1 << bit);
    try {
      if (!has(0)) { this.speed = v.getUint16(o, true) / 100; o += 2; }
      if (has(1)) o += 2; // average speed
      if (has(2)) { this.cadence = v.getUint16(o, true) / 2; o += 2; }
      if (has(3)) o += 2; // average cadence
      if (has(4)) o += 3; // total distance
      if (has(5)) o += 2; // resistance level
      if (has(6)) { this.power = Math.max(0, v.getInt16(o, true)); o += 2; }
    } catch (e) {
      return;
    }
    this.lastData = performance.now();
  }

  // ANT+ FE-C pages tunnelled over Tacx's BLE service
  _onFec(v) {
    if (v.byteLength < 12 || v.getUint8(0) !== 0xa4) return;
    const page = v.getUint8(4);
    if (page === 0x19) {
      const cad = v.getUint8(6);
      const pw = v.getUint8(9) | ((v.getUint8(10) & 0x0f) << 8);
      if (cad !== 0xff) this.cadence = cad;
      if (pw !== 0xfff) this.power = pw;
      this.lastData = performance.now();
    } else if (page === 0x10) {
      const sp = v.getUint16(8, true);
      if (sp !== 0xffff) this.speed = sp * 0.0036;
      this.lastData = performance.now();
    }
  }

  // Cycling Power Measurement
  _onPower(v) {
    const flags = v.getUint16(0, true);
    this.power = Math.max(0, v.getInt16(2, true));
    let o = 4;
    if (flags & 0x01) o += 1;
    if (flags & 0x04) o += 2;
    if (flags & 0x10) o += 6;
    if (flags & 0x20 && v.byteLength >= o + 4) {
      const revs = v.getUint16(o, true), time = v.getUint16(o + 2, true);
      const prev = this._crank;
      if (prev) {
        const dr = (revs - prev.revs) & 0xffff, dt = ((time - prev.time) & 0xffff) / 1024;
        if (dr > 0 && dt > 0) {
          this.cadence = (dr / dt) * 60;
          this._crank = { revs, time, at: performance.now() };
        } else if (performance.now() - prev.at > 2500) {
          this.cadence = 0;
        }
      } else {
        this._crank = { revs, time, at: performance.now() };
      }
    }
    this.lastData = performance.now();
  }
}

export class HeartRate extends Device {
  constructor() {
    super();
    this.bpm = 0;
  }

  connect() {
    return this._open({ filters: [{ services: [HRS] }] });
  }

  _reset() {
    this.bpm = 0;
  }

  async _setup() {
    const server = await this.device.gatt.connect();
    const service = await server.getPrimaryService(HRS);
    const m = await service.getCharacteristic(HR_MEASUREMENT);
    m.addEventListener('characteristicvaluechanged', (e) => {
      const v = e.target.value;
      this.bpm = v.getUint8(0) & 1 ? v.getUint16(1, true) : v.getUint8(1);
      this.lastData = performance.now();
    });
    await m.startNotifications();
  }
}
