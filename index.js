const miio = require('miio');
const packageJson = require('./package.json');

let PlatformAccessory, Service, Characteristic, UUIDGen;

const PLATFORM_NAME = 'XiaomiAirPurifierPlatform';
const PLUGIN_NAME = '@km81/homebridge-xiaomi-airpurifier';
const POLLING_INTERVAL = 15000; // 15 seconds

module.exports = (api) => {
  PlatformAccessory = api.platformAccessory;
  Service = api.hap.Service;
  Characteristic = api.hap.Characteristic;
  UUIDGen = api.hap.uuid;
  api.registerPlatform(PLATFORM_NAME, XiaomiAirPurifierPlatform);
};

class XiaomiAirPurifierPlatform {
  constructor(log, config, api) {
    this.log = log;
    this.api = api;
    this.config = config || {};
    this.accessories = new Map();
    this.devices = [];
    this.discoverTimer = null;

    // backwards-compat / defaults
    this.config.devices = Array.isArray(this.config.devices) ? this.config.devices : (this.config.devices ? [this.config.devices] : []);
    for (const dev of this.config.devices) {
      dev.name = (dev.name || dev.ip || 'Air Purifier').toString();
      dev.token = (dev.token || '').toString();
      dev.ip = (dev.ip || '').toString();
      dev.type = (dev.type || 'MiAirPurifier2S').toString(); // MiAirPurifier2S | MiAirPurifierPro etc.
      dev.model = (dev.model || '').toString();
      dev.pollingInterval = Number.isFinite(dev.pollingInterval) ? dev.pollingInterval : POLLING_INTERVAL;

      // feature toggles
      dev.showLED = dev.showLED !== false; // default true
      dev.separateLedAccessory = !!dev.separateLedAccessory;
      dev.showBuzzer = dev.showBuzzer !== false; // default true
      dev.separateBuzzerAccessory = !!dev.separateBuzzerAccessory;
      dev.showAutoModeSwitch = dev.showAutoModeSwitch !== false;
      dev.separateAutoModeAccessory = !!dev.separateAutoModeAccessory;
      dev.showSleepModeSwitch = dev.showSleepModeSwitch !== false;
      dev.separateSleepModeAccessory = !!dev.separateSleepModeAccessory;
      dev.showFavoriteModeSwitch = dev.showFavoriteModeSwitch !== false;
      dev.separateFavoriteModeAccessory = !!dev.separateFavoriteModeAccessory;

      // names
      dev.ledName = dev.ledName || '';
      dev.buzzerName = dev.buzzerName || '';
      dev.autoModeName = dev.autoModeName || '';
      dev.sleepModeName = dev.sleepModeName || '';
      dev.favoriteModeName = dev.favoriteModeName || '';

      // favorite level bounds
      dev.favoriteMin = Number.isFinite(dev.favoriteMin) ? dev.favoriteMin : 1;
      dev.favoriteMax = Number.isFinite(dev.favoriteMax) ? dev.favoriteMax : 16;

      // AQI thresholds [excellent, good, fair, inferior]
      dev.aqiThresholds = this.validateAqiThresholds(dev.aqiThresholds, [15, 35, 75, 115]);
    }

    if (!this.config.devices.length) {
      this.log.warn('No devices configured under "devices".');
    }

    api.on('didFinishLaunching', () => {
      this.discover();
    });
  }

  configureAccessory(accessory) {
    this.accessories.set(accessory.UUID, accessory);
  }

  discover() {
    let i = 0;
    const loop = async () => {
      clearTimeout(this.discoverTimer);
      if (i >= this.config.devices.length) return;
      const conf = this.config.devices[i++];
      try {
        await this.setupDevice(conf);
      } catch (e) {
        this.log.error(`[${conf.name}] setup error: ${e.message || e}`);
      } finally {
        this.discoverTimer = setTimeout(loop, 500);
      }
    };
    loop();
  }

  async setupDevice(conf) {
    const uuid = UUIDGen.generate(`${conf.ip}-${conf.token}-${conf.name}`);
    let accessory = this.accessories.get(uuid);
    if (!accessory) {
      accessory = new PlatformAccessory(conf.name, uuid);
      accessory.context.config = conf;
      accessory.category = this.api.hap.Categories.AIR_PURIFIER;
      this.api.registerPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [accessory]);
      this.accessories.set(uuid, accessory);
    } else {
      accessory.context.config = conf;
    }
    const device = new XiaomiAirPurifierDevice(this, accessory, conf);
    await device.init();
    this.devices.push(device);
  }

  validateAqiThresholds(conf, def) {
    // conf can be string "15,35,75,115" or array [15,35,75,115]
    if (typeof conf === 'string') {
      const cand = conf.split(',').map((v) => Number(v.trim()));
      if (cand.every((v) => Number.isFinite(v) && v >= 0) && cand[0] <= cand[1] && cand[1] <= cand[2] && cand[2] <= cand[3]) return cand;
    }
    if (Array.isArray(conf) && conf.length === 4) {
      const cand = conf.map((v) => Number(v));
      if (cand.every((v) => Number.isFinite(v) && v >= 0) && cand[0] <= cand[1] && cand[1] <= cand[2] && cand[2] <= cand[3]) return cand;
    }
    return def;
  }
}

class XiaomiAirPurifierDevice {
  constructor(platform, accessory, config) {
    this.platform = platform;
    this.api = platform.api;
    this.log = platform.log;
    this.hap = platform.api.hap;
    this.accessory = accessory;
    this.config = accessory.context.config || config || {};
    this.device = null;
    this.children = { led: null, buzzer: null, auto: null, sleep: null, fav: null, aq: null };
    this.pollTimer = null;

    this.state = {
      // power, mode, aqi, led, buzzer, favorite_level, filter life, etc.
    };

    this.maxFavoriteLevel = Math.max(1, Number(this.config.favoriteMax) || 16);
    this.minFavoriteLevel = Math.max(1, Number(this.config.favoriteMin) || 1);

    this.aqiThresholds = this.platform.validateAqiThresholds(this.config.aqiThresholds, [15, 35, 75, 115]);

    // Services
    this.ensureInformationService();
  }

  prefix(msg) { return `[${this.config.name}] ${msg}`; }
  setServiceName(svc, name) {
    try {
      svc.setCharacteristic(Characteristic.ConfiguredName, name);
    } catch (_) { /* older iOS */ }
    try {
      svc.setCharacteristic(Characteristic.Name, name);
    } catch (_) { /* ignore */ }
  }

  ensureInformationService() {
    const info = this.accessory.getService(Service.AccessoryInformation) || this.accessory.addService(Service.AccessoryInformation);
    info.setCharacteristic(Characteristic.Manufacturer, 'Xiaomi');
    info.setCharacteristic(Characteristic.Model, this.config.model || this.config.type || 'Air Purifier');
    info.setCharacteristic(Characteristic.SerialNumber, `${this.config.ip}`);
    info.setCharacteristic(Characteristic.FirmwareRevision, packageJson.version || '1.0.0');
  }

  async init() {
    await this.connect();

    const service =
      this.accessory.getService(Service.AirPurifier) ||
      this.accessory.addService(Service.AirPurifier, this.config.name);
    this.setServiceName(service, this.config.name);

    service.getCharacteristic(Characteristic.Active)
      .onSet(async (v) => {
        // optimistic update: reflect ON/OFF immediately in UI
        const next = v ? 'on' : 'off';
        const prev = this.state.power;
        this.state.power = next;
        try {
          this.updateAllCharacteristics();
          await this.setPropertyValue('set_power', [next]);
        } catch (e) {
          // revert on error
          this.state.power = prev;
          this.updateAllCharacteristics();
          throw e;
        }
      });

    // 0=MANUAL, 1=AUTO → AUTO=auto, MANUAL=favorite
    service.getCharacteristic(Characteristic.TargetAirPurifierState)
      .onSet(async (v) => {
        const next = v === Characteristic.TargetAirPurifierState.AUTO ? 'auto' : 'favorite';
        const prev = this.state.mode;
        this.state.mode = next;
        try {
          this.updateAllCharacteristics();
          await this.setPropertyValue('set_mode', [next]);
        } catch (e) {
          this.state.mode = prev;
          this.updateAllCharacteristics();
          throw e;
        }
      });

    // 속도 슬라이더 → favorite 레벨로 (set_level_favorite 고정)
    service.getCharacteristic(Characteristic.RotationSpeed)
      .onSet(async (v) => {
        const prevMode = this.state.mode;
        this.state.mode = 'favorite';
        try {
          this.updateAllCharacteristics();
          await this.setFavoriteLevelPercent(v);
        } catch (e) {
          this.state.mode = prevMode;
          this.updateAllCharacteristics();
          throw e;
        }
      });

    // Sensors and switches
    this.ensureSensorsAndSwitches();

    // initial fetch + start polling
    await this.refresh();
    this.schedulePolling();
  }

  async connect() {
    if (this.device) return;
    try {
      this.log.info(this.prefix(`연결 시도... (${this.config.ip})`));
      this.device = await miio.device({ address: this.config.ip, token: this.config.token });
      this.log.info(this.prefix('연결됨'));
    } catch (e) {
      this.log.error(this.prefix(`연결 실패: ${e.message || e}`));
      throw e;
    }
  }

  schedulePolling() {
    clearTimeout(this.pollTimer);
    const iv = Number.isFinite(this.config.pollingInterval) ? this.config.pollingInterval : POLLING_INTERVAL;
    const loop = async () => {
      clearTimeout(this.pollTimer);
      try {
        await this.refresh();
      } catch (e) {
        this.log.error(this.prefix(`폴링 실패: ${e.message || e}`));
      } finally {
        this.pollTimer = setTimeout(loop, iv);
      }
    };
    this.pollTimer = setTimeout(loop, iv);
  }

  async refresh() {
    try {
      const props = await this.device.call('get_prop', [
        'power', 'mode', 'aqi', 'favorite_level', 'buzzer', 'led',
        'filter1_life', 'filter1_hours', 'average_aqi'
      ]);
      this.applyProps(props);
      this.updateAllCharacteristics();
    } catch (e) {
      this.log.error(this.prefix(`상태 조회 실패: ${e.message || e}`));
      throw e;
    }
  }

  applyProps(props) {
    const keys = ['power','mode','aqi','favorite_level','buzzer','led','filter1_life','filter1_hours','average_aqi'];
    for (let i = 0; i < keys.length && i < props.length; i++) {
      this.state[keys[i]] = props[i];
    }
  }

  ensureSensorsAndSwitches() {
    // AQI Sensor
    if (!this.children.aq) {
      const child = this.ensureChildAccessory('aq', `${this.config.name} AQI`, Service.AirQualitySensor);
      const svc = child.getService(Service.AirQualitySensor) || child.addService(Service.AirQualitySensor, `${this.config.name} AQI`);
      this.setServiceName(svc, `${this.config.name} AQI`);
      this.children.aq = { acc: child, svc };
    }

    // LED switch
    if (this.config.showLED === true) {
      if (this.config.separateLedAccessory === true) {
        const name = this.config.ledName || `${this.config.name} LED`;
        const child = this.ensureChildAccessory('led', name, Service.Switch);
        const svc = child.getService(Service.Switch) || child.addService(Service.Switch, name);
        this.setServiceName(svc, name);
        this.children.led = { acc: child, svc };
        const main = this.accessory.getServiceById(Service.Switch, 'LED');
        if (main) this.accessory.removeService(main);
        svc.getCharacteristic(Characteristic.On).onSet(async (v) => {
          const prev = this.state.led;
          const next = v ? 'on' : 'off';
          this.state.led = next;
          try {
            this.updateAllCharacteristics();
            if (this.config.type === 'MiAirPurifierPro') await this.setPropertyValue('set_led_b', [v ? 0 : 2]);
            else await this.setPropertyValue('set_led', [next]);
          } catch (e) {
            this.state.led = prev;
            this.updateAllCharacteristics();
            throw e;
          }
        });
      } else {
        this.children.led = null;
        let svc = this.accessory.getServiceById(Service.Switch, 'LED');
        if (!svc) {
          const name = this.config.ledName || `${this.config.name} LED`;
          svc = this.accessory.addService(Service.Switch, name, 'LED');
          this.setServiceName(svc, name);
          svc.getCharacteristic(Characteristic.On).onSet(async (v) => {
            const prev = this.state.led;
            const next = v ? 'on' : 'off';
            this.state.led = next;
            try {
              this.updateAllCharacteristics();
              if (this.config.type === 'MiAirPurifierPro') await this.setPropertyValue('set_led_b', [v ? 0 : 2]);
              else await this.setPropertyValue('set_led', [next]);
            } catch (e) {
              this.state.led = prev;
              this.updateAllCharacteristics();
              throw e;
            }
          });
        }
      }
    } else {
      const main = this.accessory.getServiceById(Service.Switch, 'LED');
      if (main) this.accessory.removeService(main);
      this.removeChildAccessory('led'); this.children.led = null;
    }

    // Buzzer switch
    if (this.config.showBuzzer === true) {
      if (this.config.separateBuzzerAccessory === true) {
        const name = this.config.buzzerName || `${this.config.name} Buzzer`;
        const child = this.ensureChildAccessory('buzzer', name, Service.Switch);
        const svc = child.getService(Service.Switch) || child.addService(Service.Switch, name);
        this.setServiceName(svc, name);
        this.children.buzzer = { acc: child, svc };
        const main = this.accessory.getServiceById(Service.Switch, 'Buzzer');
        if (main) this.accessory.removeService(main);
        svc.getCharacteristic(Characteristic.On).onSet(async (v) => {
          const prev = this.state.buzzer;
          const next = v ? 'on' : 'off';
          this.state.buzzer = next;
          try {
            this.updateAllCharacteristics();
            await this.setPropertyValue('set_buzzer', [next]);
          } catch (e) {
            this.state.buzzer = prev;
            this.updateAllCharacteristics();
            throw e;
          }
        });
      } else {
        this.children.buzzer = null;
        let svc = this.accessory.getServiceById(Service.Switch, 'Buzzer');
        if (!svc) {
          const name = this.config.buzzerName || `${this.config.name} Buzzer`;
          svc = this.accessory.addService(Service.Switch, name, 'Buzzer');
          this.setServiceName(svc, name);
          svc.getCharacteristic(Characteristic.On).onSet(async (v) => {
            const prev = this.state.buzzer;
            const next = v ? 'on' : 'off';
            this.state.buzzer = next;
            try {
              this.updateAllCharacteristics();
              await this.setPropertyValue('set_buzzer', [next]);
            } catch (e) {
              this.state.buzzer = prev;
              this.updateAllCharacteristics();
              throw e;
            }
          });
        }
      }
    } else {
      const main = this.accessory.getServiceById(Service.Switch, 'Buzzer');
      if (main) this.accessory.removeService(main);
      this.removeChildAccessory('buzzer'); this.children.buzzer = null;
    }

    // Mode switches (Auto/Sleep/Favorite)
    // Auto
    if (this.config.showAutoModeSwitch === true) {
      if (this.config.separateAutoModeAccessory === true) {
        const name = this.config.autoModeName || `${this.config.name} Auto Mode`;
        const child = this.ensureChildAccessory('mode-auto', name, Service.Switch);
        const svc = child.getService(Service.Switch) || child.addService(Service.Switch, name);
        this.setServiceName(svc, name);
        this.children.auto = { acc: child, svc };
        const main = this.accessory.getServiceById(Service.Switch, 'AutoMode');
        if (main) this.accessory.removeService(main);
        svc.getCharacteristic(Characteristic.On).onSet(async (v) => {
            const prev = this.state.mode;
            const next = v ? 'auto' : (this.state.mode === 'auto' ? 'favorite' : this.state.mode);
            if (next !== prev) this.state.mode = next;
            try {
              this.updateAllCharacteristics();
              if (v) await this.setPropertyValue('set_mode', ['auto']);
              else if (prev === 'auto') await this.setPropertyValue('set_mode', ['favorite']);
            } catch (e) {
              this.state.mode = prev;
              this.updateAllCharacteristics();
              throw e;
            }
          });
      } else {
        this.children.auto = null;
        let svc = this.accessory.getServiceById(Service.Switch, 'AutoMode');
        if (!svc) {
          const name = this.config.autoModeName || `${this.config.name} Auto Mode`;
          svc = this.accessory.addService(Service.Switch, name, 'AutoMode');
          this.setServiceName(svc, name);
          svc.getCharacteristic(Characteristic.On).onSet(async (v) => {
            const prev = this.state.mode;
            const next = v ? 'auto' : (this.state.mode === 'auto' ? 'favorite' : this.state.mode);
            if (next !== prev) this.state.mode = next;
            try {
              this.updateAllCharacteristics();
              if (v) await this.setPropertyValue('set_mode', ['auto']);
              else if (prev === 'auto') await this.setPropertyValue('set_mode', ['favorite']);
            } catch (e) {
              this.state.mode = prev;
              this.updateAllCharacteristics();
              throw e;
            }
          });
        }
      }
    } else {
      const main = this.accessory.getServiceById(Service.Switch, 'AutoMode');
      if (main) this.accessory.removeService(main);
      this.removeChildAccessory('mode-auto'); this.children.auto = null;
    }

    // Sleep
    if (this.config.showSleepModeSwitch === true) {
      if (this.config.separateSleepModeAccessory === true) {
        const name = this.config.sleepModeName || `${this.config.name} Sleep Mode`;
        const child = this.ensureChildAccessory('mode-sleep', name, Service.Switch);
        const svc = child.getService(Service.Switch) || child.addService(Service.Switch, name);
        this.setServiceName(svc, name);
        this.children.sleep = { acc: child, svc };
        const main = this.accessory.getServiceById(Service.Switch, 'SleepMode');
        if (main) this.accessory.removeService(main);
        svc.getCharacteristic(Characteristic.On).onSet(async (v) => {
            const prev = this.state.mode;
            const next = v ? 'silent' : (this.state.mode === 'silent' ? 'favorite' : this.state.mode);
            if (next !== prev) this.state.mode = next;
            try {
              this.updateAllCharacteristics();
              if (v) await this.setPropertyValue('set_mode', ['silent']);
              else if (prev === 'silent') await this.setPropertyValue('set_mode', ['favorite']);
            } catch (e) {
              this.state.mode = prev;
              this.updateAllCharacteristics();
              throw e;
            }
          });
      } else {
        this.children.sleep = null;
        let svc = this.accessory.getServiceById(Service.Switch, 'SleepMode');
        if (!svc) {
          const name = this.config.sleepModeName || `${this.config.name} Sleep Mode`;
          svc = this.accessory.addService(Service.Switch, name, 'SleepMode');
          this.setServiceName(svc, name);
          svc.getCharacteristic(Characteristic.On).onSet(async (v) => {
            const prev = this.state.mode;
            const next = v ? 'silent' : (this.state.mode === 'silent' ? 'favorite' : this.state.mode);
            if (next !== prev) this.state.mode = next;
            try {
              this.updateAllCharacteristics();
              if (v) await this.setPropertyValue('set_mode', ['silent']);
              else if (prev === 'silent') await this.setPropertyValue('set_mode', ['favorite']);
            } catch (e) {
              this.state.mode = prev;
              this.updateAllCharacteristics();
              throw e;
            }
          });
        }
      }
    } else {
      const main = this.accessory.getServiceById(Service.Switch, 'SleepMode');
      if (main) this.accessory.removeService(main);
      this.removeChildAccessory('mode-sleep'); this.children.sleep = null;
    }

    // Favorite
    if (this.config.showFavoriteModeSwitch === true) {
      if (this.config.separateFavoriteModeAccessory === true) {
        const name = this.config.favoriteModeName || `${this.config.name} Favorite Mode`;
        const child = this.ensureChildAccessory('mode-fav', name, Service.Switch);
        const svc = child.getService(Service.Switch) || child.addService(Service.Switch, name);
        this.setServiceName(svc, name);
        this.children.fav = { acc: child, svc };
        const main = this.accessory.getServiceById(Service.Switch, 'FavoriteMode');
        if (main) this.accessory.removeService(main);
        svc.getCharacteristic(Characteristic.On).onSet(async (v) => {
          const prev = this.state.mode;
          const next = v ? 'favorite' : (this.state.mode === 'favorite' ? 'auto' : this.state.mode);
          if (next !== prev) this.state.mode = next;
          try {
            this.updateAllCharacteristics();
            if (v) await this.setPropertyValue('set_mode', ['favorite']);
            else if (prev === 'favorite') await this.setPropertyValue('set_mode', ['auto']);
          } catch (e) {
            this.state.mode = prev;
            this.updateAllCharacteristics();
            throw e;
          }
        });
      } else {
        this.children.fav = null;
        let svc = this.accessory.getServiceById(Service.Switch, 'FavoriteMode');
        if (!svc) {
          const name = this.config.favoriteModeName || `${this.config.name} Favorite Mode`;
          svc = this.accessory.addService(Service.Switch, name, 'FavoriteMode');
          this.setServiceName(svc, name);
          svc.getCharacteristic(Characteristic.On).onSet(async (v) => {
            const prev = this.state.mode;
            const next = v ? 'favorite' : (this.state.mode === 'favorite' ? 'auto' : this.state.mode);
            if (next !== prev) this.state.mode = next;
            try {
              this.updateAllCharacteristics();
              if (v) await this.setPropertyValue('set_mode', ['favorite']);
              else if (prev === 'favorite') await this.setPropertyValue('set_mode', ['auto']);
            } catch (e) {
              this.state.mode = prev;
              this.updateAllCharacteristics();
              throw e;
            }
          });
        }
      }
    } else {
      const main = this.accessory.getServiceById(Service.Switch, 'FavoriteMode');
      if (main) this.accessory.removeService(main);
      this.removeChildAccessory('mode-fav'); this.children.fav = null;
    }
  }

  ensureChildAccessory(suffix, name, svcType) {
    const id = `${this.accessory.UUID}:${suffix}`;
    let acc = this.platform.accessories.get(id);
    if (!acc) {
      acc = new PlatformAccessory(name, id);
      acc.category = this.api.hap.Categories.OTHER;
      acc.context.parentUUID = this.accessory.UUID;
      this.api.registerPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [acc]);
      this.platform.accessories.set(id, acc);
    }
    return acc;
  }

  removeChildAccessory(suffix) {
    const id = `${this.accessory.UUID}:${suffix}`;
    const acc = this.platform.accessories.get(id);
    if (acc) {
      try {
        this.api.unregisterPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [acc]);
      } catch (_) {}
      this.platform.accessories.delete(id);
    }
  }

  async setFavoriteLevelPercent(percent) {
    const p = Math.max(0, Math.min(100, Number(percent) || 0));
    const level = Math.max(this.minFavoriteLevel, Math.min(this.maxFavoriteLevel, Math.round((p / 100) * this.maxFavoriteLevel)));
    await this.setPropertyValue('set_level_favorite', [level]);
    this.state.favorite_level = level;
  }

  async setPropertyValue(method, args) {
    await this.connect();
    try {
      const res = await this.device.call(method, args);
      this.log.debug?.(this.prefix(`${method}(${JSON.stringify(args)}) → ${JSON.stringify(res)}`));
      return res;
    } catch (e) {
      this.log.error(this.prefix(`${method} 실패: ${e.message || e}`));
      throw e;
    }
  }

  mapAqiToHomeKitLevel(aqi, t) {
    if (!Number.isFinite(aqi)) return Characteristic.AirQuality.UNKNOWN; // 0
    if (aqi <= t[0]) return Characteristic.AirQuality.EXCELLENT; // 1
    if (aqi <= t[1]) return Characteristic.AirQuality.GOOD;      // 2
    if (aqi <= t[2]) return Characteristic.AirQuality.FAIR;      // 3
    if (aqi <= t[3]) return Characteristic.AirQuality.INFERIOR;  // 4
    return Characteristic.AirQuality.POOR;                        // 5
  }

  updateAllCharacteristics() {
    const svcAp = this.accessory.getService(Service.AirPurifier);
    if (!svcAp) return;

    const powerOn = (this.state.power === 'on');
    svcAp.updateCharacteristic(Characteristic.Active, powerOn ? 1 : 0);

    // map mode to TargetAirPurifierState (1=AUTO, 0=MANUAL)
    const targetMode =
      this.state.mode === 'auto'
        ? Characteristic.TargetAirPurifierState.AUTO
        : Characteristic.TargetAirPurifierState.MANUAL;
    svcAp.updateCharacteristic(Characteristic.TargetAirPurifierState, targetMode);

    const currentState =
      powerOn
        ? Characteristic.CurrentAirPurifierState.PURIFYING_AIR
        : Characteristic.CurrentAirPurifierState.INACTIVE;
    svcAp.updateCharacteristic(Characteristic.CurrentAirPurifierState, currentState);

    // AQI → AirQuality + PM2_5Density
    const aqi = Number(this.state.aqi);
    if (Number.isFinite(aqi)) {
      const hkLevel = this.mapAqiToHomeKitLevel(aqi, this.aqiThresholds);
      const aqSvc = this.children.aq?.svc || this.accessory.getService(Service.AirQualitySensor);
      aqSvc?.updateCharacteristic(Characteristic.AirQuality, hkLevel);
      aqSvc?.updateCharacteristic(Characteristic.PM2_5Density, aqi);
    }

    // LED
    const ledOn = (this.state.led === 'on' || this.state.led === 0);
    const ledChild = this.children.led?.svc;
    const ledMain = this.accessory.getServiceById(Service.Switch, 'LED');
    (ledChild || ledMain)?.updateCharacteristic(Characteristic.On, !!ledOn);

    // Buzzer
    const buzzerOn = (this.state.buzzer === 'on');
    const buzChild = this.children.buzzer?.svc;
    const buzMain = this.accessory.getServiceById(Service.Switch, 'Buzzer');
    (buzChild || buzMain)?.updateCharacteristic(Characteristic.On, !!buzzerOn);

    // Modes
    const autoOn = (this.state.mode === 'auto');
    const sleepOn = (this.state.mode === 'silent');
    const favOn = (this.state.mode === 'favorite');

    const autoChild = this.children.auto?.svc;
    const autoMain = this.accessory.getServiceById(Service.Switch, 'AutoMode');
    (autoChild || autoMain)?.updateCharacteristic(Characteristic.On, autoOn);

    const sleepChild = this.children.sleep?.svc;
    const sleepMain = this.accessory.getServiceById(Service.Switch, 'SleepMode');
    (sleepChild || sleepMain)?.updateCharacteristic(Characteristic.On, sleepOn);

    const favChild = this.children.fav?.svc;
    const favMain = this.accessory.getServiceById(Service.Switch, 'FavoriteMode');
    (favChild || favMain)?.updateCharacteristic(Characteristic.On, favOn);

    // Favorite level → RotationSpeed
    const fav = Number(this.state.favorite_level);
    const speed = Number.isFinite(fav) ? Math.max(0, Math.min(100, Math.round((fav / this.maxFavoriteLevel) * 100))) : 0;
    svcAp.updateCharacteristic(Characteristic.RotationSpeed, speed);

    // Filter life
    const life = Number(this.state.filter1_life);
    if (Number.isFinite(life)) {
      svcAp.updateCharacteristic(Characteristic.FilterLifeLevel, life);
    }
  }
}
