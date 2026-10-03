# 診斷 telemetry（App 本機格式）

本文件描述 debug App 的**裝置與 App 狀態診斷紀錄**：電量、充電、可觀測的螢幕狀態、App 前後台、定位服務啟停與恢復事件。用途只有一個——事後判讀某次採集當時裝置處於什麼狀態。

## 1. 這不是契約，也不是穩定性證明

- 本格式**不屬於** `contracts/`，不是 `location-log` v1，也不是網路協定。它是 `packages/device_bridge` 寫出、`apps/mobile` 顯示的本機診斷檔，版本欄位為 `telemetryVersion`，與 `schemaVersion` 無關。
- telemetry 有紀錄**不代表**背景採集穩定。它只說明「作業系統在我們還在執行時告訴我們什麼」。程序被系統終止期間不會有任何 telemetry，缺口本身也不是採集中斷的證據。
- 若要把其中任何欄位放進 `location-log` v1 的樣本或事件，必須先走 `docs/engineering-rules.md` §5 的契約流程。目前沒有這樣的欄位。

## 2. 與 location-log v1 的分界

| 項目 | location-log v1 | diagnostics telemetry |
|---|---|---|
| 擁有者／流程 | `contracts/`，契約 PR | App 本機格式，不進契約 |
| 版本欄位 | `schemaVersion: 1` | `telemetryVersion: 1` |
| `recordType` | `sample`／`event` | `diagnostics_telemetry` |
| 序號 | `sequence`，`(recordingId, sourceId)` 唯一 | `telemetrySequence`，自己的序號空間 |
| 檔案 | `recordings/<recordingId>.ndjson` | `diagnostics/<recordingId>.telemetry.ndjson` |
| 位置資料 | 必填 `latDeg`／`lonDeg` | **一律沒有**，出現即視為錯誤 |

落實方式：

1. **兩個檔案、兩個目錄、兩個寫入器**。telemetry 從不追加到定位紀錄檔，定位樣本與事件的欄位、`recordType`、`eventType` 與序號規則完全未變。
2. `telemetrySequence` 自 `0` 起算，**不佔用也不影響** `sequence`。telemetry 只以 `locationLogLastSequence` 唯讀記下當時已寫出的最後一個定位樣本序號（第一筆之前為 `-1`），方便把兩份檔案對齊時間軸。
3. 匯出時兩種格式**分開分享**，各有自己的說明文字（見 §7）。
4. 若誰不小心把 telemetry 檔餵給 `contracts/tools/validate-location-log.mjs`，依契約 §4 對未知 `recordType` 的規定，它會回報 `0 samples, 0 events` 與 `UNKNOWN_RECORD_TYPE` 警告並保留該行——不會失敗，也不會被誤算成定位資料。

`packages/device_bridge/test/native_telemetry_alignment_test.dart` 以 static validation 擋住上述界線：Kotlin 與 Swift 寫入器的欄位集合必須與 Dart 讀取器一致，且兩者都不得出現座標欄位或 `schemaVersion`／`eventType`／`lastSequence`。

## 3. 檔案格式

- UTF-8 NDJSON，每行一個 JSON 物件並以 `\n` 結尾；只追加，不改寫既有行。
- 空白行必須被略過，不計為錯誤。
- 檔案可能在任意位置被截斷（崩潰、斷電）。續錄前寫入端截斷至最後一個完整換行，並在下一筆的 `recoveredTruncatedBytes` 記下丟掉的位元組數；讀取端把不完整的末行報成 `INCOMPLETE_TAIL_LINE` 警告，不是損壞。
- 完整但無法解析的行**保留原樣**，讀取端計數為壞行。診斷檔不值得為了整潔而銷毀。

路徑：

| 平台 | 路徑 |
|---|---|
| Android | `<filesDir>/diagnostics/<recordingId>.telemetry.ndjson` |
| iOS | `Documents/diagnostics/<recordingId>.telemetry.ndjson`（排除備份、`completeUntilFirstUserAuthentication`） |

實際絕對路徑由 `status.telemetryPath` 回報，診斷畫面也會顯示是否可匯出。

## 4. 欄位

| 欄位 | 型別 | 說明 |
|---|---|---|
| `telemetryVersion` | int | 固定 `1` |
| `recordType` | string | 固定 `diagnostics_telemetry` |
| `recordingId` | string | 與同一次記錄的 location-log 相同 |
| `sourceId` | string | `android-gps`／`ios-corelocation` |
| `platform` | string | `android`／`ios` |
| `appVersion` | string | 例如 `0.0.2+2` |
| `deviceBootId` | string\|null | 與 location-log 同一次 boot 判定；null 時帶 `device_boot_id_unavailable` |
| `telemetrySequence` | int | 自 `0` 起算，成功落盤後才遞增 |
| `trigger` | string | `recording_started`／`recording_resumed`／`recording_stopped`／`recording_interrupted`／`location_service`／`state_change`／`heartbeat`；見 §4.1 |
| `reasons` | string[] | 與上一筆相比改變的欄位名；第一筆為 `["initial_snapshot"]` |
| `occurredAtUtc` | string\|null | RFC3339，字面 `Z` 結尾。帶本地位移為非法 |
| `occurredMonotonicUs` | int\|null | 含睡眠的單調時間，微秒 |
| `locationLogLastSequence` | int | 唯讀；第一筆定位樣本之前為 `-1` |
| `batteryPercent` | int\|null | `0`–`100` |
| `batteryCharging` | bool\|null | |
| `batteryPowerSource` | string | `ac`／`usb`／`wireless`／`dock`／`none`／`unknown` |
| `powerSaveMode` | bool\|null | Android 省電模式／iOS 低耗電模式 |
| `screenInteractive` | bool\|null | Android `PowerManager.isInteractive()`；iOS 恆為 null |
| `keyguardLocked` | bool\|null | Android `KeyguardManager.isKeyguardLocked()`；iOS 恆為 null |
| `protectedDataAvailable` | bool\|null | iOS `UIApplication.isProtectedDataAvailable`；Android 恆為 null |
| `screenStateSource` | string | 明寫螢幕欄位的來源 API，見 §5 |
| `appLifecycle` | string | `foreground`／`inactive`／`background`／`unknown` |
| `locationServiceState` | string | `started`／`stopped`／`restarted`／`failed`／`unknown` |
| `locationServiceDetail` | string\|null | 自由文字；null 表示沒有補充說明，**不是**不可得，因此不配旗標 |
| `processRestartCount` | int | 同一 `recordingId` 內的續錄次數 |
| `resumeReason` | string\|null | `process_restart`／`crash`／`boot`；非恢復時為 null |
| `recoveredTruncatedBytes` | int\|null | 修復末行時丟掉的位元組；null 表示沒有修復 |
| `unavailable` | string[] | 見下 |

### 4.1 `recording_interrupted`

一段記錄**沒有自己收尾**時（程序被終止、崩潰、斷電），死掉的那個程序當然寫不出任何東西。後來的程序發現「偏好設定還寫著 recording，但這個程序並沒有在跑記錄器」時，補寫一列 `recording_interrupted`。

讀這一列時必須注意三件事：

1. **`occurredAtUtc`／`occurredMonotonicUs` 是「發現的時間」，不是「中斷的時間」。** 真正的結束時間被夾在前一列 telemetry 與 `locationLogLastSequence` 之間。
2. **`reasons` 固定是 `["previous_segment_not_closed"]`**，不是逐欄位的差異比對。補寫的那一列跟前一列當然每個欄位都不同，但那是「我們沒宣稱」而不是「值變成不可得」，用差異清單會誤導。
3. **所有裝置可觀測欄位刻意留成不可得。** 補寫的程序不知道中斷當下電量、螢幕是什麼狀態，填入當時的值會讓人誤以為那是中斷時的紀錄。唯一的硬事實是 `locationLogLastSequence`——定位紀錄寫到哪一筆為止。
4. **沒有這一列不代表正常結束。** 如果使用者從此沒再打開 App，就沒有任何程序會去補寫。突然結束而沒有標記仍然可能發生，判讀時要同時比對最後一筆的時間與你預期的結束時間。

location-log **不會**有對應的事件：`contracts/location-log/v1` 沒有這個 `eventType`，要加必須走契約流程。中斷的標記只在 telemetry。

### null 與旗標

沿用 location-log 的 `qualityFlags` 原則：**可為 null 的欄位為 null 時必須有對應旗標，有旗標時該欄位必須為 null**，雙向都檢查（`NULL_FLAG_MISMATCH`）。不可得的值一律 null，不用 `0` 或 `false` 冒充。

旗標分兩種後綴，意義不同，不得混用：

- `*_unavailable`：平台沒有給值，欄位為 null。
  `battery_percent_unavailable`、`battery_charging_unavailable`、`power_save_mode_unavailable`、`screen_interactive_unavailable`、`keyguard_state_unavailable`、`protected_data_state_unavailable`、`device_boot_id_unavailable`、`utc_time_unavailable`、`monotonic_time_unavailable`
- `*_unknown`：欄位是不可為 null 的列舉，平台回報的值就是「未知」。
  `battery_power_source_unknown`、`app_lifecycle_unknown`、`location_service_state_unknown`

未知旗標、未知欄位、未知列舉值與較新的 `telemetryVersion` 都是**警告**並原樣保留：把較新寫入端的檔案整批判為失敗會讓診斷資料白白作廢。真正的錯誤只有 `NOT_JSON`、`NOT_AN_OBJECT`、`MISSING_RECORD_TYPE`、`MISSING_TELEMETRY_VERSION`、`FIELD_TYPE_INVALID`、`FIELD_VALUE_OUT_OF_RANGE`、`NULL_FLAG_MISMATCH`、`SEQUENCE_DUPLICATE`、`POSITION_FIELD_PRESENT`。

### 範例

Android，鎖屏那一刻（為閱讀換行，實際為單行）：

```json
{"appLifecycle":"background","appVersion":"0.0.2+2","batteryCharging":false,
 "batteryPercent":83,"batteryPowerSource":"none","deviceBootId":"boot-a",
 "keyguardLocked":true,"locationLogLastSequence":149,"locationServiceDetail":null,
 "locationServiceState":"started","occurredAtUtc":"2026-10-03T04:02:30.000Z",
 "occurredMonotonicUs":10150000000,"platform":"android","powerSaveMode":false,
 "processRestartCount":0,"protectedDataAvailable":null,
 "reasons":["screen_interactive","keyguard_locked","app_lifecycle"],
 "recordType":"diagnostics_telemetry","recordingId":"synthetic-recording",
 "recoveredTruncatedBytes":null,"resumeReason":null,"screenInteractive":false,
 "screenStateSource":"android_power_manager_interactive_and_keyguard_locked",
 "sourceId":"android-gps","telemetrySequence":1,"telemetryVersion":1,
 "trigger":"state_change","unavailable":["protected_data_state_unavailable"]}
```

完整合法與壞資料案例在 `testdata/device/diagnostics-telemetry/v1/`：

- `android-state-changes.ndjson` — Android 一次完整記錄的狀態變化
- `ios-screen-state-unavailable.ndjson` — iOS 螢幕欄位不可得、重開機恢復、電量不可得
- `invalid-and-tolerated.ndjson` — 每一種錯誤碼與每一種被容忍的警告，末行刻意未結尾

## 5. 平台可觀測性的限制

### Android

- `screenInteractive` 來自 `PowerManager.isInteractive()`：螢幕是否處於可互動狀態，**不是**「使用者正在看螢幕」。
- `keyguardLocked` 來自 `KeyguardManager.isKeyguardLocked()`：這是 **keyguard 是否顯示**，不是精確的鎖屏事件，也不等於「使用者看到鎖定畫面」。欄位名刻意叫 `keyguardLocked` 而不是 `locked`。
- `screenStateSource` 固定為 `android_power_manager_interactive_and_keyguard_locked`，把來源 API 寫進資料裡，讀的人不必猜。
- 電量來自 `ACTION_BATTERY_CHANGED` 的 `EXTRA_LEVEL`／`EXTRA_SCALE`／`EXTRA_STATUS`／`EXTRA_PLUGGED`。`BATTERY_PLUGGED_DOCK` 是 API 33 才有的常數，為維持 minSdk 24 以數值 `8` 比對並在程式碼註明。
- 前後台由 `Application.ActivityLifecycleCallbacks` 的 started activity 計數推得。`ActivityLifecycleCallbacks` **不會重播**註冊之前就已經 started 的 activity，所以初始值由啟動服務的 Intent 的 `INITIAL_FOREGROUND` extra 帶入——從畫面按下開始時必然有 activity 且在前景（Android 14+ 的前景服務限制本來就要求如此）。**系統自行重建服務時沒有這個 extra，此時維持 `unknown`**，因為那時確實可能沒有任何 activity。`unknown` 不是「背景」，所以不寫成 `background`。
- 省電模式來自 `PowerManager.isPowerSaveMode()`。
- 沒有 iOS 的 protected-data 概念，`protectedDataAvailable` 恆為 null。

### iOS

- **iOS 沒有公開可靠的鎖屏 API。** 因此 `screenInteractive` 與 `keyguardLocked` 恆為 null 並帶旗標，`appLifecycle` 的 `background` 絕不改寫成 `locked`。
- `protectedDataAvailable`（`UIApplication.isProtectedDataAvailable`）是最接近的公開訊號，以自己的名字記錄：`false` 通常發生在鎖定之後，但 `true` **不證明**裝置已解鎖，而且鎖定後會有數秒的緩衝期。不要把它當鎖屏事件。
- `screenStateSource` 固定為 `ios_no_public_lock_api_protected_data_only`。
- 電量來自 `UIDevice` 的 battery monitoring（`isBatteryMonitoringEnabled = true`）。`batteryLevel` 為負值時寫 null 並帶旗標。`batteryState` 的 `.unknown` 寫 null，不寫 false。
- iOS **不公開充電來源種類**，所以充電時 `batteryPowerSource` 為 `unknown`（帶 `battery_power_source_unknown`），而不是猜成 `usb`。未接電源才是 `none`。
- 低耗電模式來自 `ProcessInfo.isLowPowerModeEnabled`。
- 前後台直接讀 `UIApplication.shared.applicationState`，所以 iOS 不需要 Android 那個初始值 extra，第一列就有真實的 `appLifecycle`。
- 時間使用 `mach_continuous_time()`＋`mach_timebase_info`，與 location-log v1 §3 同一個時間域；`mach_absolute_time()` 與 `ProcessInfo.systemUptime` 在睡眠期間不前進，兩者皆不使用。
- heartbeat 是 run loop timer：**iOS 把程序暫停時不會觸發**。telemetry 的時間缺口因此是預期的，不能當成採集中斷的證據。

### 兩端共同

- 寫入時機是**狀態改變**加上低頻 heartbeat（預設 300 秒），不跟著定位 callback 寫；狀態沒變的 `state_change` 不寫檔，以免額外耗電與寫入。生命週期類 trigger（開始／恢復／停止／定位服務變化）即使狀態沒變也一定寫。
- 序號只在成功落盤（`fsync`／`synchronize`）後遞增。
- 單調時間只在同一個 `deviceBootId` 內可相減，跨 boot、跨裝置相減一律非法。
- telemetry 寫入失敗一律吞掉：診斷不得把它想描述的那次記錄弄掛。

## 6. 怎麼讀這些資料

- **電量**：以 `occurredAtUtc` 搭配 `batteryPercent` 計算一段時間的耗電。`batteryCharging` 為 true 的區段要排除。單次測量不構成續航結論，沒有量測前不給續航保證。
- **前後台**：`appLifecycle` 說的是 App 的狀態，不是螢幕狀態。`background` 期間仍可能有定位樣本（Android 前景服務／iOS 背景定位）。
- **螢幕／鎖屏**：Android 可同時看 `screenInteractive` 與 `keyguardLocked`；`screenInteractive=false` 加 `keyguardLocked=true` 是最接近「鎖屏中」的可觀測組合，但仍是兩個 API 的狀態，不是鎖屏事件。iOS 只能看 `protectedDataAvailable`，且只能當弱訊號。
- **定位服務**：`started`／`restarted` 搭配 `processRestartCount` 與 `resumeReason` 可看出系統是否重建過服務或程序。`failed` 會帶 `locationServiceDetail`。
- **對齊定位紀錄**：用 `locationLogLastSequence` 找出 telemetry 當時定位紀錄寫到哪一筆，再回去看那段樣本的間隔。
- `unknown`／`not available` 在畫面與資料中都保持原樣。看到 `unknown` 就是不知道，不要當成正常或 false。

## 7. 匯出

診斷畫面提供兩個獨立按鈕，兩者都要先停止記錄：

- **匯出 location-log v1** — 定位紀錄，含精確座標。
- **匯出 diagnostics telemetry** — 裝置與 App 狀態，不含位置資料。

分享文字各自標明格式與內容，避免接收者混淆。telemetry 沒有紀錄時該按鈕停用，畫面也會顯示「目前不可匯出」。

## 8. 命令

Dart 模型、解析、匯入與 Kotlin／Swift 欄位對齊的 static validation，在 `packages/device_bridge`：

```sh
flutter pub get && flutter analyze && flutter test
```

Flutter 畫面測試，在 `apps/mobile`：

```sh
flutter pub get && flutter analyze && flutter test
```

Android 原生 telemetry 單元測試，在 `apps/mobile/android`；會把合成 NDJSON 輸出到 `apps/mobile/build/device_bridge/native-telemetry-fixtures/`：

```sh
./gradlew :device_bridge:testDebugUnitTest --console=plain
```

再用 Dart 讀取器檢查剛才那些 Kotlin 輸出，兩端欄位或語義不一致就失敗；在 `packages/device_bridge`：

```sh
dart run bin/inspect_telemetry.dart --strict ../../apps/mobile/build/device_bridge/native-telemetry-fixtures/*.ndjson
```

檢查從真機匯出的 telemetry 檔，在 `packages/device_bridge`：

```sh
dart run bin/inspect_telemetry.dart /absolute/path/to/exported.telemetry.ndjson
```

真機匯出的檔案只在本機檢查，不提交。

## 9. 真機驗證現況

裝置：Xiaomi 21081111RG（小米 11T Pro）、Android 14／SDK 34、MIUI `V816.0.15.0.UKWTWXM`。**只有這一台**，而 MIUI 是公認最激進的省電實作，下列結論不可推廣到其他品牌。

### 已驗證（hardware tests）

- 1 Hz 採樣、鎖屏期間不中斷（28.8 秒 29 筆，最大間隔 1.000 秒）
- 序號零缺口、location-log 契約 0 error 0 warning、telemetry 0 bad lines
- `locationLogLastSequence` 與定位紀錄的對齊 15／15 正確
- 兩種格式分開匯出，分享文字各自正確
- keyguard 時序可量測：該機關螢幕時 keyguard 鎖定延遲 0 ms；亮屏到解鎖之間有 3.886 秒「螢幕亮著且鎖定」的可區分狀態
- 程序在 append 完成後 59 ms 被終止，檔尾仍完整、無損壞行（**單次觀察**）
- **SIGKILL 後 START_STICKY 前景服務在 5 秒內被系統重建**，寫出 `recording_resumed`（`reason: process_restart`、`resumedSequence`）與 telemetry 的 `restarted`／`process_restart`／`processRestartCount: 1`，同一 `recordingId` 與 `deviceBootId`

### 關鍵前提：MIUI 權限

上面那一條**只在以下三項都開啟時成立**：

| 項目 | 未開啟時的觀察 |
|---|---|
| MIUI 自啟動（`MIUIOP(10008)`） | 服務在 SIGKILL 與 `am crash` 後 **154 秒內完全沒有被重建**，ServiceRecord 直接消失 |
| 電池最佳化白名單 | `dumpsys` 的 `tempAllowListReason` 會缺少 `SYSTEM_ALLOW_LISTED`，這是前景服務得以從背景啟動的豁免來源 |
| `POST_NOTIFICATIONS` | 常駐通知被靜默擋掉（appop `ignore`），服務仍在跑但使用者看不到 |

三項是一起改的，**無法分辨哪一項是決定性的**。要分辨必須逐項開關重測。產品層面的結論是：這些權限必須由 App 引導使用者開啟，否則小米機上程序一死就不會恢復。

### 尚未驗證（`untested`／待 `hardware tests`）

- **跨程序重啟的序號接續**：重建成功那次在被殺之前還沒有任何樣本（室內無 fix），所以 `resumedSequence` 是 0，沒有真正驗到序號從非零接續
- 30 分鐘／2 小時長時間採集；telemetry 檔案大小與缺口分布
- telemetry 自身的耗電（預期遠低於定位紀錄，但未量測）
- 各廠牌鎖屏／AOD／抬手喚醒下 `isInteractive`／`isKeyguardLocked` 的值
- 真正的低記憶體回收（目前只用 SIGKILL 與 `am crash` 模擬）
- 第二台非小米 Android 真機
- **iOS 全部**：只有 CI 的 `flutter build ios --no-codesign` 通過（編譯層級）與 static validation，沒有任何執行期或真機證據
- iOS 鎖屏期間 `protectedDataAvailable` 的實際變化時機與緩衝期
- iOS 程序被暫停時 heartbeat 的實際停止與恢復行為

沒有上述證據前，不得用 telemetry 宣稱背景採集穩定或給出耗電數字。

### 觀測工具的限制

MIUI 幾乎關閉了 AMS 的程序／服務生命週期日誌（一次 160 秒的擷取裡 26799 行只有 8 行 `ActivityManager`，全部無關）。因此在這台機器上**看不到** `Scheduling restart of crashed service` 或 `ForegroundServiceStartNotAllowedException`，「logcat 沒有重啟訊息」不能當成「系統決定不重啟」的證據。可靠的觀測方式是輪詢 `dumpsys activity services <pkg>` 的 `isForeground` 與 `pidof`。
