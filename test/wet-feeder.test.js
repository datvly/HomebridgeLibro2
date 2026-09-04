const test = require('node:test');
const assert = require('node:assert/strict');
const axios = require('axios');

const {
  PetLibroPlatform,
  PetLibroWetFeeder,
  resolveWetPlate,
  assertApiOk,
  WET_FEEDER_PLATE_COUNT
} = require('..')._test;

const SERVICE_COMMUNICATION_FAILURE = -70402;

// Same shape as the stub in offline.test.js, plus subtype support: the wet
// feeder puts a SECOND Switch on the accessory, so services must be keyed by
// (type, subtype) rather than type alone.
function makeHapStub() {
  const Service = {
    AccessoryInformation: Symbol('AccessoryInformation'),
    Switch: Symbol('Switch')
  };
  const Characteristic = {
    Manufacturer: Symbol('Manufacturer'),
    Model: Symbol('Model'),
    SerialNumber: Symbol('SerialNumber'),
    FirmwareRevision: Symbol('FirmwareRevision'),
    Name: Symbol('Name'),
    On: Symbol('On')
  };
  class HapStatusError extends Error {
    constructor(hapStatus) {
      super('HAP error: ' + hapStatus);
      this.hapStatus = hapStatus;
    }
  }
  return {
    Service,
    Characteristic,
    HapStatusError,
    HAPStatus: { SERVICE_COMMUNICATION_FAILURE },
    uuid: { generate: (s) => 'uuid:' + s }
  };
}

function makeStubAccessory(hap) {
  const services = [];
  function makeService(type, subtype) {
    const characteristics = new Map();
    const svc = {
      _type: type,
      _subtype: subtype,
      setCharacteristic() { return svc; },
      getCharacteristic(cType) {
        if (!characteristics.has(cType)) {
          const c = {
            _value: undefined,
            onGet(fn) { c._getter = fn; return c; },
            onSet(fn) { c._setter = fn; return c; },
            updateValue(v) { c._value = v; return c; }
          };
          characteristics.set(cType, c);
        }
        return characteristics.get(cType);
      }
    };
    services.push(svc);
    return svc;
  }
  makeService(hap.Service.AccessoryInformation, undefined);
  return {
    displayName: 'stub',
    UUID: 'stub-uuid',
    context: {},
    getService(type) { return services.find(s => s._type === type && s._subtype === undefined); },
    getServiceById(type, subtype) { return services.find(s => s._type === type && s._subtype === subtype); },
    addService(type, _name, subtype) { return makeService(type, subtype); },
    removeService(svc) {
      const i = services.indexOf(svc);
      if (i >= 0) services.splice(i, 1);
    },
    _services: services
  };
}

function makeStubLog() {
  const log = function () {};
  log.info = log.warn = log.error = log.debug = function () {};
  return log;
}

function makePlatform(config = {}) {
  const hap = makeHapStub();
  const platform = new PetLibroPlatform(
    makeStubLog(),
    Object.assign({ email: 'u@e.com', password: 'p' }, config),
    { on() {}, hap, platformAccessory: function () {} }
  );
  platform.accessToken = 'tok';
  platform.tokenExpiry = Date.now() + 60_000;
  return { platform, hap };
}

const POLAR = {
  deviceSn: 'AF999001SYNTHETICPOLAR',
  deviceName: 'Polar Wet Food Feeder',
  productIdentifier: 'PLAF109',
  online: true
};

// --- resolveWetPlate ---------------------------------------------------

test('resolveWetPlate defaults to 1 and clamps out-of-range values', () => {
  assert.equal(resolveWetPlate({}), 1);
  assert.equal(resolveWetPlate({ wetPlate: 2 }), 2);
  assert.equal(resolveWetPlate({ wetPlate: '3' }), 3);
  assert.equal(resolveWetPlate({ wetPlate: 0 }), 1);
  assert.equal(resolveWetPlate({ wetPlate: WET_FEEDER_PLATE_COUNT + 1 }), 1);
  assert.equal(resolveWetPlate({ wetPlate: 'banana' }), 1);
});

// --- assertApiOk -------------------------------------------------------

test('assertApiOk surfaces the API code and message, not the HTTP status', () => {
  // The exact failure the Polar returned for the dry-feed endpoint.
  assert.throws(
    () => assertApiOk({ status: 200, data: { code: 2020, msg: 'Device response timeout' } }, 'Feed command'),
    /API code 2020 \(Device response timeout\)/
  );
});

test('assertApiOk accepts the legacy success shapes unchanged', () => {
  assert.doesNotThrow(() => assertApiOk({ status: 200, data: { code: 0 } }, 'x'));
  assert.doesNotThrow(() => assertApiOk({ status: 200, data: 0 }, 'x'));
  assert.doesNotThrow(() => assertApiOk({ status: 200, data: 7 }, 'x'));
});

// --- feeding -----------------------------------------------------------

test('wet feeder feeds via manualFeedNow with a plate, never the dry endpoint', async (t) => {
  const { platform, hap } = makePlatform({ wetPlate: 2 });
  const accessory = makeStubAccessory(hap);
  const feeder = new PetLibroWetFeeder(platform, accessory, POLAR);

  const calls = [];
  t.mock.method(axios, 'post', async (url, body) => {
    calls.push({ url, body });
    return { status: 200, data: { code: 0 } };
  });

  await feeder.triggerFeeding();

  assert.equal(calls.length, 1);
  assert.match(calls[0].url, /\/device\/wetFeedingPlan\/manualFeedNow$/);
  assert.equal(calls[0].body.plate, 2);
  assert.equal(calls[0].body.deviceSn, POLAR.deviceSn);
  assert.equal(typeof calls[0].body.requestId, 'string');
  assert.equal(calls[0].body.grainNum, undefined);
});

test('wet feeder surfaces code 2020 instead of a bare HTTP status', async (t) => {
  const { platform, hap } = makePlatform();
  const accessory = makeStubAccessory(hap);
  const feeder = new PetLibroWetFeeder(platform, accessory, POLAR);

  t.mock.method(axios, 'post', async () => ({
    status: 200,
    data: { code: 2020, msg: 'Device response timeout' }
  }));

  await assert.rejects(() => feeder.triggerFeeding(), /API code 2020/);
});

// --- rotation ----------------------------------------------------------

test('rotateTray posts platePositionChange once per step', async (t) => {
  const { platform, hap } = makePlatform();
  const accessory = makeStubAccessory(hap);
  const feeder = new PetLibroWetFeeder(platform, accessory, POLAR);

  const calls = [];
  t.mock.method(axios, 'post', async (url, body) => {
    calls.push({ url, body });
    return { status: 200, data: { code: 0 } };
  });

  await feeder.rotateTray(1);

  assert.equal(calls.length, 1);
  assert.match(calls[0].url, /\/device\/wetFeedingPlan\/platePositionChange$/);
  // Always 1: the endpoint is a relative single-slot step, not a destination.
  assert.equal(calls[0].body.plate, 1);
});

test('setPlatePosition converts absolute target into modular steps', async (t) => {
  const { platform, hap } = makePlatform();
  const accessory = makeStubAccessory(hap);
  const feeder = new PetLibroWetFeeder(platform, accessory, POLAR);

  let n = 0;
  t.mock.method(axios, 'post', async () => { n++; return { status: 200, data: { code: 0 } }; });

  // 1 -> 2 is one step; verified on hardware (position 1 became 2).
  assert.equal(await feeder.setPlatePosition(2, 1), 1);
  assert.equal(n, 1);

  // Wrapping backwards: 1 from 3 is one step forward on a 3-slot tray.
  n = 0;
  assert.equal(await feeder.setPlatePosition(1, 3), 1);
  assert.equal(n, 1);

  // Already there: no API call at all.
  n = 0;
  assert.equal(await feeder.setPlatePosition(2, 2), 0);
  assert.equal(n, 0);
});

test('rotate switch is exposed by default and refuses when offline', async (t) => {
  const { platform, hap } = makePlatform();
  const accessory = makeStubAccessory(hap);
  const feeder = new PetLibroWetFeeder(platform, accessory, Object.assign({}, POLAR, { online: false }));

  assert.ok(accessory.getServiceById(hap.Service.Switch, 'rotate'), 'rotate switch should exist');

  t.mock.method(axios, 'post', async () => { throw new Error('must not be called'); });

  await assert.rejects(
    () => feeder.setRotate(true),
    (err) => err instanceof hap.HapStatusError && err.hapStatus === SERVICE_COMMUNICATION_FAILURE
  );
});

test('enableTrayRotation:false omits the rotate switch', () => {
  const { platform, hap } = makePlatform({ enableTrayRotation: false });
  const accessory = makeStubAccessory(hap);
  new PetLibroWetFeeder(platform, accessory, POLAR);

  assert.equal(accessory.getServiceById(hap.Service.Switch, 'rotate'), undefined);
  // The feed switch must survive.
  assert.ok(accessory.getService(hap.Service.Switch), 'feed switch should still exist');
});

test('feed switch and rotate switch are distinct services', () => {
  const { platform, hap } = makePlatform();
  const accessory = makeStubAccessory(hap);
  new PetLibroWetFeeder(platform, accessory, POLAR);

  const feed = accessory.getService(hap.Service.Switch);
  const rotate = accessory.getServiceById(hap.Service.Switch, 'rotate');
  assert.ok(feed && rotate);
  assert.notEqual(feed, rotate);
});
