// Unofficial plugin, not affiliated with PetLibro
// Use at your own risk
// Check PetLibro's ToS before use

const axios = require('axios');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

let Service, Characteristic;

// Device type constants
const DEVICE_TYPE = {
  FEEDER: 'feeder',
  FOUNTAIN: 'fountain',
  WET_FEEDER: 'wet_feeder'
};

// Fountain identification.
//
// The two checks are intentionally split so the deviceSn prefix can be
// short (2 chars) without false-positively matching arbitrary product
// names that happen to contain those letters.
//
// FOUNTAIN_NAME_KEYWORDS — case-insensitive substring match against
// productName / product_name / model.
const FOUNTAIN_NAME_KEYWORDS = ['Dockstream', 'Fountain'];

// FOUNTAIN_SERIAL_PREFIXES — case-insensitive prefix match against
// deviceSn / device_id / deviceId. Real PetLibro serials use a 2-char
// family code (e.g. WF01010302A3746E5E4D) NOT the PLWF product code
// from marketing materials. Both are kept here defensively — PLWF for
// any firmware that does prefix with the marketing code, WF for the
// observed production format.
const FOUNTAIN_SERIAL_PREFIXES = ['PLWF', 'WF'];

// Wet-feeder identification (PLAF109 "Polar").
//
// Deliberately NOT serial-prefix based: real Polar serials start with the
// same 2-char `AF` family code as every dry feeder (see the historical note
// above), so a prefix check cannot separate them. `productIdentifier` is the
// marketing code carried verbatim in /device/device/list and is the only
// reliable discriminator observed on production payloads; the name keyword
// is a fallback for firmware that omits it.
const WET_FEEDER_PRODUCT_IDENTIFIERS = ['PLAF109'];
const WET_FEEDER_NAME_KEYWORDS = ['Polar'];

// PetLibro API endpoint. The upstream HA integration (jjjonesjr33/petlibro)
// ships only the US endpoint, and api.eu.petlibro.com does not resolve
// (NXDOMAIN as of 2026-06-20) — confirmed after v1.5.0 shipped EU as a
// speculative addition and broke users whose country code routed there.
// Users on EU accounts: the US endpoint accepts EU credentials too (the
// PetLibro mobile app uses the same backend regardless of region). If
// PetLibro ever publishes a real EU endpoint, set `apiEndpoint` in config
// to override.
const API_REGIONS = {
  US: 'https://api.us.petlibro.com'
};

function resolveBaseUrl(config) {
  if (config.apiEndpoint) return config.apiEndpoint;
  return API_REGIONS.US;
}

module.exports = function(homebridge) {
  Service = homebridge.hap.Service;
  Characteristic = homebridge.hap.Characteristic;
  
  homebridge.registerPlatform("homebridge-petlibro-2", "PetLibroPlatform", PetLibroPlatform);
};

// Helper function to determine device type
function getDeviceType(device) {
  const productName = device.productName || device.product_name || device.model || '';
  const deviceSn = device.deviceSn || device.device_id || device.deviceId || '';

  const nameLower = productName.toLowerCase();
  for (const keyword of FOUNTAIN_NAME_KEYWORDS) {
    if (nameLower.includes(keyword.toLowerCase())) return DEVICE_TYPE.FOUNTAIN;
  }

  const snUpper = deviceSn.toUpperCase();
  for (const prefix of FOUNTAIN_SERIAL_PREFIXES) {
    if (snUpper.startsWith(prefix.toUpperCase())) return DEVICE_TYPE.FOUNTAIN;
  }

  // Wet feeders are checked before the generic feeder default because they
  // are a strict subset of "feeder" — they share the AF serial family and
  // only differ by product code / product name.
  const productIdentifier = device.productIdentifier || device.product_identifier || '';
  const pidUpper = productIdentifier.toUpperCase();
  for (const pid of WET_FEEDER_PRODUCT_IDENTIFIERS) {
    if (pidUpper === pid.toUpperCase()) return DEVICE_TYPE.WET_FEEDER;
  }
  for (const keyword of WET_FEEDER_NAME_KEYWORDS) {
    if (nameLower.includes(keyword.toLowerCase())) return DEVICE_TYPE.WET_FEEDER;
  }

  // Default to feeder
  return DEVICE_TYPE.FEEDER;
}

// Number of slots on the Polar's rotating tray. platePositionChange advances
// exactly one slot per call, so absolute positioning is (target - current)
// modulo this value.
const WET_FEEDER_PLATE_COUNT = 3;

// Cooldown between consecutive rotation steps, mirroring the upstream HA
// integration. The tray motor does not queue commands; firing them back to
// back drops steps.
const PLATE_ROTATION_COOLDOWN_MS = 600;

// How long a wetListV3 read stays fresh. Apple Home fires onGet for every
// switch on an accessory at once when its tile opens; without a short cache
// that is one cloud round-trip per switch.
const WET_STATE_TTL_MS = 8000;

function resolveWetPlate(config) {
  const raw = parseInt((config && config.wetPlate) || 1, 10);
  if (!Number.isFinite(raw) || raw < 1 || raw > WET_FEEDER_PLATE_COUNT) return 1;
  return raw;
}

// Shared PetLibro response validator.
//
// The API answers HTTP 200 even for device-level failures, carrying the real
// outcome in the body as `code` (0 = success). The previous inline check threw
// `Feed command failed with status 200`, which named the HTTP status and hid
// the API code that actually explains the failure — e.g. 2020 "Device response
// timeout" when a dry-feed command is sent to a wet feeder. Success semantics
// are unchanged; only the error message gained the code and message.
function assertApiOk(response, action) {
  if (response && response.status === 200) {
    const data = response.data;
    if (typeof data === 'number' || (data && data.code === 0) || data === 0) return;
    if (data && typeof data.code !== 'undefined') {
      const msg = data.msg ? ` (${data.msg})` : '';
      throw new Error(`${action} failed: API code ${data.code}${msg}`);
    }
    throw new Error(`${action} failed: unrecognized API response shape`);
  }
  throw new Error(`${action} failed with status ${response ? response.status : 'unknown'}`);
}

function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// Name a service so Apple Home actually shows the label.
//
// Setting only `Name` is not enough once an accessory carries more than one
// service of the same type: Home renders `ConfiguredName`, and without it every
// tile falls back to the accessory name — so N switches all display identically
// and there is no way to tell which is which.
function setServiceName(hap, service, name) {
  service.setCharacteristic(hap.Characteristic.Name, name);
  const Configured = hap.Characteristic.ConfiguredName;
  if (!Configured) return; // older HAP: Name is the best available
  try {
    if (service.testCharacteristic && !service.testCharacteristic(Configured)) {
      service.addOptionalCharacteristic(Configured);
    }
    service.setCharacteristic(Configured, name);
  } catch (err) {
    // Never let a cosmetic naming failure abort accessory setup.
  }
}

class PetLibroPlatform {
  constructor(log, config, api) {
    this.log = log;
    this.config = config;
    this.api = api;
    this.accessories = [];
    this.deviceInstances = new Map(); // Track active device instances
    
    // Shared authentication state across all devices
    this.accessToken = null;
    this.tokenExpiry = null;
    
    // PetLibro API configuration
    this.email = this.config.email;
    this.password = this.config.password;
    this.baseUrl = resolveBaseUrl(this.config);

    // Token persistence across Homebridge restarts. Mirrors upstream HA
    // integration, which stores the token in config_entry.data so restarts
    // don't fire a fresh /member/auth/login — important because PetLibro
    // enforces one active session per account, and every fresh login kicks
    // the mobile app out.
    this.tokenFilePath = this.resolveTokenFilePath();
    this.loadPersistedToken();

    this.api.on('didFinishLaunching', () => {
      this.discoverDevices();
    });
  }

  // Derives a stable per-account filename. Hash the email so the filesystem
  // path doesn't disclose the account address; truncate for compactness.
  resolveTokenFilePath() {
    if (!this.email || !this.api || !this.api.user || typeof this.api.user.storagePath !== 'function') {
      return null;
    }
    const emailHash = crypto.createHash('sha256').update(this.email).digest('hex').slice(0, 16);
    return path.join(this.api.user.storagePath(), `petlibro-token-${emailHash}.json`);
  }

  loadPersistedToken() {
    if (!this.tokenFilePath) return;
    try {
      const raw = fs.readFileSync(this.tokenFilePath, 'utf8');
      const data = JSON.parse(raw);
      // Require >60s of headroom so we don't load a token that's about to
      // expire mid-request.
      if (
        data &&
        typeof data.token === 'string' &&
        typeof data.expiry === 'number' &&
        data.expiry > Date.now() + 60_000
      ) {
        this.accessToken = data.token;
        this.tokenExpiry = data.expiry;
        this.log.debug('Loaded persisted PetLibro auth token from disk');
      }
    } catch (err) {
      // Missing or corrupt file is fine — we'll authenticate fresh.
    }
  }

  persistToken() {
    if (!this.tokenFilePath || !this.accessToken || !this.tokenExpiry) return;
    try {
      const payload = JSON.stringify({ token: this.accessToken, expiry: this.tokenExpiry });
      fs.writeFileSync(this.tokenFilePath, payload, { mode: 0o600 });
    } catch (err) {
      this.log.warn('Failed to persist auth token:', err.message);
    }
  }
  
  configureAccessory(accessory) {
    this.log.info('Loading accessory from cache:', accessory.displayName);
    this.accessories.push(accessory);
  }
  
  // Hash password like the HomeAssistant plugin does
  hashPassword(password) {
    return crypto.createHash('md5').update(password).digest('hex');
  }
  
  async authenticate() {
    if (!this.email || !this.password) {
      throw new Error('Email and password are required in config');
    }

    try {
      this.log('Authenticating with PetLibro API...');
      
      const payload = {
        appId: 1,
        appSn: 'c35772530d1041699c87fe62348507a8',
        country: this.config.country || 'US',
        email: this.email,
        password: this.hashPassword(this.password),
        phoneBrand: '',
        phoneSystemVersion: '',
        timezone: this.config.timezone || 'America/New_York',
        thirdId: null,
        type: null
      };
      
      const response = await axios.post(`${this.baseUrl}/member/auth/login`, payload, {
        headers: {
          'Content-Type': 'application/json',
          'User-Agent': 'PetLibro/1.3.45',
          'Accept': 'application/json',
          'Accept-Language': 'en-US',
          'source': 'ANDROID',
          'language': 'EN',
          'timezone': payload.timezone,
          'version': '1.3.45'
        },
        timeout: 10000
      });
      
      const data = response.data;
      if (data && data.code === 0) {
        if (data.data && data.data.token) {
          this.accessToken = data.data.token;

          const expiresIn = data.data.expires_in || 3600;
          this.tokenExpiry = Date.now() + (expiresIn * 1000);

          this.persistToken();

          this.log('Authentication successful!');
          return;
        } else {
          throw new Error('Authentication succeeded but no token found in data.token');
        }
      } else if (data && data.code) {
        const errorMsg = data.msg || data.message || 'Unknown error';
        throw new Error(`Authentication failed: ${errorMsg} (code: ${data.code})`);
      } else {
        throw new Error('Unexpected response format');
      }
      
    } catch (error) {
      this.log.error('Authentication failed:', error.message);
      if (error.response) {
        this.log.error('   Status:', error.response.status);
        this.log.error('   Data:', JSON.stringify(error.response.data, null, 2));
      }
      throw error;
    }
  }
  
  async ensureAuthenticated() {
    if (!this.accessToken || !this.tokenExpiry || Date.now() >= this.tokenExpiry) {
      await this.authenticate();
    }
  }

  // Single entry point for all authenticated API calls.
  // Sends only `token` header (matches upstream HA integration).
  // On code 1009 (NOT_YET_LOGIN) the server has invalidated the token early
  // (commonly: another login on the same account); re-authenticate and retry once.
  async apiPost(path, body = {}, { timeout = 10000 } = {}) {
    await this.ensureAuthenticated();

    const buildHeaders = () => ({
      'Content-Type': 'application/json',
      'token': this.accessToken,
      'source': 'ANDROID',
      'language': 'EN',
      'timezone': this.config.timezone || 'America/New_York',
      'version': '1.3.45'
    });

    const url = `${this.baseUrl}${path}`;
    let response = await axios.post(url, body, { headers: buildHeaders(), timeout });

    if (response.data && response.data.code === 1009) {
      this.log.warn(`Token rejected by ${path} (code 1009 NOT_YET_LOGIN), re-authenticating...`);
      await this.authenticate();
      response = await axios.post(url, body, { headers: buildHeaders(), timeout });
    }

    return response;
  }

  // Fetch real-time device info (used for water level, etc.)
  async fetchDeviceRealInfo(deviceSn) {
    try {
      // Upstream HA integration sends both `id` and `deviceSn` for serial-keyed endpoints
      const response = await this.apiPost('/device/device/realInfo', {
        id: deviceSn,
        deviceSn: deviceSn
      });

      if (response.data && response.data.code === 0 && response.data.data) {
        return response.data.data;
      }
      return null;
    } catch (error) {
      this.log.error(`Failed to fetch real info for ${deviceSn}:`, error.message);
      return null;
    }
  }

  async fetchDevicesFromAPI() {
    try {
      this.log('Fetching device list from PetLibro API...');
      const response = await this.apiPost('/device/device/list', {});

      if (response.data && response.data.code === 0 && response.data.data) {
        const devices = response.data.data;

        // Opt-in raw payload dump for unsupported-device bug reports.
        // Safe to log: /device/device/list contains device metadata only,
        // no credentials, no tokens.
        if (this.config.debugDeviceDump) {
          this.log.info(
            '[debugDeviceDump] Raw /device/device/list response:\n' +
            JSON.stringify(devices, null, 2)
          );
        }

        if (Array.isArray(devices) && devices.length > 0) {
          this.log(`Found ${devices.length} device(s) in PetLibro account`);
          return devices;
        } else {
          this.log.warn('No devices found in PetLibro account');
          return [];
        }
      } else if (response.data && response.data.code !== 0) {
        const errorMsg = response.data.msg || 'Unknown error';
        throw new Error(`Device list API error: ${errorMsg} (code: ${response.data.code})`);
      } else {
        throw new Error('Unexpected response format from device list endpoint');
      }
      
    } catch (error) {
      this.log.error('Failed to get devices:', error.message);
      if (error.response) {
        this.log.error('   Status:', error.response.status);
        this.log.error('   Data:', JSON.stringify(error.response.data, null, 2));
      }
      throw error;
    }
  }
  
  async discoverDevices() {
    try {
      // Authenticate first
      await this.authenticate();
      
      // Fetch all devices from the API
      const devices = await this.fetchDevicesFromAPI();
      
      if (devices.length === 0) {
        this.log.warn('No devices found to configure');
        return;
      }
      
      // Track which UUIDs we found in the API
      const foundUUIDs = new Set();
      const newAccessories = [];
      
      // Create/update accessories for each device
      for (const device of devices) {
        const deviceSn = device.deviceSn || device.device_id || device.deviceId || device.id || device.serial;
        const deviceName = device.deviceName || device.device_name || device.name || 'PetLibro Device';
        const deviceModel = device.productName || device.product_name || device.model || 'Smart Device';
        const deviceType = getDeviceType(device);
        
        if (!deviceSn) {
          this.log.warn('Device found without serial number, skipping:', JSON.stringify(device));
          continue;
        }
        
        this.log.info(`Discovered ${deviceType}: ${deviceName} (${deviceModel}) - ${deviceSn}`);
        
        const uuid = this.api.hap.uuid.generate('petlibro-' + deviceType + '-' + deviceSn);
        foundUUIDs.add(uuid);
        
        const existingAccessory = this.accessories.find(accessory => accessory.UUID === uuid);
        
        if (existingAccessory) {
          this.log.info('Restoring existing accessory from cache:', existingAccessory.displayName);
          // Update the context with latest device info
          existingAccessory.context.device = device;
          existingAccessory.context.deviceType = deviceType;
          
          if (deviceType === DEVICE_TYPE.FOUNTAIN) {
            new PetLibroFountain(this, existingAccessory, device);
          } else if (deviceType === DEVICE_TYPE.WET_FEEDER) {
            new PetLibroWetFeeder(this, existingAccessory, device);
          } else {
            new PetLibroFeeder(this, existingAccessory, device);
          }
          this.deviceInstances.set(uuid, existingAccessory);
        } else {
          this.log.info('Adding new accessory:', deviceName, `(${deviceSn})`);
          const accessory = new this.api.platformAccessory(deviceName, uuid);
          accessory.context.device = device;
          accessory.context.deviceType = deviceType;
          
          if (deviceType === DEVICE_TYPE.FOUNTAIN) {
            new PetLibroFountain(this, accessory, device);
          } else if (deviceType === DEVICE_TYPE.WET_FEEDER) {
            new PetLibroWetFeeder(this, accessory, device);
          } else {
            new PetLibroFeeder(this, accessory, device);
          }
          newAccessories.push(accessory);
          this.deviceInstances.set(uuid, accessory);
        }
      }
      
      // Register all new accessories at once
      if (newAccessories.length > 0) {
        this.api.registerPlatformAccessories("homebridge-petlibro-2", "PetLibroPlatform", newAccessories);
        this.log.info(`Registered ${newAccessories.length} new accessory(s)`);
      }
      
      // Remove accessories that are no longer in the API
      const accessoriesToRemove = this.accessories.filter(accessory => !foundUUIDs.has(accessory.UUID));
      if (accessoriesToRemove.length > 0) {
        this.log.info(`Removing ${accessoriesToRemove.length} accessory(s) no longer in account`);
        this.api.unregisterPlatformAccessories("homebridge-petlibro-2", "PetLibroPlatform", accessoriesToRemove);
      }
      
    } catch (error) {
      this.log.error('Failed to discover devices:', error.message);
      // Don't throw - let Homebridge continue with other plugins
    }
  }
}

class PetLibroFeeder {
  constructor(platform, accessory, device) {
    this.platform = platform;
    this.accessory = accessory;
    this.log = platform.log;
    this.config = platform.config;
    this.device = device;
    
    // Extract device info
    this.deviceId = device.deviceSn || device.device_id || device.deviceId || device.id || device.serial;
    this.name = device.deviceName || device.device_name || device.name || 'Pet Feeder';
    this.model = device.productName || device.product_name || device.model || 'Smart Feeder';
    
    // Set accessory information
    this.accessory.getService(this.platform.api.hap.Service.AccessoryInformation)
      .setCharacteristic(this.platform.api.hap.Characteristic.Manufacturer, 'PetLibro')
      .setCharacteristic(this.platform.api.hap.Characteristic.Model, this.model)
      .setCharacteristic(this.platform.api.hap.Characteristic.SerialNumber, this.deviceId || 'Unknown')
      .setCharacteristic(this.platform.api.hap.Characteristic.FirmwareRevision, device.firmwareVersion || device.firmware_version || '1.0.0');
    
    // Get or create the switch service
    this.switchService = this.accessory.getService(this.platform.api.hap.Service.Switch) 
      || this.accessory.addService(this.platform.api.hap.Service.Switch);
    
    this.switchService.setCharacteristic(this.platform.api.hap.Characteristic.Name, this.name);
    
    this.switchService.getCharacteristic(this.platform.api.hap.Characteristic.On)
      .onGet(this.getOn.bind(this))
      .onSet(this.setOn.bind(this));
    
    this.log.info(`Initialized ${this.deviceLabel}: ${this.name} (${this.deviceId})`);
  }

  // Overridden by subclasses so the constructor's log line names the concrete
  // device kind instead of every variant announcing itself as a plain feeder.
  get deviceLabel() {
    return 'feeder';
  }

  async getOn() {
    // Always return false since this is a momentary switch for feeding
    return false;
  }
  
  async setOn(value) {
    if (value) {
      this.log(`[${this.name}] Feed button tapped! Triggering manual feeding...`);

      // Mirror upstream HA integration: if PetLibro reports the device offline
      // in /device/device/list, surface "Not Responding" in Apple Home rather
      // than firing a feed command that will silently fail server-side.
      if (this.device && this.device.online === false) {
        this.log.warn(`[${this.name}] Device reports offline; refusing to send feed command`);
        setTimeout(() => {
          this.switchService
            .getCharacteristic(this.platform.api.hap.Characteristic.On)
            .updateValue(false);
        }, 100);
        const hap = this.platform.api.hap;
        if (hap.HapStatusError && hap.HAPStatus) {
          throw new hap.HapStatusError(hap.HAPStatus.SERVICE_COMMUNICATION_FAILURE);
        }
        throw new Error('Device offline');
      }

      try {
        await this.triggerFeeding();
        this.log(`[${this.name}] Feeding command completed successfully`);
        
        // Reset switch to off after 1 second (momentary behavior)
        setTimeout(() => {
          this.switchService
            .getCharacteristic(this.platform.api.hap.Characteristic.On)
            .updateValue(false);
        }, 1000);
      } catch (error) {
        this.log.error(`[${this.name}] Failed to trigger feeding:`, error.message);
        
        // Reset switch to off immediately on error
        setTimeout(() => {
          this.switchService
            .getCharacteristic(this.platform.api.hap.Characteristic.On)
            .updateValue(false);
        }, 100);
      }
    }
  }
  
  async triggerFeeding() {
    if (!this.deviceId) {
      throw new Error('Device ID not found - cannot send feed command');
    }

    const portions = parseInt(this.config.portions || 1);
    this.log(`[${this.name}] Sending manual feed command (${portions} portion(s))`);

    const feedData = {
      deviceSn: this.deviceId,
      grainNum: portions,
      requestId: this.generateRequestId()
    };

    const response = await this.platform.apiPost('/device/device/manualFeeding', feedData, { timeout: 15000 });

    assertApiOk(response, 'Feed command');
    this.log(`[${this.name}] Manual feeding triggered successfully!`);
  }
  
  generateRequestId() {
    // Mirrors upstream HA integration, which uses uuid.uuid4() — crypto-grade
    // randomness instead of two stitched Math.random() slices.
    return crypto.randomUUID();
  }
  
  getServices() {
    return [this.informationService, this.switchService];
  }
}

// PLAF109 "Polar" wet food feeder.
//
// Mechanically unlike the dry feeders: food sits in a 3-slot rotating tray
// under a lid, so "feed" means "bring the requested slot to the opening and
// open the lid", not "auger N portions". The dry-feed endpoint is rejected
// outright — /device/device/manualFeeding answers HTTP 200 with API code 2020
// ("Device response timeout") because the firmware never replies to a
// grainNum command. Verified against a live PLAF109 (firmware 2.0.28) on
// 2026-09-04, alongside these two working endpoints:
//
//   /device/wetFeedingPlan/manualFeedNow        {deviceSn, plate}  -> code 0
//   /device/wetFeedingPlan/platePositionChange  {deviceSn, plate:1} -> code 0
//
// platePositionChange advances exactly ONE slot per call regardless of the
// `plate` value sent; it is a relative step, not a destination. Re-serving an
// already-served slot returns code 0, so the mobile app's "cannot reopen a
// used slot" restriction is client-side only and is not enforced here.
// PLAF109 "Polar" wet food feeder.
//
// Mechanically unlike the dry feeders: food sits in a 3-slot rotating tray
// under a lid, so "feed" means "bring a slot to the opening and open the lid",
// not "auger N portions". The dry-feed endpoint is rejected outright --
// /device/device/manualFeeding answers HTTP 200 with API code 2020
// ("Device response timeout") because the firmware never replies to a grainNum
// command. Verified against a live PLAF109 (firmware 2.0.28) on 2026-09-04:
//
//   manualFeedNow       {deviceSn, plate}   -> code 0, rotates AND opens
//   platePositionChange {deviceSn, plate:1} -> code 0, advances ONE slot only
//   stopFeedNow         {deviceSn, feedId}  -> code 0, closes the lid
//   wetListV3           {id}                -> platePosition + manualFeedId
//
// Two things drive the HomeKit layout here. platePositionChange is a relative
// step whose `plate` value is ignored as a target, and it never opens the lid;
// and wetListV3 reports both the current slot and whether a feed is open
// (manualFeedId is null exactly when the lid is shut). That makes tray position
// and lid state genuinely observable, so both are modelled as stateful
// switches rather than write-only buttons: Tray 1/2/3 show which slot is
// current and rotate to it when tapped, and Lid reflects and controls whether
// that slot is open. Re-opening an already-served slot returns code 0, so the
// mobile app's "cannot reopen a used slot" rule is client-side and not
// reproduced here.
class PetLibroWetFeeder extends PetLibroFeeder {
  constructor(platform, accessory, device) {
    super(platform, accessory, device);

    this.plate = resolveWetPlate(this.config);
    this._wetState = null;
    this._wetStateAt = 0;

    const hap = this.platform.api.hap;
    const rotationEnabled = this.config.enableTrayRotation !== false;
    const traySwitches = this.config.exposeTraySwitches !== false;

    // Inherited subtype-less switch: one-tap "rotate to the default tray and
    // open it", kept so Siri and existing automations have an obvious target.
    setServiceName(hap, this.switchService, `Feed Tray ${this.plate}`);

    // Stateful lid control. This is the half that was missing: stopFeedNow
    // works, but nothing exposed it, so a lid could be opened and never shut
    // from HomeKit.
    this.lidService = this.accessory.getServiceById(hap.Service.Switch, 'lid')
      || this.accessory.addService(hap.Service.Switch, 'Lid', 'lid');
    setServiceName(hap, this.lidService, 'Lid');
    this.lidService.getCharacteristic(hap.Characteristic.On)
      .onGet(this.getLidOpen.bind(this))
      .onSet(this.setLid.bind(this));

    // Tray selector: rotate to a slot WITHOUT opening it.
    this.trayServices = new Map();
    for (let plate = 1; plate <= WET_FEEDER_PLATE_COUNT; plate++) {
      const subtype = `serve-${plate}`;
      const existing = this.accessory.getServiceById(hap.Service.Switch, subtype);

      if (!traySwitches) {
        if (existing) this.accessory.removeService(existing);
        continue;
      }

      const svc = existing
        || this.accessory.addService(hap.Service.Switch, `Tray ${plate}`, subtype);
      setServiceName(hap, svc, `Tray ${plate}`);
      svc.getCharacteristic(hap.Characteristic.On)
        .onGet(() => this.getTrayActive(plate))
        .onSet((value) => this.setTrayActive(plate, value));
      this.trayServices.set(plate, svc);
    }

    if (rotationEnabled) {
      this.rotateService = this.accessory.getServiceById(hap.Service.Switch, 'rotate')
        || this.accessory.addService(hap.Service.Switch, 'Rotate Tray', 'rotate');
      setServiceName(hap, this.rotateService, 'Rotate Tray');
      this.rotateService.getCharacteristic(hap.Characteristic.On)
        .onGet(async () => false)
        .onSet(this.setRotate.bind(this));
    } else {
      const stale = this.accessory.getServiceById(hap.Service.Switch, 'rotate');
      if (stale) this.accessory.removeService(stale);
    }

    this.log.info(`  default tray ${this.plate}, per-tray switches ${traySwitches ? 'enabled' : 'disabled'}, rotation ${rotationEnabled ? 'enabled' : 'disabled'}`);
  }

  get deviceLabel() {
    return 'wet feeder';
  }

  // --- state ------------------------------------------------------------

  // Current tray position and lid state. Briefly cached: Apple Home fires
  // onGet for every switch at once when the tile opens, and without this each
  // one would issue its own cloud round-trip.
  async fetchWetState(force = false) {
    const now = Date.now();
    if (!force && this._wetState && (now - this._wetStateAt) < WET_STATE_TTL_MS) {
      return this._wetState;
    }
    const response = await this.platform.apiPost('/device/wetFeedingPlan/wetListV3', {
      id: this.deviceId
    }, { timeout: 15000 });
    assertApiOk(response, 'Wet feeder state');

    const data = (response.data && response.data.data) || {};
    this._wetState = {
      platePosition: typeof data.platePosition === 'number' ? data.platePosition : null,
      // Null exactly when the lid is shut.
      manualFeedId: (data.manualFeedId === undefined) ? null : data.manualFeedId
    };
    this._wetStateAt = now;
    return this._wetState;
  }

  invalidateWetState() {
    this._wetState = null;
    this._wetStateAt = 0;
  }

  requireOnline(action) {
    if (this.device && this.device.online === false) {
      this.log.warn(`[${this.name}] Device reports offline; refusing to ${action}`);
      const hap = this.platform.api.hap;
      if (hap.HapStatusError && hap.HAPStatus) {
        throw new hap.HapStatusError(hap.HAPStatus.SERVICE_COMMUNICATION_FAILURE);
      }
      throw new Error('Device offline');
    }
  }

  // Push fresh values into every stateful characteristic after a change.
  async refreshCharacteristics() {
    const hap = this.platform.api.hap;
    try {
      const state = await this.fetchWetState(true);
      if (this.lidService) {
        this.lidService.getCharacteristic(hap.Characteristic.On)
          .updateValue(state.manualFeedId != null);
      }
      for (const [plate, svc] of this.trayServices) {
        svc.getCharacteristic(hap.Characteristic.On)
          .updateValue(state.platePosition === plate);
      }
    } catch (error) {
      this.log.debug(`[${this.name}] Could not refresh state: ${error.message}`);
    }
  }

  // --- lid --------------------------------------------------------------

  async getLidOpen() {
    const state = await this.fetchWetState();
    return state.manualFeedId != null;
  }

  async setLid(value) {
    this.requireOnline(value ? 'open the lid' : 'close the lid');
    try {
      const state = await this.fetchWetState(true);
      if (value) {
        // Open whichever tray is currently in position, so "pick a tray, then
        // open it" behaves the way the tray switches imply.
        const plate = state.platePosition || this.plate;
        await this.serveTray(plate);
        this.log(`[${this.name}] Lid opened on tray ${plate}`);
      } else {
        if (state.manualFeedId == null) {
          this.log(`[${this.name}] Lid already closed`);
          return;
        }
        await this.stopFeed(state.manualFeedId);
        this.log(`[${this.name}] Lid closed`);
      }
      this.invalidateWetState();
      await this.refreshCharacteristics();
    } catch (error) {
      this.log.error(`[${this.name}] Failed to ${value ? 'open' : 'close'} lid:`, error.message);
      this.invalidateWetState();
      await this.refreshCharacteristics();
      const hap = this.platform.api.hap;
      if (hap.HapStatusError && hap.HAPStatus) {
        throw new hap.HapStatusError(hap.HAPStatus.SERVICE_COMMUNICATION_FAILURE);
      }
      throw error;
    }
  }

  async stopFeed(feedId) {
    const response = await this.platform.apiPost('/device/wetFeedingPlan/stopFeedNow', {
      deviceSn: this.deviceId,
      feedId,
      requestId: this.generateRequestId()
    }, { timeout: 15000 });
    assertApiOk(response, 'Close lid');
  }

  // --- tray selection ---------------------------------------------------

  async getTrayActive(plate) {
    const state = await this.fetchWetState();
    return state.platePosition === plate;
  }

  async setTrayActive(plate, value) {
    const hap = this.platform.api.hap;

    // A tray is a position, not a toggle: switching one "off" has no meaning.
    // Snap the characteristic back to the truth instead of silently accepting.
    if (!value) {
      setTimeout(() => this.refreshCharacteristics(), 100);
      return;
    }

    this.requireOnline(`rotate to tray ${plate}`);

    try {
      const state = await this.fetchWetState(true);
      const current = state.platePosition;
      if (current == null) {
        throw new Error('current tray position unknown');
      }
      const steps = await this.setPlatePosition(plate, current);
      this.log(`[${this.name}] Tray ${plate} selected (${steps} step(s) from ${current})`);
      this.invalidateWetState();
      await this.refreshCharacteristics();
    } catch (error) {
      this.log.error(`[${this.name}] Failed to select tray ${plate}:`, error.message);
      this.invalidateWetState();
      await this.refreshCharacteristics();
      if (hap.HapStatusError && hap.HAPStatus) {
        throw new hap.HapStatusError(hap.HAPStatus.SERVICE_COMMUNICATION_FAILURE);
      }
      throw error;
    }
  }

  // --- feeding ----------------------------------------------------------

  async triggerFeeding() {
    if (!this.deviceId) {
      throw new Error('Device ID not found - cannot send feed command');
    }
    // `portions` is a dry-feeder concept (auger revolutions) and has no
    // meaning here; the tray slot is the unit of service.
    this.log(`[${this.name}] Sending wet feed command (default tray ${this.plate})`);
    await this.serveTray(this.plate);
    this.log(`[${this.name}] Wet feeding triggered successfully (tray ${this.plate})`);
    this.invalidateWetState();
    await this.refreshCharacteristics();
  }

  // Rotate the given tray into place and open the lid on it. Re-serving an
  // already-served tray is permitted by the server (verified: code 0).
  async serveTray(plate) {
    if (!this.deviceId) {
      throw new Error('Device ID not found - cannot send feed command');
    }
    const response = await this.platform.apiPost('/device/wetFeedingPlan/manualFeedNow', {
      deviceSn: this.deviceId,
      plate,
      requestId: this.generateRequestId()
    }, { timeout: 15000 });
    assertApiOk(response, `Serve tray ${plate}`);
  }

  // --- rotation ---------------------------------------------------------

  // Advance the tray one slot. Momentary: rotation is a nudge, not a state.
  async setRotate(value) {
    if (!value) return;

    const hap = this.platform.api.hap;
    const reset = (ms) => setTimeout(() => {
      this.rotateService.getCharacteristic(hap.Characteristic.On).updateValue(false);
    }, ms);

    if (this.device && this.device.online === false) {
      this.log.warn(`[${this.name}] Device reports offline; refusing to send rotate command`);
      reset(100);
      if (hap.HapStatusError && hap.HAPStatus) {
        throw new hap.HapStatusError(hap.HAPStatus.SERVICE_COMMUNICATION_FAILURE);
      }
      throw new Error('Device offline');
    }

    try {
      await this.rotateTray(1);
      this.log(`[${this.name}] Tray rotation completed`);
      reset(1000);
      this.invalidateWetState();
      await this.refreshCharacteristics();
    } catch (error) {
      this.log.error(`[${this.name}] Failed to rotate tray:`, error.message);
      reset(100);
    }
  }

  // Advance the tray `steps` slots, one API call per slot.
  async rotateTray(steps = 1) {
    if (!this.deviceId) {
      throw new Error('Device ID not found - cannot send rotate command');
    }

    for (let i = 0; i < steps; i++) {
      const response = await this.platform.apiPost('/device/wetFeedingPlan/platePositionChange', {
        deviceSn: this.deviceId,
        plate: 1,
        requestId: this.generateRequestId()
      }, { timeout: 15000 });

      assertApiOk(response, 'Tray rotation');

      if (i < steps - 1) await delay(PLATE_ROTATION_COOLDOWN_MS);
    }
  }

  // Absolute positioning built on the relative step primitive.
  async setPlatePosition(target, current) {
    const t = parseInt(target, 10);
    const c = parseInt(current, 10);
    if (!Number.isFinite(t) || !Number.isFinite(c)) {
      throw new Error('setPlatePosition requires numeric target and current positions');
    }
    const steps = ((t - c) % WET_FEEDER_PLATE_COUNT + WET_FEEDER_PLATE_COUNT) % WET_FEEDER_PLATE_COUNT;
    if (steps === 0) return 0;
    await this.rotateTray(steps);
    return steps;
  }
}


class PetLibroFountain {
  constructor(platform, accessory, device) {
    this.platform = platform;
    this.accessory = accessory;
    this.log = platform.log;
    this.config = platform.config;
    this.device = device;
    
    // Extract device info
    this.deviceId = device.deviceSn || device.device_id || device.deviceId || device.id || device.serial;
    this.name = device.deviceName || device.device_name || device.name || 'Water Fountain';
    this.model = device.productName || device.product_name || device.model || 'Smart Fountain';
    
    // Water level state
    this.waterLevel = 100;
    this.lastUpdate = null;
    // Mirror upstream HA integration: track realInfo.online and surface
    // "Not Responding" in Apple Home when the fountain drops offline.
    this.online = true;
    
    // Polling interval (default: 5 minutes)
    this.pollingInterval = (this.config.fountainPollingInterval || 300) * 1000;
    
    // Set accessory information
    this.accessory.getService(this.platform.api.hap.Service.AccessoryInformation)
      .setCharacteristic(this.platform.api.hap.Characteristic.Manufacturer, 'PetLibro')
      .setCharacteristic(this.platform.api.hap.Characteristic.Model, this.model)
      .setCharacteristic(this.platform.api.hap.Characteristic.SerialNumber, this.deviceId || 'Unknown')
      .setCharacteristic(this.platform.api.hap.Characteristic.FirmwareRevision, device.firmwareVersion || device.firmware_version || '1.0.0');
    
    // Migrations: strip legacy/cross-type services from cached accessories
    // (prior versions used Battery; feeder->fountain type swaps leave a Switch behind)
    const existingBatteryService = this.accessory.getService(this.platform.api.hap.Service.Battery);
    if (existingBatteryService) {
      this.accessory.removeService(existingBatteryService);
    }
    const existingSwitchService = this.accessory.getService(this.platform.api.hap.Service.Switch);
    if (existingSwitchService) {
      this.accessory.removeService(existingSwitchService);
    }

    // HomeKit has no native fill-level characteristic. Sensor services are the
    // only ones that render as a visible tile in Apple Home; HumiditySensor's
    // 0-100% range maps directly onto water-reservoir percent. Mislabeled as
    // "Humidity" in Apple Home but the live value is visible at a glance.
    this.humidityService = this.accessory.getService(this.platform.api.hap.Service.HumiditySensor)
      || this.accessory.addService(this.platform.api.hap.Service.HumiditySensor);

    this.humidityService.setCharacteristic(this.platform.api.hap.Characteristic.Name, `${this.name} Water Level`);

    this.humidityService.getCharacteristic(this.platform.api.hap.Characteristic.CurrentRelativeHumidity)
      .onGet(this.getWaterLevel.bind(this));
    
    this.log.info(`Initialized fountain: ${this.name} (${this.deviceId})`);
    
    // Initial water level fetch
    this.updateWaterLevel();
    
    // Start polling for water level updates
    this.startPolling();
  }
  
  async getWaterLevel() {
    if (this.online === false) {
      const hap = this.platform.api.hap;
      if (hap.HapStatusError && hap.HAPStatus) {
        throw new hap.HapStatusError(hap.HAPStatus.SERVICE_COMMUNICATION_FAILURE);
      }
      throw new Error('Fountain offline');
    }
    // Return cached value; polling refreshes it
    return this.waterLevel;
  }

  async updateWaterLevel() {
    try {
      const realInfo = await this.platform.fetchDeviceRealInfo(this.deviceId);

      if (realInfo) {
        // Track online state alongside water level; realInfo.online may be
        // absent on some firmware revisions — treat absence as "online" to
        // avoid spurious "Not Responding" on devices that don't report it.
        if (typeof realInfo.online === 'boolean') {
          this.online = realInfo.online;
        }

        // Water level is stored as weightPercent (0-100)
        const weightPercent = realInfo.weightPercent;

        if (typeof weightPercent === 'number') {
          this.waterLevel = Math.min(100, Math.max(0, weightPercent));
          this.lastUpdate = new Date();

          this.humidityService
            .getCharacteristic(this.platform.api.hap.Characteristic.CurrentRelativeHumidity)
            .updateValue(this.waterLevel);

          this.log.debug(`[${this.name}] Water level updated: ${this.waterLevel}%`);
        } else {
          this.log.debug(`[${this.name}] No water level data available in response`);
        }
      }
    } catch (error) {
      this.log.error(`[${this.name}] Failed to update water level:`, error.message);
    }
  }
  
  startPolling() {
    // Clear any existing interval
    if (this.pollingTimer) {
      clearInterval(this.pollingTimer);
    }
    
    // Start new polling interval
    this.pollingTimer = setInterval(() => {
      this.updateWaterLevel();
    }, this.pollingInterval);
    
    this.log.info(`[${this.name}] Started water level polling (every ${this.pollingInterval / 1000}s)`);
  }
  
  stopPolling() {
    if (this.pollingTimer) {
      clearInterval(this.pollingTimer);
      this.pollingTimer = null;
    }
  }
  
  getServices() {
    return [this.informationService, this.humidityService];
  }
}

// Test-only exports. Production consumers must keep using the default export
// (the Homebridge `module.exports = function(homebridge)` initializer above).
module.exports._test = {
  getDeviceType,
  resolveBaseUrl,
  PetLibroPlatform,
  PetLibroFeeder,
  PetLibroWetFeeder,
  PetLibroFountain,
  DEVICE_TYPE,
  FOUNTAIN_NAME_KEYWORDS,
  FOUNTAIN_SERIAL_PREFIXES,
  WET_FEEDER_PRODUCT_IDENTIFIERS,
  WET_FEEDER_NAME_KEYWORDS,
  WET_FEEDER_PLATE_COUNT,
  resolveWetPlate,
  assertApiOk,
  API_REGIONS
};