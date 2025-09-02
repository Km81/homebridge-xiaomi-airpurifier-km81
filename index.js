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
    this.config = config || {};
    this.api = api;
    this.accessories = [];
    this.log.info(`[샤오미 공기청정기] 플랫폼 초기화 v${packageJson.version}`);
    this.api.on('didFinishLaunching', () => this.discoverDevices());
  }

  configureAccessory(accessory) {
    this.log.info(`[샤오미 공기청정기] 캐시에서 악세서리 로드: ${accessory.displayName}`);
    this.accessories.push(accessory);
  }

  discoverDevices() {
    const configuredDevices = this.config.deviceCfgs || [];
    // "메인 악세서리"만 추적 (자식은 제거 대상에서 제외)
    const foundMainUUIDs = new Set();

    for (const deviceConfig of configuredDevices) {
      if (!deviceConfig || !deviceConfig.ip || !deviceConfig.token || !deviceConfig.name || !deviceConfig.type) {
        this.log.warn('[샤오미 공기청정기] 설정 항목에 ip/token/name/type 누락이 있어 건너뜁니다.');
        continue;
      }

      const supportedModels = ['MiAirPurifier2S', 'MiAirPurifierPro'];
      if (!supportedModels.includes(deviceConfig.type)) {
        this.log.warn(`[샤오미 공기청정기] 지원하지 않는 모델: ${deviceConfig.type} (건너뜀)`);
        continue;
      }

      const uuid = UUIDGen.generate(deviceConfig.ip);
      const existingAccessory = this.accessories.find((acc) => acc.UUID === uuid);

      if (existingAccessory) {
        this.log.info(`[샤오미 공기청정기] 기존 악세서리 복원: ${existingAccessory.displayName}`);
        existingAccessory.context.device = deviceConfig;
        existingAccessory.context.isChild = false; // 메인 표시
        new DeviceHandler(this, existingAccessory);
        foundMainUUIDs.add(existingAccessory.UUID);
      } else {
        this.log.info(`[샤오미 공기청정기] 새 악세서리 추가: ${deviceConfig.name}`);
        const accessory = new PlatformAccessory(deviceConfig.name, uuid);
        accessory.context.device = deviceConfig;
        accessory.context.isChild = false; // 메인 표시
        new DeviceHandler(this, accessory);
        this.api.registerPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [accessory]);
        this.accessories.push(accessory); // 새로 만든 것도 내부 배열에 넣어줌
        foundMainUUIDs.add(accessory.UUID);
      }
    }

    // ⚠️ 캐시 정리: 메인 악세서리만 대상. 자식(acc.context.isChild===true)은 유지!
    const accessoriesToUnregister = this.accessories.filter(
      (acc) => acc.context?.isChild !== true && !foundMainUUIDs.has(acc.UUID)
    );
    if (accessoriesToUnregister.length > 0) {
      this.log.info(`[샤오미 공기청정기] 사용하지 않는 메인 악세서리 ${accessoriesToUnregister.length}개 등록 해제`);
      this.api.unregisterPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, accessoriesToUnregister);
      this.accessories = this.accessories.filter((acc) => !accessoriesToUnregister.includes(acc));
    }
  }
}

class DeviceHandler {
  constructor(platform, accessory) {
    this.platform = platform;
    this.log = platform.log;
    this.accessory = accessory;             // 메인 악세서리 (AirPurifier 본체)
    this.config = accessory.context.device || {};
    this.device = null;
    this.state = {};                        // 캐시된 기기 상태
    this.pollInterval = null;

    this.maxFavoriteLevel = this.config.type === 'MiAirPurifier2S' ? 14 : 16;

    // 공기질 임계값
    this.aqThresholds = this.parseAqThresholds(this.config.airQualityThresholds);

    // 자식 악세서리 레퍼런스
    this.children = { temp: null, hum: null, aq: null, led: null, buzzer: null, auto: null, sleep: null, fav: null };

    this.setupServices();
    this.connect();
  }

  // ===== Helpers =====
  prefix(msg) { return `[${this.config.name}] ${msg}`; }

  parseAqThresholds(conf) {
    const def = [5, 15, 35, 55];
    if (conf && typeof conf === 'object' && !Array.isArray(conf)) {
      const cand = [conf.t1, conf.t2, conf.t3, conf.t4].map((v) => Number(v));
      if (cand.every((v) => Number.isFinite(v) && v >= 0) && cand[0] <= cand[1] && cand[1] <= cand[2] && cand[2] <= cand[3]) return cand;
    }
    if (Array.isArray(conf) && conf.length === 4) {
      const cand = conf.map((v) => Number(v));
      if (cand.every((v) => Number.isFinite(v) && v >= 0) && cand[0] <= cand[1] && cand[1] <= cand[2] && cand[2] <= cand[3]) return cand;
    }
    return def;
  }

  mapAqiToHomeKitLevel(aqi, t) {
    if (!Number.isFinite(aqi)) return Characteristic.AirQuality.UNKNOWN; // 0
    if (aqi <= t[0]) return Characteristic.AirQuality.EXCELLENT; // 1
    if (aqi <= t[1]) return Characteristic.AirQuality.GOOD;      // 2
    if (aqi <= t[2]) return Characteristic.AirQuality.FAIR;      // 3
    if (aqi <= t[3]) return Characteristic.AirQuality.INFERIOR;  // 4
    return Characteristic.AirQuality.POOR;                        // 5
  }

  setServiceName(service, name) {
    try { service.updateCharacteristic(Characteristic.Name, name); } catch (_) {}
    try { if (Characteristic.ConfiguredName) service.updateCharacteristic(Characteristic.ConfiguredName, name); } catch (_) {}
  }

  getChildUUID(suffix) { return UUIDGen.generate(`${this.config.ip}-${suffix}`); }

  ensureChildAccessory(suffix, displayName, serviceType) {
    const uuid = this.getChildUUID(suffix);
    let acc = this.platform.accessories.find((a) => a.UUID === uuid);
    if (!acc) {
      acc = new PlatformAccessory(displayName, uuid);
      acc.context.device = this.config;
      acc.context.isChild = true; // ✅ 자식 표시
      this.platform.api.registerPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [acc]);
      this.platform.accessories.push(acc);
      this.log.info(this.prefix(`자식 악세서리 추가: ${displayName}`));
    } else {
      acc.context.isChild = true; // 캐시 복원 시에도 플래그 유지
      const existingSvc = acc.getService(serviceType);
      if (existingSvc) this.setServiceName(existingSvc, displayName);
    }
    return acc;
  }

  removeChildAccessory(suffix) {
    const uuid = this.getChildUUID(suffix);
    const acc = this.platform.accessories.find((a) => a.UUID === uuid);
    if (acc) {
      this.platform.api.unregisterPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [acc]);
      this.platform.accessories = this.platform.accessories.filter((a) => a.UUID !== uuid);
      this.log.info(this.prefix(`자식 악세서리 제거: ${acc.displayName}`));
    }
  }

  isMethodNotFound(err) { return err && typeof err.message === 'string' && /method not found/i.test(err.message); }

  // ===== Device I/O =====
  async connect() {
    try {
      this.log.info(this.prefix(`연결 시도... (${this.config.ip})`));
      this.device = await miio.device({ address: this.config.ip, token: this.config.token });
      this.log.info(this.prefix('연결 성공'));
      clearInterval(this.pollInterval);
      this.pollDeviceState(); // 즉시 1회 폴링
      this.pollInterval = setInterval(() => this.pollDeviceState(), POLLING_INTERVAL);
    } catch (e) {
      this.log.error(this.prefix(`연결 실패 (30초 후 재시도): ${e.message}`));
      setTimeout(() => this.connect(), 30000);
    }
  }

  async pollDeviceState() {
    if (!this.device) return;
    try {
      const props = ['power', 'mode', 'aqi', 'temp_dec', 'humidity', 'filter1_life', 'favorite_level', 'led', 'buzzer'];
      const values = await this.device.call('get_prop', props);
      props.forEach((prop, i) => { this.state[prop] = values[i]; });
      this.updateAllCharacteristics();
    } catch (e) {
      this.log.error(this.prefix(`상태 폴링 실패: ${e.message}`));
    }
  }

  async setPropertyValue(method, value) {
    if (!this.device) throw new Error('Device not connected');
    try {
      const result = await this.device.call(method, value);
      if (!Array.isArray(result) || result[0] !== 'ok') throw new Error(`기기 오류: ${Array.isArray(result) ? result[0] : String(result)}`);
      setTimeout(() => this.pollDeviceState(), 250);
    } catch (e) {
      if (this.isMethodNotFound(e)) {
        this.log.warn(this.prefix(`이 기기는 메서드 '${method}'를 지원하지 않습니다.`));
      } else {
        this.log.error(this.prefix(`'${method}' 호출 실패: ${e.message}`));
        this.connect();
      }
      throw e;
    }
  }

  // ★ 속도 설정: set_level_favorite 고정 사용
  async setFavoriteLevelPercent(percent) {
    const level = Math.max(0, Math.min(100, Number(percent)));
    const target = Math.max(1, Math.min(this.maxFavoriteLevel, Math.round((level / 100) * this.maxFavoriteLevel)));

    // 수동(favorite) 모드로 전환 후 레벨 설정
    try {
      if (this.state.mode !== 'favorite') await this.setPropertyValue('set_mode', ['favorite']);
    } catch (e) {
      if (!this.isMethodNotFound(e)) this.log.warn(this.prefix(`favorite 모드 전환 실패(무시): ${e.message}`));
    }

    try {
      await this.setPropertyValue('set_level_favorite', [target]);
      this.log.info(this.prefix(`속도 조정 : ${target}/${this.maxFavoriteLevel} (${level}%)`));
    } catch (e) {
      this.log.warn(this.prefix(`'set_level_favorite' 미지원/실패로 속도 조정 불가`));
    }
  }

  // ===== Services / Accessories =====
  setupServices() {
    this.setupAccessoryInfo();
    this.setupAirPurifierMain();

    // Temperature
    if (this.config.showTemperature !== false) {
      if (this.config.separateTemperatureAccessory === true) {
        const name = this.config.temperatureName || `${this.config.name} Temperature`;
        const child = this.ensureChildAccessory('temp', name, Service.TemperatureSensor);
        const svc = child.getService(Service.TemperatureSensor) || child.addService(Service.TemperatureSensor, name);
        this.setServiceName(svc, name);
        this.children.temp = { acc: child, svc };
        const main = this.accessory.getServiceById(Service.TemperatureSensor, 'Temperature');
        if (main) this.accessory.removeService(main);
      } else {
        this.children.temp = null;
        let svc = this.accessory.getServiceById(Service.TemperatureSensor, 'Temperature');
        if (!svc) {
          const name = this.config.temperatureName || `${this.config.name} Temperature`;
          svc = this.accessory.addService(Service.TemperatureSensor, name, 'Temperature');
          this.setServiceName(svc, name);
        }
      }
    } else {
      const main = this.accessory.getServiceById(Service.TemperatureSensor, 'Temperature');
      if (main) this.accessory.removeService(main);
      this.removeChildAccessory('temp'); this.children.temp = null;
    }

    // Humidity
    if (this.config.showHumidity !== false) {
      if (this.config.separateHumidityAccessory === true) {
        const name = this.config.humidityName || `${this.config.name} Humidity`;
        const child = this.ensureChildAccessory('hum', name, Service.HumiditySensor);
        const svc = child.getService(Service.HumiditySensor) || child.addService(Service.HumiditySensor, name);
        this.setServiceName(svc, name);
        this.children.hum = { acc: child, svc };
        const main = this.accessory.getServiceById(Service.HumiditySensor, 'Humidity');
        if (main) this.accessory.removeService(main);
      } else {
        this.children.hum = null;
        let svc = this.accessory.getServiceById(Service.HumiditySensor, 'Humidity');
        if (!svc) {
          const name = this.config.humidityName || `${this.config.name} Humidity`;
          svc = this.accessory.addService(Service.HumiditySensor, name, 'Humidity');
          this.setServiceName(svc, name);
        }
      }
    } else {
      const main = this.accessory.getServiceById(Service.HumiditySensor, 'Humidity');
      if (main) this.accessory.removeService(main);
      this.removeChildAccessory('hum'); this.children.hum = null;
    }

    // Air Quality
    if (this.config.showAirQuality !== false) {
      if (this.config.separateAirQualityAccessory === true) {
        const name = this.config.airQualityName || `${this.config.name} Air Quality`;
        const child = this.ensureChildAccessory('aq', name, Service.AirQualitySensor);
        const svc = child.getService(Service.AirQualitySensor) || child.addService(Service.AirQualitySensor, name);
        this.setServiceName(svc, name);
        this.children.aq = { acc: child, svc };
        const main = this.accessory.getServiceById(Service.AirQualitySensor, 'AirQuality');
        if (main) this.accessory.removeService(main);
      } else {
        this.children.aq = null;
        let svc = this.accessory.getServiceById(Service.AirQualitySensor, 'AirQuality');
        if (!svc) {
          const name = this.config.airQualityName || `${this.config.name} Air Quality`;
          svc = this.accessory.addService(Service.AirQualitySensor, name, 'AirQuality');
          this.setServiceName(svc, name);
        }
      }
    } else {
      const main = this.accessory.getServiceById(Service.AirQualitySensor, 'AirQuality');
      if (main) this.accessory.removeService(main);
      this.removeChildAccessory('aq'); this.children.aq = null;
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
          if (this.config.type === 'MiAirPurifierPro') await this.setPropertyValue('set_led_b', [v ? 0 : 2]);
          else await this.setPropertyValue('set_led', [v ? 'on' : 'off']);
        });
      } else {
        this.children.led = null;
        let svc = this.accessory.getServiceById(Service.Switch, 'LED');
        if (!svc) {
          const name = this.config.ledName || `${this.config.name} LED`;
          svc = this.accessory.addService(Service.Switch, name, 'LED');
          this.setServiceName(svc, name);
          svc.getCharacteristic(Characteristic.On).onSet(async (v) => {
            if (this.config.type === 'MiAirPurifierPro') await this.setPropertyValue('set_led_b', [v ? 0 : 2]);
            else await this.setPropertyValue('set_led', [v ? 'on' : 'off']);
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
          await this.setPropertyValue('set_buzzer', [v ? 'on' : 'off']);
        });
      } else {
        this.children.buzzer = null;
        let svc = this.accessory.getServiceById(Service.Switch, 'Buzzer');
        if (!svc) {
          const name = this.config.buzzerName || `${this.config.name} Buzzer`;
          svc = this.accessory.addService(Service.Switch, name, 'Buzzer');
          this.setServiceName(svc, name);
          svc.getCharacteristic(Characteristic.On).onSet(async (v) => {
            await this.setPropertyValue('set_buzzer', [v ? 'on' : 'off']);
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
          if (v) await this.setPropertyValue('set_mode', ['auto']);
          else if (this.state.mode === 'auto') await this.setPropertyValue('set_mode', ['favorite']);
        });
      } else {
        this.children.auto = null;
        let svc = this.accessory.getServiceById(Service.Switch, 'AutoMode');
        if (!svc) {
          const name = this.config.autoModeName || `${this.config.name} Auto Mode`;
          svc = this.accessory.addService(Service.Switch, name, 'AutoMode');
          this.setServiceName(svc, name);
          svc.getCharacteristic(Characteristic.On).onSet(async (v) => {
            if (v) await this.setPropertyValue('set_mode', ['auto']);
            else if (this.state.mode === 'auto') await this.setPropertyValue('set_mode', ['favorite']);
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
          if (v) await this.setPropertyValue('set_mode', ['silent']);
          else if (this.state.mode === 'silent') await this.setPropertyValue('set_mode', ['favorite']);
        });
      } else {
        this.children.sleep = null;
        let svc = this.accessory.getServiceById(Service.Switch, 'SleepMode');
        if (!svc) {
          const name = this.config.sleepModeName || `${this.config.name} Sleep Mode`;
          svc = this.accessory.addService(Service.Switch, name, 'SleepMode');
          this.setServiceName(svc, name);
          svc.getCharacteristic(Characteristic.On).onSet(async (v) => {
            if (v) await this.setPropertyValue('set_mode', ['silent']);
            else if (this.state.mode === 'silent') await this.setPropertyValue('set_mode', ['favorite']);
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
          if (v) await this.setPropertyValue('set_mode', ['favorite']);
          else if (this.state.mode === 'favorite') await this.setPropertyValue('set_mode', ['auto']);
        });
      } else {
        this.children.fav = null;
        let svc = this.accessory.getServiceById(Service.Switch, 'FavoriteMode');
        if (!svc) {
          const name = this.config.favoriteModeName || `${this.config.name} Favorite Mode`;
          svc = this.accessory.addService(Service.Switch, name, 'FavoriteMode');
          this.setServiceName(svc, name);
          svc.getCharacteristic(Characteristic.On).onSet(async (v) => {
            if (v) await this.setPropertyValue('set_mode', ['favorite']);
            else if (this.state.mode === 'favorite') await this.setPropertyValue('set_mode', ['auto']);
          });
        }
      }
    } else {
      const main = this.accessory.getServiceById(Service.Switch, 'FavoriteMode');
      if (main) this.accessory.removeService(main);
      this.removeChildAccessory('mode-fav'); this.children.fav = null;
    }
  }

  setupAccessoryInfo() {
    const info = this.accessory.getService(Service.AccessoryInformation);
    info.setCharacteristic(Characteristic.Manufacturer, 'Xiaomi')
        .setCharacteristic(Characteristic.Model, this.config.type || 'Unknown')
        .setCharacteristic(Characteristic.SerialNumber, this.config.serialNumber || this.config.ip || 'Unknown');

    // 펌웨어 버전 = 플러그인 버전
    try { info.setCharacteristic(Characteristic.FirmwareRevision, packageJson.version); } catch (_) {}
  }

  setupAirPurifierMain() {
    const service =
      this.accessory.getService(Service.AirPurifier) ||
      this.accessory.addService(Service.AirPurifier, this.config.name);
    this.setServiceName(service, this.config.name);

    service.getCharacteristic(Characteristic.Active)
      .onSet(async (v) => this.setPropertyValue('set_power', [v ? 'on' : 'off']));

    // 0=MANUAL, 1=AUTO → AUTO=auto, MANUAL=favorite
    service.getCharacteristic(Characteristic.TargetAirPurifierState)
      .onSet(async (v) => this.setPropertyValue('set_mode', [
        v === Characteristic.TargetAirPurifierState.AUTO ? 'auto' : 'favorite'
      ]));

    // 속도 슬라이더 → favorite 레벨로 (set_level_favorite 고정)
    service.getCharacteristic(Characteristic.RotationSpeed)
      .onSet(async (v) => this.setFavoriteLevelPercent(Number(v)));
  }

  // ===== Runtime updates =====
  updateAllCharacteristics() {
    // Air Purifier main
    const svcAp = this.accessory.getService(Service.AirPurifier);
    if (svcAp) {
      const powerOn = this.state.power === 'on';
      svcAp.updateCharacteristic(Characteristic.Active, powerOn ? 1 : 0);

      // 표시: auto만 자동, favorite/silent은 수동
      const isAuto = this.state.mode === 'auto';
      svcAp.updateCharacteristic(
        Characteristic.TargetAirPurifierState,
        isAuto ? Characteristic.TargetAirPurifierState.AUTO : Characteristic.TargetAirPurifierState.MANUAL
      );

      svcAp.updateCharacteristic(
        Characteristic.CurrentAirPurifierState,
        powerOn ? Characteristic.CurrentAirPurifierState.PURIFYING_AIR : Characteristic.CurrentAirPurifierState.INACTIVE
      );

      const fav = Number(this.state.favorite_level);
      const speed = Number.isFinite(fav) ? Math.max(0, Math.min(100, Math.round((fav / this.maxFavoriteLevel) * 100))) : 0;
      svcAp.updateCharacteristic(Characteristic.RotationSpeed, speed);

      const life = Number(this.state.filter1_life);
      if (Number.isFinite(life)) {
        svcAp.updateCharacteristic(Characteristic.FilterLifeLevel, life);
        svcAp.updateCharacteristic(Characteristic.FilterChangeIndication, life < 5 ? 1 : 0);
      }
    }

    // Temperature
    const tempVal = Number(this.state.temp_dec);
    const tempC = Number.isFinite(tempVal) ? tempVal / 10 : 0;
    const tChild = this.children.temp?.svc;
    const tMain = this.accessory.getServiceById(Service.TemperatureSensor, 'Temperature');
    (tChild || tMain)?.updateCharacteristic(Characteristic.CurrentTemperature, tempC);

    // Humidity
    const humVal = Number(this.state.humidity);
    const hChild = this.children.hum?.svc;
    const hMain = this.accessory.getServiceById(Service.HumiditySensor, 'Humidity');
    (hChild || hMain)?.updateCharacteristic(Characteristic.CurrentRelativeHumidity, Number.isFinite(humVal) ? humVal : 0);

    // Air Quality
    const aqi = Number(this.state.aqi);
    const aqLevel = this.mapAqiToHomeKitLevel(aqi, this.aqThresholds);
    const aqChild = this.children.aq?.svc;
    const aqMain = this.accessory.getServiceById(Service.AirQualitySensor, 'AirQuality');
    if (aqChild || aqMain) {
      (aqChild || aqMain).updateCharacteristic(Characteristic.AirQuality, aqLevel);
      if (Number.isFinite(aqi)) (aqChild || aqMain).updateCharacteristic(Characteristic.PM2_5Density, aqi);
    }

    // LED
    const ledChild = this.children.led?.svc;
    const ledMain = this.accessory.getServiceById(Service.Switch, 'LED');
    (ledChild || ledMain)?.updateCharacteristic(Characteristic.On, this.state.led === 'on');

    // Buzzer
    const buzChild = this.children.buzzer?.svc;
    const buzMain = this.accessory.getServiceById(Service.Switch, 'Buzzer');
    (buzChild || buzMain)?.updateCharacteristic(Characteristic.On, this.state.buzzer === 'on');

    // Modes
    const autoOn = this.state.mode === 'auto';
    const sleepOn = this.state.mode === 'silent';
    const favOn = this.state.mode === 'favorite';

    const autoChild = this.children.auto?.svc;
    const autoMain = this.accessory.getServiceById(Service.Switch, 'AutoMode');
    (autoChild || autoMain)?.updateCharacteristic(Characteristic.On, autoOn);

    const sleepChild = this.children.sleep?.svc;
    const sleepMain = this.accessory.getServiceById(Service.Switch, 'SleepMode');
    (sleepChild || sleepMain)?.updateCharacteristic(Characteristic.On, sleepOn);

    const favChild = this.children.fav?.svc;
    const favMain = this.accessory.getServiceById(Service.Switch, 'FavoriteMode');
    (favChild || favMain)?.updateCharacteristic(Characteristic.On, favOn);
  }
}
