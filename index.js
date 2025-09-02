const miio = require('miio');
const packageJson = require('./package.json');

let PlatformAccessory, Service, Characteristic, UUIDGen;

const PLATFORM_NAME = 'XiaomiAirPurifierPlatform';
const PLUGIN_NAME = packageJson.name; // 패키지명 동기화
const DEFAULT_POLLING = 15000;
const RECONNECT_INTERVAL = 30000; // 완전 실패 후 재시도 주기
const CONNECT_RETRY_MAX = 5;
const CONNECT_RETRY_BASE_MS = 800; // 지수 백오프 시작값

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
    this.accessories = new Map(); // UUID -> accessory
    this.devices = [];
    this.discoverTimer = null;

    // === 스키마: deviceCfgs (required) ===
    this.config.deviceCfgs = Array.isArray(this.config.deviceCfgs)
      ? this.config.deviceCfgs
      : (this.config.deviceCfgs ? [this.config.deviceCfgs] : []);

    // 정규화
    for (const c of this.config.deviceCfgs) {
      c.name = (c.name || c.ip || 'Air Purifier').toString();
      c.ip = (c.ip || '').toString();
      c.token = (c.token || '').toString();
      c.type = (c.type || 'MiAirPurifier2S').toString(); // MiAirPurifier2S | MiAirPurifierPro

      // 센서/스위치 표시 기본값
      c.showTemperature = c.showTemperature !== false;
      c.separateTemperatureAccessory = !!c.separateTemperatureAccessory;
      c.temperatureName = c.temperatureName || '';

      c.showHumidity = c.showHumidity !== false;
      c.separateHumidityAccessory = !!c.separateHumidityAccessory;
      c.humidityName = c.humidityName || '';

      c.showAirQuality = c.showAirQuality !== false;
      c.separateAirQualityAccessory = !!c.separateAirQualityAccessory;
      c.airQualityName = c.airQualityName || '';

      const aq = c.airQualityThresholds || {};
      c.airQualityThresholds = {
        t1: isFiniteNumber(aq.t1) ? Number(aq.t1) : 5,
        t2: isFiniteNumber(aq.t2) ? Number(aq.t2) : 15,
        t3: isFiniteNumber(aq.t3) ? Number(aq.t3) : 35,
        t4: isFiniteNumber(aq.t4) ? Number(aq.t4) : 55
      };

      c.showLED = !!c.showLED;
      c.separateLedAccessory = !!c.separateLedAccessory;
      c.ledName = c.ledName || '';

      c.showBuzzer = !!c.showBuzzer;
      c.separateBuzzerAccessory = !!c.separateBuzzerAccessory;
      c.buzzerName = c.buzzerName || '';

      c.showAutoModeSwitch = !!c.showAutoModeSwitch;
      c.separateAutoModeAccessory = !!c.separateAutoModeAccessory;
      c.autoModeName = c.autoModeName || '';

      c.showSleepModeSwitch = !!c.showSleepModeSwitch;
      c.separateSleepModeAccessory = !!c.separateSleepModeAccessory;
      c.sleepModeName = c.sleepModeName || '';

      c.showFavoriteModeSwitch = !!c.showFavoriteModeSwitch;
      c.separateFavoriteModeAccessory = !!c.separateFavoriteModeAccessory;
      c.favoriteModeName = c.favoriteModeName || '';

      c.pollingInterval = Number.isFinite(c.pollingInterval) ? c.pollingInterval : DEFAULT_POLLING;
    }

    if (!this.config.deviceCfgs.length) {
      this.log.warn('No devices configured: "deviceCfgs" is empty.');
    }

    api.on('didFinishLaunching', () => this.discover());
  }

  configureAccessory(accessory) {
    this.accessories.set(accessory.UUID, accessory);
  }

  discover() {
    let i = 0;
    const loop = async () => {
      clearTimeout(this.discoverTimer);
      if (i >= this.config.deviceCfgs.length) return;
      const conf = this.config.deviceCfgs[i++];
      try {
        await this.setupDevice(conf);
      } catch (e) {
        this.log.error(`[${conf.name}] setup error: ${e.message || e}`);
      } finally {
        this.discoverTimer = setTimeout(loop, 400);
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
    const dev = new XiaomiAirPurifierDevice(this, accessory, conf);
    await dev.init(); // 내부에서 실패해도 자가복구 루프를 띄우고 진행
    this.devices.push(dev);
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
    this.pollTimer = null;
    this.reconnectTimer = null;
    this.connecting = false;

    // child accs
    this.child = {
      temp: null,
      humi: null,
      aq: null,
      led: null,
      buzzer: null,
      auto: null,
      sleep: null,
      fav: null
    };

    this.state = {}; // power, mode, aqi, temperature, humidity, favorite_level, led, buzzer, ...
    this.filterSvc = null; // FilterMaintenance service

    this.ensureInformationService();
  }

  ensureInformationService() {
    const { Service, Characteristic } = this.hap;
    const info = this.accessory.getService(Service.AccessoryInformation) || this.accessory.addService(Service.AccessoryInformation);
    info.setCharacteristic(Characteristic.Manufacturer, 'Xiaomi');
    info.setCharacteristic(Characteristic.Model, this.config.type || 'Air Purifier');
    info.setCharacteristic(Characteristic.SerialNumber, this.config.serialNumber || `${this.config.ip}`);
    info.setCharacteristic(Characteristic.FirmwareRevision, packageJson.version || '1.0.0');
  }

  prefix(msg) { return `[${this.config.name}] ${msg}`; }

  // 경고 최소화를 위한 안전 버전
  setSvcName(svc, name) {
    const { Characteristic } = this.hap;
    try {
      if (typeof svc.testCharacteristic === 'function' &&
          svc.testCharacteristic(Characteristic.ConfiguredName)) {
        svc.updateCharacteristic(Characteristic.ConfiguredName, name);
      }
    } catch (_) {}
    try {
      if (typeof svc.testCharacteristic === 'function' &&
          svc.testCharacteristic(Characteristic.Name)) {
        svc.updateCharacteristic(Characteristic.Name, name);
      } else {
        svc.setCharacteristic?.(Characteristic.Name, name);
      }
    } catch (_) {}
  }

  async init() {
    const { Service, Characteristic } = this.hap;

    // 연결 시도 (실패해도 throw 하지 않음)
    await this.connectWithRetry();

    // Main AirPurifier service
    const ap = this.accessory.getService(Service.AirPurifier) || this.accessory.addService(Service.AirPurifier, this.config.name);
    this.setSvcName(ap, this.config.name);

    // FilterMaintenance service (Filter Life Level 경고 방지)
    this.filterSvc = this.accessory.getService(Service.FilterMaintenance) ||
                     this.accessory.addService(Service.FilterMaintenance, `${this.config.name} Filter`);

    // === 낙관적 업데이트 ===
    ap.getCharacteristic(Characteristic.Active).onSet(async (v) => {
      const prev = this.state.power;
      const next = v ? 'on' : 'off';
      this.state.power = next;
      try {
        this.updateAll();
        await this.call('set_power', [next]);
      } catch (e) {
        this.state.power = prev;
        this.updateAll();
        throw e;
      }
    });

    ap.getCharacteristic(Characteristic.TargetAirPurifierState).onSet(async (v) => {
      const prev = this.state.mode;
      const next = (v === Characteristic.TargetAirPurifierState.AUTO) ? 'auto' : 'favorite';
      this.state.mode = next;
      try {
        this.updateAll();
        await this.call('set_mode', [next]);
      } catch (e) {
        this.state.mode = prev;
        this.updateAll();
        throw e;
      }
    });

    ap.getCharacteristic(Characteristic.RotationSpeed).onSet(async (percent) => {
      // favorite 레벨 모드로 전환 + 즉시 반영
      const prevMode = this.state.mode;
      this.state.mode = 'favorite';
      try {
        this.updateAll();
        await this.setFavoriteLevelPercent(percent);
      } catch (e) {
        this.state.mode = prevMode;
        this.updateAll();
        throw e;
      }
    });

    // === 센서 & 스위치 생성 (config.schema.json 준수) ===
    await this.ensureSensorsAndSwitches();

    // 초기 동기화 + 폴링
    try { await this.refresh(); } catch (_) {}
    this.schedulePolling();
  }

  // ---------- 연결 관리 ----------
  async connectWithRetry() {
    if (this.device) return true;
    if (this.connecting) return false;
    this.connecting = true;

    let attempt = 0;
    while (attempt < CONNECT_RETRY_MAX && !this.device) {
      attempt++;
      try {
        this.log.info(this.prefix(`연결 시도 ${attempt}/${CONNECT_RETRY_MAX} ... (${this.config.ip})`));
        this.device = await miio.device({ address: this.config.ip, token: this.config.token });
        this.log.info(this.prefix('연결됨'));
        this.connecting = false;
        return true;
      } catch (e) {
        const delay = CONNECT_RETRY_BASE_MS * Math.pow(2, attempt - 1);
        this.log.warn(this.prefix(`연결 실패: ${e.message || e} → ${Math.round(delay)}ms 후 재시도`));
        await sleep(delay);
      }
    }

    this.connecting = false;
    // 완전 실패: 일정 주기로 재연결 시도
    this.scheduleReconnect();
    return false;
  }

  scheduleReconnect() {
    clearTimeout(this.reconnectTimer);
    this.reconnectTimer = setTimeout(async () => {
      this.device = null; // 안전하게 초기화
      await this.connectWithRetry();
    }, RECONNECT_INTERVAL);
  }

  ensureConnectedOrThrow() {
    if (!this.device) {
      const err = new Error('device not connected');
      throw err;
    }
  }

  schedulePolling() {
    clearTimeout(this.pollTimer);
    const iv = Number.isFinite(this.config.pollingInterval) ? this.config.pollingInterval : DEFAULT_POLLING;
    const loop = async () => {
      clearTimeout(this.pollTimer);
      try {
        await this.refresh();
      } catch (e) {
        this.log.error(this.prefix(`폴링 실패: ${e.message || e}`));
        // 연결 문제면 재연결 스케줄링
        this.scheduleReconnect();
      } finally {
        this.pollTimer = setTimeout(loop, iv);
      }
    };
    this.pollTimer = setTimeout(loop, iv);
  }

  async refresh() {
    if (!this.device) {
      await this.connectWithRetry();
      if (!this.device) return; // 연결 안 되면 조용히 탈출
    }
    // 모델간 프로퍼티 차이를 약간 커버: temperature/temp_dec, led vs led_b 등
    const props = await this.call('get_prop', [
      'power', 'mode', 'aqi', 'favorite_level', 'buzzer', 'led', 'led_b',
      'temperature', 'temp_dec', 'humidity',
      'filter1_life', 'filter1_hours', 'average_aqi'
    ], true);
    this.applyProps(props);
    this.updateAll();
  }

  applyProps(arr) {
    // get_prop 반환은 순서대로 들어온다. 없는 키는 undefined일 수 있음
    const keys = ['power','mode','aqi','favorite_level','buzzer','led','led_b',
      'temperature','temp_dec','humidity','filter1_life','filter1_hours','average_aqi'];
    for (let i = 0; i < keys.length && i < arr.length; i++) {
      this.state[keys[i]] = arr[i];
    }

    // temperature 보정: temp_dec(섭씨*10) → temperature(섭씨)
    if (!isFiniteNumber(this.state.temperature) && isFiniteNumber(this.state.temp_dec)) {
      this.state.temperature = Number(this.state.temp_dec) / 10;
    }
    // led 보정: led_b(0=켜짐,2=꺼짐)를 led on/off로 매핑 (Pro)
    if (this.state.led_b !== undefined && this.config.type === 'MiAirPurifierPro') {
      this.state.led = (Number(this.state.led_b) === 0) ? 'on' : 'off';
    }
  }

  // ========= UI/서비스 구성 =========
  async ensureSensorsAndSwitches() {
    const { Service, Characteristic } = this.hap;

    // --- Temperature ---
    if (this.config.showTemperature) {
      if (this.config.separateTemperatureAccessory) {
        this.child.temp = this.ensureChild('temp', this.config.temperatureName || `${this.config.name} Temperature`, Service.TemperatureSensor);
      } else {
        const svc = this.accessory.getServiceById(Service.TemperatureSensor, 'TEMP') ||
                    this.accessory.addService(Service.TemperatureSensor, this.config.temperatureName || `${this.config.name} Temperature`, 'TEMP');
        this.setSvcName(svc, this.config.temperatureName || `${this.config.name} Temperature`);
        this.child.temp = { acc: this.accessory, svc };
      }
    } else {
      this.removeChild('temp');
      const svc = this.accessory.getServiceById(Service.TemperatureSensor, 'TEMP');
      if (svc) this.accessory.removeService(svc);
      this.child.temp = null;
    }

    // --- Humidity ---
    if (this.config.showHumidity) {
      if (this.config.separateHumidityAccessory) {
        this.child.humi = this.ensureChild('humi', this.config.humidityName || `${this.config.name} Humidity`, Service.HumiditySensor);
      } else {
        const svc = this.accessory.getServiceById(Service.HumiditySensor, 'HUMI') ||
                    this.accessory.addService(Service.HumiditySensor, this.config.humidityName || `${this.config.name} Humidity`, 'HUMI');
        this.setSvcName(svc, this.config.humidityName || `${this.config.name} Humidity`);
        this.child.humi = { acc: this.accessory, svc };
      }
    } else {
      this.removeChild('humi');
      const svc = this.accessory.getServiceById(Service.HumiditySensor, 'HUMI');
      if (svc) this.accessory.removeService(svc);
      this.child.humi = null;
    }

    // --- Air Quality (AQI) ---
    if (this.config.showAirQuality) {
      if (this.config.separateAirQualityAccessory) {
        this.child.aq = this.ensureChild('aq', this.config.airQualityName || `${this.config.name} AQI`, Service.AirQualitySensor);
      } else {
        const svc = this.accessory.getServiceById(Service.AirQualitySensor, 'AQI') ||
                    this.accessory.addService(Service.AirQualitySensor, this.config.airQualityName || `${this.config.name} AQI`, 'AQI');
        this.setSvcName(svc, this.config.airQualityName || `${this.config.name} AQI`);
        this.child.aq = { acc: this.accessory, svc };
      }
    } else {
      this.removeChild('aq');
      const svc = this.accessory.getServiceById(Service.AirQualitySensor, 'AQI');
      if (svc) this.accessory.removeService(svc);
      this.child.aq = null;
    }

    // --- LED Switch ---
    if (this.config.showLED) {
      if (this.config.separateLedAccessory) {
        this.child.led = this.ensureChild('led', this.config.ledName || `${this.config.name} LED`, Service.Switch);
        this.child.led.svc.getCharacteristic(Characteristic.On).onSet(async (on) => {
          const prev = this.state.led;
          const next = on ? 'on' : 'off';
          this.state.led = next;
          try {
            this.updateAll();
            if (this.config.type === 'MiAirPurifierPro') {
              await this.call('set_led_b', [on ? 0 : 2]);
            } else {
              await this.call('set_led', [next]);
            }
          } catch (e) {
            this.state.led = prev;
            this.updateAll();
            throw e;
          }
        });
      } else {
        const svc = this.accessory.getServiceById(Service.Switch, 'LED') ||
                    this.accessory.addService(Service.Switch, this.config.ledName || `${this.config.name} LED`, 'LED');
        this.setSvcName(svc, this.config.ledName || `${this.config.name} LED`);
        this.child.led = { acc: this.accessory, svc };
        svc.getCharacteristic(Characteristic.On).onSet(async (on) => {
          const prev = this.state.led;
          const next = on ? 'on' : 'off';
          this.state.led = next;
          try {
            this.updateAll();
            if (this.config.type === 'MiAirPurifierPro') {
              await this.call('set_led_b', [on ? 0 : 2]);
            } else {
              await this.call('set_led', [next]);
            }
          } catch (e) {
            this.state.led = prev;
            this.updateAll();
            throw e;
          }
        });
      }
    } else {
      this.removeChild('led');
      const svc = this.accessory.getServiceById(Service.Switch, 'LED');
      if (svc) this.accessory.removeService(svc);
      this.child.led = null;
    }

    // --- Buzzer Switch ---
    if (this.config.showBuzzer) {
      if (this.config.separateBuzzerAccessory) {
        this.child.buzzer = this.ensureChild('buzzer', this.config.buzzerName || `${this.config.name} Buzzer`, Service.Switch);
        this.child.buzzer.svc.getCharacteristic(Characteristic.On).onSet(async (on) => {
          const prev = this.state.buzzer;
          const next = on ? 'on' : 'off';
          this.state.buzzer = next;
          try {
            this.updateAll();
            await this.call('set_buzzer', [next]);
          } catch (e) {
            this.state.buzzer = prev;
            this.updateAll();
            throw e;
          }
        });
      } else {
        const svc = this.accessory.getServiceById(Service.Switch, 'Buzzer') ||
                    this.accessory.addService(Service.Switch, this.config.buzzerName || `${this.config.name} Buzzer`, 'Buzzer');
        this.setSvcName(svc, this.config.buzzerName || `${this.config.name} Buzzer`);
        this.child.buzzer = { acc: this.accessory, svc };
        svc.getCharacteristic(Characteristic.On).onSet(async (on) => {
          const prev = this.state.buzzer;
          const next = on ? 'on' : 'off';
          this.state.buzzer = next;
          try {
            this.updateAll();
            await this.call('set_buzzer', [next]);
          } catch (e) {
            this.state.buzzer = prev;
            this.updateAll();
            throw e;
          }
        });
      }
    } else {
      this.removeChild('buzzer');
      const svc = this.accessory.getServiceById(Service.Switch, 'Buzzer');
      if (svc) this.accessory.removeService(svc);
      this.child.buzzer = null;
    }

    // --- Mode Switches: Auto / Sleep / Favorite (옵션) ---
    const bindModeSwitch = (kind, title, whenOn, whenOffIfWas) => {
      const key = `mode-${kind}`;
      let svc = null, holder = null;
      if (this.config[`separate${capitalize(kind)}ModeAccessory`]) {
        holder = this.ensureChild(key, title, Service.Switch);
        svc = holder.svc;
      } else {
        svc = this.accessory.getServiceById(Service.Switch, key) ||
              this.accessory.addService(Service.Switch, title, key);
        this.setSvcName(svc, title);
        holder = { acc: this.accessory, svc };
      }
      svc.getCharacteristic(Characteristic.On).onSet(async (on) => {
        const prev = this.state.mode;
        const next = on ? whenOn : (prev === whenOn ? whenOffIfWas : prev);
        if (next !== prev) this.state.mode = next;
        try {
          this.updateAll();
          if (on) await this.call('set_mode', [whenOn]);
          else if (prev === whenOn) await this.call('set_mode', [whenOffIfWas]);
        } catch (e) {
          this.state.mode = prev;
          this.updateAll();
          throw e;
        }
      });
      return holder;
    };

    if (this.config.showAutoModeSwitch) {
      this.child.auto = bindModeSwitch('Auto', this.config.autoModeName || `${this.config.name} Auto Mode`, 'auto', 'favorite');
    } else {
      this.removeChild('mode-Auto');
      const svc = this.accessory.getServiceById(Service.Switch, 'mode-Auto');
      if (svc) this.accessory.removeService(svc);
      this.child.auto = null;
    }

    if (this.config.showSleepModeSwitch) {
      this.child.sleep = bindModeSwitch('Sleep', this.config.sleepModeName || `${this.config.name} Sleep Mode`, 'silent', 'favorite');
    } else {
      this.removeChild('mode-Sleep');
      const svc = this.accessory.getServiceById(Service.Switch, 'mode-Sleep');
      if (svc) this.accessory.removeService(svc);
      this.child.sleep = null;
    }

    if (this.config.showFavoriteModeSwitch) {
      this.child.fav = bindModeSwitch('Favorite', this.config.favoriteModeName || `${this.config.name} Favorite Mode`, 'favorite', 'auto');
    } else {
      this.removeChild('mode-Favorite');
      const svc = this.accessory.getServiceById(Service.Switch, 'mode-Favorite');
      if (svc) this.accessory.removeService(svc);
      this.child.fav = null;
    }
  }

  // ========= 공용 유틸 =========
  ensureChild(suffix, name, svcType) {
    const uuid = UUIDGen.generate(`${this.accessory.UUID}:${suffix}`);
    let acc = this.platform.accessories.get(uuid);
    if (!acc) {
      acc = new PlatformAccessory(name, uuid);
      acc.category = this.api.hap.Categories.OTHER;
      acc.context.parentUUID = this.accessory.UUID;
      const svc = acc.getService(svcType) || acc.addService(svcType, name);
      this.setSvcName(svc, name);
      this.api.registerPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [acc]);
      this.platform.accessories.set(uuid, acc);
      return { acc, svc };
    } else {
      const svc = acc.getService(svcType) || acc.addService(svcType, name);
      this.setSvcName(svc, name);
      return { acc, svc };
    }
  }

  removeChild(suffix) {
    const uuid = UUIDGen.generate(`${this.accessory.UUID}:${suffix}`);
    const acc = this.platform.accessories.get(uuid);
    if (acc) {
      try { this.api.unregisterPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [acc]); } catch (_) {}
      this.platform.accessories.delete(uuid);
    }
  }

  async call(method, args, silent = false) {
    // 필요하면 즉시 재연결
    if (!this.device) {
      await this.connectWithRetry();
      if (!this.device) throw new Error('not connected');
    }
    try {
      const res = await this.device.call(method, args);
      if (!silent && this.log.debug) this.log.debug?.(this.prefix(`${method}(${JSON.stringify(args)}) → ${JSON.stringify(res)}`));
      return res;
    } catch (e) {
      // 호출 중 연결 문제 발생 시 재연결 후 1회 재시도
      this.log.warn(this.prefix(`${method} 호출 실패: ${e.message || e} → 재연결 시도`));
      this.device = null;
      await this.connectWithRetry();
      if (!this.device) {
        if (!silent) this.log.error(this.prefix(`${method} 재시도 불가(연결 실패)`));
        this.scheduleReconnect();
        throw e;
      }
      const res2 = await this.device.call(method, args);
      if (!silent && this.log.debug) this.log.debug?.(this.prefix(`${method} 재시도 성공 → ${JSON.stringify(res2)}`));
      return res2;
    }
  }

  async setFavoriteLevelPercent(percent) {
    const p = clamp(Number(percent) || 0, 0, 100);
    // 일반적으로 1~16 스케일(기기마다 다를 수 있음) → 1..16 맵핑
    const max = 16, min = 1;
    const level = clamp(Math.round((p / 100) * max), min, max);
    await this.call('set_level_favorite', [level]);
    this.state.favorite_level = level;
  }

  mapAqiToHK(aqi) {
    // schema: t1..t4 상한(아주좋음/좋음/보통/나쁨)
    const t = this.config.airQualityThresholds || { t1: 5, t2: 15, t3: 35, t4: 55 };
    if (!isFiniteNumber(aqi)) return this.hap.Characteristic.AirQuality.UNKNOWN;
    if (aqi <= t.t1) return this.hap.Characteristic.AirQuality.EXCELLENT; // 1
    if (aqi <= t.t2) return this.hap.Characteristic.AirQuality.GOOD;      // 2
    if (aqi <= t.t3) return this.hap.Characteristic.AirQuality.FAIR;      // 3
    if (aqi <= t.t4) return this.hap.Characteristic.AirQuality.INFERIOR;  // 4
    return this.hap.Characteristic.AirQuality.POOR;                        // 5
  }

  updateAll() {
    const { Service, Characteristic } = this.hap;
    const ap = this.accessory.getService(Service.AirPurifier);
    if (!ap) return;

    const powerOn = (this.state.power === 'on');
    ap.updateCharacteristic(Characteristic.Active, powerOn ? 1 : 0);

    const target =
      this.state.mode === 'auto'
        ? Characteristic.TargetAirPurifierState.AUTO
        : Characteristic.TargetAirPurifierState.MANUAL;
    ap.updateCharacteristic(Characteristic.TargetAirPurifierState, target);

    const current = powerOn
      ? Characteristic.CurrentAirPurifierState.PURIFYING_AIR
      : Characteristic.CurrentAirPurifierState.INACTIVE;
    ap.updateCharacteristic(Characteristic.CurrentAirPurifierState, current);

    // 회전속도 ← favorite_level
    const fav = Number(this.state.favorite_level);
    if (isFiniteNumber(fav)) {
      const speed = clamp(Math.round((fav / 16) * 100), 0, 100);
      ap.updateCharacteristic(Characteristic.RotationSpeed, speed);
    }

    // === 센서류: 전원과 무관하게 업데이트 ===
    if (this.child.temp?.svc && isFiniteNumber(this.state.temperature)) {
      this.child.temp.svc.updateCharacteristic(Characteristic.CurrentTemperature, Number(this.state.temperature));
    }
    if (this.child.humi?.svc && isFiniteNumber(this.state.humidity)) {
      this.child.humi.svc.updateCharacteristic(Characteristic.CurrentRelativeHumidity, Number(this.state.humidity));
    }
    if (this.child.aq?.svc && isFiniteNumber(this.state.aqi)) {
      const hk = this.mapAqiToHK(Number(this.state.aqi));
      this.child.aq.svc.updateCharacteristic(Characteristic.AirQuality, hk);
      this.child.aq.svc.updateCharacteristic(Characteristic.PM2_5Density, Number(this.state.aqi));
    }

    // === 스위치류: 전원이 꺼져 있으면 OFF로 표기 (UI 일관성) ===
    const ledOn = (this.state.led === 'on' || Number(this.state.led_b) === 0);
    const ledSvc = this.child.led?.svc || this.accessory.getServiceById(Service.Switch, 'LED');
    ledSvc?.updateCharacteristic(Characteristic.On, powerOn && !!ledOn);

    const bzOn = (this.state.buzzer === 'on');
    const bzSvc = this.child.buzzer?.svc || this.accessory.getServiceById(Service.Switch, 'Buzzer');
    bzSvc?.updateCharacteristic(Characteristic.On, powerOn && !!bzOn);

    const autoOn = (this.state.mode === 'auto');
    const sleepOn = (this.state.mode === 'silent');
    const favOn = (this.state.mode === 'favorite');

    const autoSvc = this.child.auto?.svc || this.accessory.getServiceById(Service.Switch, 'mode-Auto');
    autoSvc?.updateCharacteristic(Characteristic.On, powerOn && autoOn);

    const sleepSvc = this.child.sleep?.svc || this.accessory.getServiceById(Service.Switch, 'mode-Sleep');
    sleepSvc?.updateCharacteristic(Characteristic.On, powerOn && sleepOn);

    const favSvc = this.child.fav?.svc || this.accessory.getServiceById(Service.Switch, 'mode-Favorite');
    favSvc?.updateCharacteristic(Characteristic.On, powerOn && favOn);

    // === Filter Life Level → FilterMaintenance 서비스로 이동 (경고 제거) ===
    if (this.filterSvc && isFiniteNumber(this.state.filter1_life)) {
      this.filterSvc.updateCharacteristic(Characteristic.FilterLifeLevel, Number(this.state.filter1_life));
    }
  }
}

// ===== helpers =====
function clamp(n, a, b) { return Math.max(a, Math.min(b, n)); }
function isFiniteNumber(v) { return typeof v === 'number' && Number.isFinite(v); }
function capitalize(s) {
  const t = String(s || '');
  return t.charAt(0).toUpperCase() + t.slice(1);
}
function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }
