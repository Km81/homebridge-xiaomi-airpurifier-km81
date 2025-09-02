# homebridge-xiaomi-airpurifier

최신 Homebridge 및 Node.js 환경에 최적화된 Xiaomi Mi Air Purifier 2S 및 Pro를 위한 현대적인 단일 파일 Homebridge 플러그인입니다.

이 플러그인은 [YinHangCode/homebridge-mi-airpurifier](https://github.com/YinHangCode/homebridge-mi-airpurifier)의 원본 작업을 기반으로 완전히 재작성되었습니다.

## 지원 기기
* Xiaomi Mi Air Purifier 2S (zhimi.airpurifier.ma2)
* Xiaomi Mi Air Purifier Pro (zhimi.airpurifier.v6)

---

## 설치 방법

1.  공식 설명서에 따라 Homebridge를 설치하세요.
2.  다음 명령어를 사용하여 이 플러그인을 설치하세요:
    ```bash
    npm install -g @km81/homebridge-xiaomi-airpurifier
    ```
    
---

## 설정 방법

`config.json` 파일에 아래 플랫폼 설정을 추가하세요:

```json
"platforms": [
    {
        "platform": "XiaomiAirPurifierPlatform",
        "deviceCfgs": [
            {
                "type": "MiAirPurifier2S",
                "ip": "192.168.1.XX",
                "token": "YOUR_32_CHARACTER_TOKEN",
                "name": "거실 공기청정기",
                "showTemperature": true,
                "temperatureName": "거실 온도",
                "showHumidity": true,
                "humidityName": "거실 습도",
                "showAirQuality": true,
                "airQualityName": "거실 공기질",
                "showModeSwitches": true
            }
        ]
    }
]
```

### 설정 항목 설명

* **platform**: 반드시 `"XiaomiAirPurifierPlatform"` 이어야 합니다.
* **deviceCfgs**: 사용 중인 공기청정기 기기 목록을 배열 형태로 입력합니다.
    * **name**: HomeKit에 표시될 공기청정기의 기본 이름입니다. (필수)
    * **ip**: 공기청정기의 고정 IP 주소입니다. (필수)
    * **token**: 32자리 Mi Home 기기 토큰입니다. (필수)
    * **type**: 기기 모델명입니다. `"MiAirPurifier2S"` 또는 `"MiAirPurifierPro"` 중 하나를 선택합니다. (필수)
    * **showTemperature** (선택 사항, 기본값: `true`): 온도 센서를 표시할지 여부를 결정합니다.
    * **temperatureName** (선택 사항): 온도 센서의 이름을 별도로 지정합니다. 지정하지 않으면 '공기청정기 이름 + Temperature'로 표시됩니다.
    * **showHumidity** (선택 사항, 기본값: `true`): 습도 센서를 표시할지 여부를 결정합니다.
    * **humidityName** (선택 사항): 습도 센서의 이름을 별도로 지정합니다.
    * **showAirQuality** (선택 사항, 기본값: `true`): 공기질 센서를 표시할지 여부를 결정합니다.
    * **airQualityName** (선택 사항): 공기질 센서의 이름을 별도로 지정합니다.
    * **showLED** (선택 사항, 기본값: `false`): 기기 LED 화면을 제어하는 스위치를 표시합니다.
    * **showBuzzer** (선택 사항, 기본값: `false`): 기기 부저(알림음)를 제어하는 스위치를 표시합니다.
    * **showModeSwitches** (선택 사항, 기본값: `false`): 자동/수면/선호 모드를 제어하는 3개의 개별 스위치를 표시합니다. **이 스위치들은 기기의 실제 작동 모드를 실시간으로 반영하여 해당 스위치가 켜진 상태를 유지하며, 하나를 켜면 나머지는 자동으로 꺼집니다.**

---

## 토큰(Token) 추출 방법

Mi Home 앱 백업에서 토큰을 추출하려면 [python-miio](https://python-miio.readthedocs.io/en/latest/discovery.html#getting-the-token) 도구나 커뮤니티에서 제공하는 다른 방법을 사용할 수 있습니다.
