const test = require('node:test');
const assert = require('node:assert/strict');

const { getDeviceType, DEVICE_TYPE } = require('..')._test;

test('getDeviceType: PLWF deviceSn prefix → fountain', () => {
  assert.equal(getDeviceType({ deviceSn: 'PLWF105ABC123' }), DEVICE_TYPE.FOUNTAIN);
  assert.equal(getDeviceType({ deviceSn: 'plwf106xyz' }), DEVICE_TYPE.FOUNTAIN);
  assert.equal(getDeviceType({ deviceSn: 'PLWF305AAA' }), DEVICE_TYPE.FOUNTAIN);
});

test('getDeviceType: productName containing "Dockstream" → fountain', () => {
  assert.equal(getDeviceType({ productName: 'Dockstream Smart Fountain' }), DEVICE_TYPE.FOUNTAIN);
  assert.equal(getDeviceType({ productName: 'DOCKSTREAM 2' }), DEVICE_TYPE.FOUNTAIN);
});

test('getDeviceType: productName containing "Fountain" → fountain', () => {
  assert.equal(getDeviceType({ productName: 'Generic Water Fountain' }), DEVICE_TYPE.FOUNTAIN);
  assert.equal(getDeviceType({ productName: 'fountain xyz' }), DEVICE_TYPE.FOUNTAIN);
});

test('getDeviceType: case-insensitive matching', () => {
  assert.equal(getDeviceType({ productName: 'doCkStrEaM' }), DEVICE_TYPE.FOUNTAIN);
  assert.equal(getDeviceType({ deviceSn: 'plwf123' }), DEVICE_TYPE.FOUNTAIN);
});

test('getDeviceType: feeder defaults', () => {
  assert.equal(getDeviceType({ productName: 'Granary Smart Feeder', deviceSn: 'PLAF103' }), DEVICE_TYPE.FEEDER);
  assert.equal(getDeviceType({ productName: 'Air Smart Feeder', deviceSn: 'PLAF108' }), DEVICE_TYPE.FEEDER);
  assert.equal(getDeviceType({ productName: 'Granary Smart Camera Feeder', deviceSn: 'AF999002SYNTHETICDRY' }), DEVICE_TYPE.FEEDER);
});

test('getDeviceType: missing fields default to feeder', () => {
  assert.equal(getDeviceType({}), DEVICE_TYPE.FEEDER);
  assert.equal(getDeviceType({ productName: '' }), DEVICE_TYPE.FEEDER);
});

test('getDeviceType: alias field names (product_name, model)', () => {
  assert.equal(getDeviceType({ product_name: 'Dockstream' }), DEVICE_TYPE.FOUNTAIN);
  assert.equal(getDeviceType({ model: 'Water Fountain' }), DEVICE_TYPE.FOUNTAIN);
});

test('getDeviceType: alias serial field names (device_id, deviceId)', () => {
  assert.equal(getDeviceType({ device_id: 'PLWF999' }), DEVICE_TYPE.FOUNTAIN);
  assert.equal(getDeviceType({ deviceId: 'PLWF888' }), DEVICE_TYPE.FOUNTAIN);
});

test('getDeviceType: feeder model with name not matching fountain identifiers', () => {
  // Marketing/product codes from README
  for (const sn of ['PLAF103', 'PLAF107', 'PLAF108', 'PLAF109', 'PLAF203', 'PLAF301']) {
    assert.equal(
      getDeviceType({ deviceSn: sn, productName: 'Smart Feeder' }),
      DEVICE_TYPE.FEEDER,
      `Expected ${sn} to be a feeder`
    );
  }
});

// --- Real-world production data captured from a v1.5.1 deployment ---
// PetLibro's actual deviceSn values use a 2-char family code (WF/AF) NOT
// the PLWF/PLAF marketing/product code. Captured serials:
//   Fountain: WF01010302A3746E5E4D  (Dockstream Smart Fountain)
//   Feeder:  AF0304310001842024EAEY (Granary Smart Camera Feeder)
// These tests pin the real prefix contract so the classifier doesn't
// silently break when the productName fallback isn't enough.

test('getDeviceType: real-world WF-prefixed fountain serial', () => {
  assert.equal(
    getDeviceType({ deviceSn: 'WF01010302A3746E5E4D', productName: 'Dockstream Smart Fountain' }),
    DEVICE_TYPE.FOUNTAIN
  );
});

test('getDeviceType: WF-prefix alone classifies as fountain even without productName', () => {
  // Defends against future firmware that returns an empty/unknown productName
  assert.equal(getDeviceType({ deviceSn: 'WF01010302A3746E5E4D' }), DEVICE_TYPE.FOUNTAIN);
  assert.equal(getDeviceType({ deviceSn: 'wf99999999999999' }), DEVICE_TYPE.FOUNTAIN);
});

test('getDeviceType: real-world AF-prefixed feeder serial', () => {
  assert.equal(
    getDeviceType({ deviceSn: 'AF0304310001842024EAEY', productName: 'Granary Smart Camera Feeder' }),
    DEVICE_TYPE.FEEDER
  );
});

test('getDeviceType: AF-prefix alone classifies as feeder (no fountain hit)', () => {
  assert.equal(getDeviceType({ deviceSn: 'AF0304310001842024EAEY' }), DEVICE_TYPE.FEEDER);
  assert.equal(getDeviceType({ deviceSn: 'af1234567890' }), DEVICE_TYPE.FEEDER);
});

test('getDeviceType: short 2-char productName like "WF" does NOT trigger fountain (serial-only)', () => {
  // Regression guard: 'WF' must match only as a deviceSn prefix, not as a
  // productName substring. Otherwise a feeder named e.g. "WF-something"
  // would misclassify.
  assert.equal(
    getDeviceType({ productName: 'Feeder WF Edition', deviceSn: 'AF01' }),
    DEVICE_TYPE.FEEDER
  );
});


// --- Wet feeder (PLAF109 Polar) ---------------------------------------
// Superseded the old assertion that PLAF109 classified as a plain FEEDER.
// That classification is what routed the Polar to the dry-feed endpoint and
// produced API code 2020 on every tap.

test('getDeviceType: PLAF109 productIdentifier -> wet feeder', () => {
  assert.equal(getDeviceType({ productIdentifier: 'PLAF109' }), DEVICE_TYPE.WET_FEEDER);
  assert.equal(getDeviceType({ productIdentifier: 'plaf109' }), DEVICE_TYPE.WET_FEEDER);
  assert.equal(getDeviceType({ product_identifier: 'PLAF109' }), DEVICE_TYPE.WET_FEEDER);
});

test('getDeviceType: "Polar" product name -> wet feeder (no productIdentifier)', () => {
  assert.equal(getDeviceType({ productName: 'Polar Wet Food Feeder' }), DEVICE_TYPE.WET_FEEDER);
  assert.equal(getDeviceType({ productName: 'POLAR' }), DEVICE_TYPE.WET_FEEDER);
});

test('getDeviceType: real Polar payload shape -> wet feeder', () => {
  // Field shape as observed on a live PLAF109, firmware 2.0.28.
  // Serial is synthetic; only the `AF` family-code prefix is real-world shaped.
  assert.equal(getDeviceType({
    deviceSn: 'AF999001SYNTHETICPOLAR',
    productIdentifier: 'PLAF109',
    productName: 'Polar Wet Food Feeder',
    online: true
  }), DEVICE_TYPE.WET_FEEDER);
});

test('getDeviceType: AF-prefixed dry feeders are NOT misread as wet', () => {
  // Polar and Granary share the AF serial family, so the serial alone must
  // never decide this.
  assert.equal(getDeviceType({ deviceSn: 'AF999002SYNTHETICDRY', productIdentifier: 'PLAF203' }), DEVICE_TYPE.FEEDER);
  assert.equal(getDeviceType({ deviceSn: 'AF999001SYNTHETICPOLAR' }), DEVICE_TYPE.FEEDER);
});

test('getDeviceType: fountains still win over wet-feeder checks', () => {
  assert.equal(getDeviceType({ productName: 'Polar Fountain', deviceSn: 'WF01' }), DEVICE_TYPE.FOUNTAIN);
});
