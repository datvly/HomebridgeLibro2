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
    ConfiguredName: Symbol('ConfiguredName'),
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
    const optional = new Set();
    const svc = {
      _type: type,
      _subtype: subtype,
      _names: {},
      setCharacteristic(cType, value) {
        if (cType === hap.Characteristic.Name) svc._names.name = value;
        if (cType === hap.Characteristic.ConfiguredName) svc._names.configured = value;
        return svc;
      },
      testCharacteristic(cType) { return optional.has(cType); },
      addOptionalCharacteristic(cType) { optional.add(cType); return svc; },
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
    return { status: 200, data: { code: 0, data: { platePosition: 2, manualFeedId: 1 } } };
  });

  await feeder.triggerFeeding();

  const feeds = calls.filter(c => /manualFeedNow$/.test(c.url));
  assert.equal(feeds.length, 1);
  assert.equal(feeds[0].body.plate, 2);
  assert.equal(feeds[0].body.deviceSn, POLAR.deviceSn);
  assert.equal(typeof feeds[0].body.requestId, 'string');
  assert.equal(feeds[0].body.grainNum, undefined);
  // The dry-feeder endpoint must never be touched for a wet feeder.
  assert.equal(calls.filter(c => /device\/manualFeeding$/.test(c.url)).length, 0);
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


// --- per-tray switches & naming ----------------------------------------

test('exposes one momentary switch per tray, each distinctly named', () => {
  const { platform, hap } = makePlatform();
  const accessory = makeStubAccessory(hap);
  new PetLibroWetFeeder(platform, accessory, POLAR);

  const labels = [];
  for (let p = 1; p <= WET_FEEDER_PLATE_COUNT; p++) {
    const svc = accessory.getServiceById(hap.Service.Switch, `serve-${p}`);
    assert.ok(svc, `tray ${p} switch should exist`);
    labels.push(svc._names.configured);
  }
  assert.deepEqual(labels, ['Tray 1', 'Tray 2', 'Tray 3']);

  // ConfiguredName is what Apple Home renders; without it every tile on a
  // multi-service accessory shows the same fallback label.
  const rotate = accessory.getServiceById(hap.Service.Switch, 'rotate');
  assert.equal(rotate._names.configured, 'Rotate Tray');

  const feed = accessory.getService(hap.Service.Switch);
  assert.equal(feed._names.configured, 'Feed Tray 1');

  // Every visible switch must have a unique label.
  const all = [feed, rotate, ...[1,2,3].map(p => accessory.getServiceById(hap.Service.Switch, `serve-${p}`))]
    .map(s => s._names.configured);
  assert.equal(new Set(all).size, all.length, 'labels must be unique: ' + all.join(', '));
});

test('serveTray opens the tray it is given, regardless of the default', async (t) => {
  const { platform, hap } = makePlatform({ wetPlate: 1 });
  const accessory = makeStubAccessory(hap);
  const feeder = new PetLibroWetFeeder(platform, accessory, POLAR);

  const calls = [];
  t.mock.method(axios, 'post', async (url, body) => {
    calls.push(body);
    return { status: 200, data: { code: 0 } };
  });

  await feeder.serveTray(3);
  assert.equal(calls[0].plate, 3);
});

test('default tray drives the primary feed switch and its label', async (t) => {
  const { platform, hap } = makePlatform({ wetPlate: 3 });
  const accessory = makeStubAccessory(hap);
  const feeder = new PetLibroWetFeeder(platform, accessory, POLAR);

  assert.equal(accessory.getService(hap.Service.Switch)._names.configured, 'Feed Tray 3');

  const calls = [];
  t.mock.method(axios, 'post', async (url, body) => {
    calls.push(body);
    return { status: 200, data: { code: 0 } };
  });

  await feeder.triggerFeeding();
  assert.equal(calls[0].plate, 3, 'feed switch should serve the configured default');
});

test('exposeTraySwitches:false hides the per-tray switches', () => {
  const { platform, hap } = makePlatform({ exposeTraySwitches: false });
  const accessory = makeStubAccessory(hap);
  new PetLibroWetFeeder(platform, accessory, POLAR);

  for (let p = 1; p <= WET_FEEDER_PLATE_COUNT; p++) {
    assert.equal(accessory.getServiceById(hap.Service.Switch, `serve-${p}`), undefined);
  }
  assert.ok(accessory.getService(hap.Service.Switch), 'primary feed switch survives');
  assert.ok(accessory.getServiceById(hap.Service.Switch, 'rotate'), 'rotate survives');
});

test('selecting a tray while offline refuses and does not call the API', async (t) => {
  const { platform, hap } = makePlatform();
  const accessory = makeStubAccessory(hap);
  const feeder = new PetLibroWetFeeder(platform, accessory, Object.assign({}, POLAR, { online: false }));

  t.mock.method(axios, 'post', async () => { throw new Error('must not be called'); });

  await assert.rejects(
    () => feeder.setTrayActive(2, true),
    (err) => err instanceof hap.HapStatusError
  );
});


// --- lid state & tray selection ---------------------------------------

// wetListV3 keyed by `id` (NOT deviceSn -- it answers code 1002
// "id must not be null" otherwise) reports both values these controls need.
function mockWetApi(t, state, sink) {
  t.mock.method(axios, 'post', async (url, body) => {
    if (sink) sink.push({ url, body });
    if (/wetListV3$/.test(url)) {
      return { status: 200, data: { code: 0, data: {
        platePosition: state.platePosition,
        manualFeedId: state.manualFeedId
      } } };
    }
    if (/manualFeedNow$/.test(url)) { state.manualFeedId = 999; state.platePosition = body.plate; }
    if (/stopFeedNow$/.test(url)) { state.manualFeedId = null; }
    if (/platePositionChange$/.test(url)) {
      state.platePosition = (state.platePosition % WET_FEEDER_PLATE_COUNT) + 1;
    }
    return { status: 200, data: { code: 0 } };
  });
}

test('lid reports open exactly when manualFeedId is present', async (t) => {
  const { platform, hap } = makePlatform();
  const feeder = new PetLibroWetFeeder(platform, makeStubAccessory(hap), POLAR);

  const state = { platePosition: 2, manualFeedId: 666 };
  mockWetApi(t, state);
  assert.equal(await feeder.getLidOpen(), true);

  state.manualFeedId = null;
  feeder.invalidateWetState();
  assert.equal(await feeder.getLidOpen(), false);
});

test('closing the lid calls stopFeedNow with the live feedId', async (t) => {
  const { platform, hap } = makePlatform();
  const feeder = new PetLibroWetFeeder(platform, makeStubAccessory(hap), POLAR);

  const state = { platePosition: 2, manualFeedId: 4242 };
  const calls = [];
  mockWetApi(t, state, calls);

  await feeder.setLid(false);

  const stop = calls.find(c => /stopFeedNow$/.test(c.url));
  assert.ok(stop, 'stopFeedNow should have been called');
  assert.equal(stop.body.feedId, 4242);
  assert.equal(state.manualFeedId, null);
});

test('closing an already-closed lid is a no-op', async (t) => {
  const { platform, hap } = makePlatform();
  const feeder = new PetLibroWetFeeder(platform, makeStubAccessory(hap), POLAR);

  const state = { platePosition: 1, manualFeedId: null };
  const calls = [];
  mockWetApi(t, state, calls);

  await feeder.setLid(false);
  assert.equal(calls.filter(c => /stopFeedNow$/.test(c.url)).length, 0);
});

test('opening the lid serves whichever tray is currently in position', async (t) => {
  const { platform, hap } = makePlatform({ wetPlate: 1 });
  const feeder = new PetLibroWetFeeder(platform, makeStubAccessory(hap), POLAR);

  // Sitting on tray 3 while the configured default is 1 -- the lid must open
  // what the user selected, not the default.
  const state = { platePosition: 3, manualFeedId: null };
  const calls = [];
  mockWetApi(t, state, calls);

  await feeder.setLid(true);

  const feed = calls.find(c => /manualFeedNow$/.test(c.url));
  assert.ok(feed);
  assert.equal(feed.body.plate, 3);
});

test('tray switch reflects the live position', async (t) => {
  const { platform, hap } = makePlatform();
  const feeder = new PetLibroWetFeeder(platform, makeStubAccessory(hap), POLAR);

  mockWetApi(t, { platePosition: 2, manualFeedId: null });

  assert.equal(await feeder.getTrayActive(1), false);
  assert.equal(await feeder.getTrayActive(2), true);
  assert.equal(await feeder.getTrayActive(3), false);
});

test('selecting a tray rotates to it without opening the lid', async (t) => {
  const { platform, hap } = makePlatform();
  const feeder = new PetLibroWetFeeder(platform, makeStubAccessory(hap), POLAR);

  const state = { platePosition: 1, manualFeedId: null };
  const calls = [];
  mockWetApi(t, state, calls);

  await feeder.setTrayActive(3, true);

  // 1 -> 3 on a 3-slot tray is two forward steps.
  assert.equal(calls.filter(c => /platePositionChange$/.test(c.url)).length, 2);
  assert.equal(state.platePosition, 3);
  // Selecting must never dispense.
  assert.equal(calls.filter(c => /manualFeedNow$/.test(c.url)).length, 0);
  assert.equal(state.manualFeedId, null);
});

test('switching a tray off is ignored (a position is not a toggle)', async (t) => {
  const { platform, hap } = makePlatform();
  const feeder = new PetLibroWetFeeder(platform, makeStubAccessory(hap), POLAR);

  const calls = [];
  mockWetApi(t, { platePosition: 1, manualFeedId: null }, calls);

  await feeder.setTrayActive(1, false);
  assert.equal(calls.filter(c => !/wetListV3$/.test(c.url)).length, 0);
});
