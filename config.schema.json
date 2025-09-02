{
  "pluginAlias": "XiaomiAirPurifierPlatform",
  "pluginType": "platform",
  "singular": true,
  "schema": {
    "type": "object",
    "required": ["deviceCfgs"],
    "properties": {
      "deviceCfgs": {
        "title": "Devices",
        "type": "array",
        "minItems": 1,
        "items": {
          "type": "object",
          "required": ["name", "ip", "token", "type"],
          "properties": {
            "name": { "title": "Name (공기청정기 이름)", "type": "string", "default": "Air Purifier" },
            "ip": { "title": "IP Address", "type": "string", "format": "ipv4" },
            "token": { "title": "Token", "type": "string", "pattern": "^[A-Fa-f0-9]{32}$", "description": "miio 32자리 HEX 토큰" },
            "type": {
              "title": "Model (모델)",
              "type": "string",
              "oneOf": [
                { "title": "Mi Air Purifier 2S", "enum": ["MiAirPurifier2S"] },
                { "title": "Mi Air Purifier Pro", "enum": ["MiAirPurifierPro"] }
              ]
            },
            "serialNumber": {
              "title": "Serial Number (일련번호)",
              "type": "string",
              "description": "HomeKit 액세서리 정보에 표시될 일련번호 (미입력 시 IP 사용)"
            },

            "showTemperature": { "title": "Show Temperature Sensor (온도 센서 표시)", "type": "boolean", "default": true },
            "separateTemperatureAccessory": { "title": "Separate Temperature Accessory (온도 별도 악세서리)", "type": "boolean", "default": false, "condition": { "key": "showTemperature", "value": true } },
            "temperatureName": { "title": "Temperature Sensor Name (온도 센서 이름)", "type": "string", "condition": { "key": "showTemperature", "value": true } },

            "showHumidity": { "title": "Show Humidity Sensor (습도 센서 표시)", "type": "boolean", "default": true },
            "separateHumidityAccessory": { "title": "Separate Humidity Accessory (습도 별도 악세서리)", "type": "boolean", "default": false, "condition": { "key": "showHumidity", "value": true } },
            "humidityName": { "title": "Humidity Sensor Name (습도 센서 이름)", "type": "string", "condition": { "key": "showHumidity", "value": true } },

            "showAirQuality": { "title": "Show Air Quality Sensor (공기질 센서 표시)", "type": "boolean", "default": true },
            "separateAirQualityAccessory": { "title": "Separate Air Quality Accessory (공기질 별도 악세서리)", "type": "boolean", "default": false, "condition": { "key": "showAirQuality", "value": true } },
            "airQualityName": { "title": "Air Quality Sensor Name (공기질 센서 이름)", "type": "string", "condition": { "key": "showAirQuality", "value": true } },
            "airQualityThresholds": {
              "title": "Air Quality Thresholds (공기질 임계값 4개: 아주좋음/좋음/보통/나쁨 상한)",
              "description": "예: 5 / 15 / 35 / 55 → ≤5 매우 좋음(1), ≤15 좋음(2), ≤35 보통(3), ≤55 나쁨(4), 초과 매우 나쁨(5)",
              "type": "object",
              "properties": {
                "t1": { "title": "상한 1 (매우 좋음→좋음)", "type": "number", "default": 5, "minimum": 0 },
                "t2": { "title": "상한 2 (좋음→보통)", "type": "number", "default": 15, "minimum": 0 },
                "t3": { "title": "상한 3 (보통→나쁨)", "type": "number", "default": 35, "minimum": 0 },
                "t4": { "title": "상한 4 (나쁨→매우 나쁨)", "type": "number", "default": 55, "minimum": 0 }
              },
              "required": ["t1", "t2", "t3", "t4"],
              "condition": { "key": "showAirQuality", "value": true }
            },

            "showLED": { "title": "Show LED Control Switch (LED 제어 스위치 표시)", "type": "boolean", "default": false },
            "separateLedAccessory": { "title": "Separate LED Accessory (LED 별도 악세서리)", "type": "boolean", "default": false, "condition": { "key": "showLED", "value": true } },
            "ledName": { "title": "LED Switch Name (LED 스위치 이름)", "type": "string", "condition": { "key": "showLED", "value": true } },

            "showBuzzer": { "title": "Show Buzzer Control Switch (부저 제어 스위치 표시)", "type": "boolean", "default": false },
            "separateBuzzerAccessory": { "title": "Separate Buzzer Accessory (부저 별도 악세서리)", "type": "boolean", "default": false, "condition": { "key": "showBuzzer", "value": true } },
            "buzzerName": { "title": "Buzzer Switch Name (부저 스위치 이름)", "type": "string", "condition": { "key": "showBuzzer", "value": true } },

            "showAutoModeSwitch": { "title": "Show Auto Mode Switch (자동 모드 스위치 표시)", "type": "boolean", "default": false },
            "separateAutoModeAccessory": { "title": "Separate Auto Mode Accessory (자동 모드 별도 악세서리)", "type": "boolean", "default": false, "condition": { "key": "showAutoModeSwitch", "value": true } },
            "autoModeName": { "title": "Auto Mode Switch Name (자동 모드 스위치 이름)", "type": "string", "condition": { "key": "showAutoModeSwitch", "value": true } },

            "showSleepModeSwitch": { "title": "Show Sleep Mode Switch (수면 모드 스위치 표시)", "type": "boolean", "default": false },
            "separateSleepModeAccessory": { "title": "Separate Sleep Mode Accessory (수면 모드 별도 악세서리)", "type": "boolean", "default": false, "condition": { "key": "showSleepModeSwitch", "value": true } },
            "sleepModeName": { "title": "Sleep Mode Switch Name (수면 모드 스위치 이름)", "type": "string", "condition": { "key": "showSleepModeSwitch", "value": true } },

            "showFavoriteModeSwitch": { "title": "Show Favorite Mode Switch (선호 모드 스위치 표시)", "type": "boolean", "default": false },
            "separateFavoriteModeAccessory": { "title": "Separate Favorite Mode Accessory (선호 모드 별도 악세서리)", "type": "boolean", "default": false, "condition": { "key": "showFavoriteModeSwitch", "value": true } },
            "favoriteModeName": { "title": "Favorite Mode Switch Name (선호 모드 스위치 이름)", "type": "string", "condition": { "key": "showFavoriteModeSwitch", "value": true } }
          }
        }
      }
    }
  },
  "layout": [
    {
      "key": "deviceCfgs",
      "type": "array",
      "title": "기기 목록 (ADD DEVICE 버튼으로 추가)",
      "items": [
        "deviceCfgs[].name",
        "deviceCfgs[].ip",
        "deviceCfgs[].token",
        "deviceCfgs[].type",
        "deviceCfgs[].serialNumber",

        "deviceCfgs[].showTemperature",
        "deviceCfgs[].separateTemperatureAccessory",
        "deviceCfgs[].temperatureName",

        "deviceCfgs[].showHumidity",
        "deviceCfgs[].separateHumidityAccessory",
        "deviceCfgs[].humidityName",

        "deviceCfgs[].showAirQuality",
        "deviceCfgs[].separateAirQualityAccessory",
        "deviceCfgs[].airQualityName",
        "deviceCfgs[].airQualityThresholds.t1",
        "deviceCfgs[].airQualityThresholds.t2",
        "deviceCfgs[].airQualityThresholds.t3",
        "deviceCfgs[].airQualityThresholds.t4",

        "deviceCfgs[].showLED",
        "deviceCfgs[].separateLedAccessory",
        "deviceCfgs[].ledName",

        "deviceCfgs[].showBuzzer",
        "deviceCfgs[].separateBuzzerAccessory",
        "deviceCfgs[].buzzerName",

        "deviceCfgs[].showAutoModeSwitch",
        "deviceCfgs[].separateAutoModeAccessory",
        "deviceCfgs[].autoModeName",

        "deviceCfgs[].showSleepModeSwitch",
        "deviceCfgs[].separateSleepModeAccessory",
        "deviceCfgs[].sleepModeName",

        "deviceCfgs[].showFavoriteModeSwitch",
        "deviceCfgs[].separateFavoriteModeAccessory",
        "deviceCfgs[].favoriteModeName"
      ]
    }
  ]
}
