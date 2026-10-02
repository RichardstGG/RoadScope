# 原生位置紀錄契約 v1（location-log）

`schemaVersion: 1`。本文件是規範本文，`record.schema.json` 是可機器檢查的部分。兩者衝突時以本文件為準；schema 無法表達的規則一律寫在這裡，不得只靠型別推測。

決策背景見 [`docs/decisions/0001-location-log-format.md`](../../../docs/decisions/0001-location-log-format.md)。

## 1. 範圍

這份契約描述**裝置本機**的原生追加紀錄：Android 前景服務與 iOS Core Location 寫出的 NDJSON 檔案，以及 `packages/mobile_data` 匯入它的規則。它不是網路協定，不經過伺服器，與車隊 HTTP／WSS 契約無關。

寫入端（`packages/device_bridge`）是**單一寫入者**。消費端為 `packages/mobile_data` 的匯入器與 `packages/timing_core` 的重播。

## 2. 檔案格式

- UTF-8，每行一個 JSON 物件，以 `\n` 結尾（NDJSON）。
- 只追加，不改寫既有行。
- 空白行必須被消費端略過，不計為錯誤。
- 檔案可能在任意位置被截斷（崩潰、斷電）。最後一行不完整時，消費端必須能處理，而不是整檔放棄。

## 3. 時間基準

四個時間概念不得互換，混用是本契約最常見的誤用來源。

| 概念 | 欄位 | 規則 |
|---|---|---|
| 測量 UTC | `measuredAtUtc` | 定位系統報告的測量時刻。可能受系統時鐘調整影響。 |
| 接收 UTC | `receivedAtUtc` | 原生 callback 收到樣本的時刻。**不得**當成測量時間。 |
| 測量單調時間 | `measurementMonotonicUs` | 平台提供的原生單調測量時間，微秒。無此能力時為 `null`。 |
| 接收單調時間 | `receivedMonotonicUs` | callback 時刻的單調時間，微秒。 |

規則：

1. **對外 UTC 一律 RFC3339 且以字面 `Z` 結尾。** 帶本地位移的形式（例如 `+08:00`）為非法，避免每個消費端各自正規化。
2. **單調時間必須包含裝置睡眠。** Android 用 `SystemClock.elapsedRealtimeNanos()`；iOS 用 `mach_continuous_time()` 搭配 `mach_timebase_info` 換算。iOS 的 `ProcessInfo.systemUptime` 與 `mach_absolute_time()` 在睡眠期間不前進，**不符合本契約**——鎖屏長時間採集正是睡眠最多的情境，使用它會讓兩平台的時間差系統性不可比。
3. **單調時間只在同一 `deviceBootId` 內可相減。** 跨 `deviceBootId`、跨裝置相減一律非法。
4. `measurementMonotonicUs` 為 `null` 時，消費端**不得**改用 `receivedMonotonicUs` 代替做測量間隔運算。該來源只能以 UTC 推算間隔，並承擔時鐘調整的風險。
5. 顯示精度與測量準確度是兩件事。`*Us` 欄位的儲存解析度不是準確度承諾。

## 4. 記錄型別

每一行都必須有 `recordType`，值為 `sample` 或 `event`。

- **缺少 `recordType` 是非法資料**（錯誤碼 `MISSING_RECORD_TYPE`）。P0 的 pre-contract 輸出沒有這個欄位，不在本契約支援範圍內；該格式的資料必須重新採集。這條刻意不給寬鬆路徑：若「缺 `recordType` 就當 sample」，真正損壞的行也會被放行。
- **`recordType` 的值未知**（例如未來的 `telemetry`）代表較新的寫入端。消費端必須原樣保留該行、計數、繼續處理後續行，**不得**視為損壞。

`eventType` 同理：未知的 `eventType` 仍須滿足事件共同欄位，消費端保留並計數。

## 5. sample 欄位

必填欄位與數值範圍見 `record.schema.json`。未列於 schema 的額外欄位為非法（`additionalProperties: false`）——這是我們自己控制的單一寫入者格式，嚴格比寬鬆更能抓到拼錯的欄位名。新增欄位走 §10 的版本流程。

語義補充：

- `sourceType` 表**定位來源種類**，不表實作，也不表是否為模擬資料。允許值 `phone_location` 與 `external_gnss`。實作差異由 `sourceId` 表示（`android-gps`、`ios-corelocation`）。
- **`obd` 不是本契約的來源種類。** `latDeg`／`lonDeg` 在此為必填，而 OBD 不產生 WGS84 座標；車輛資料屬於 `02-contract-draft.md` 的 `VehicleSample` 與日後的車輛遙測契約。`01-master-plan.md` §11 的 `ObdSource` 是**來源介面**的邊界，不是位置樣本的來源種類。
- `phone_gnss` 是 `phone_location` 的**過渡期別名**。驗證器接受並發出 `SOURCE_TYPE_DEPRECATED` 警告，匯入時映射為 `phone_location`。P1 結束時移除。
- 合成資料的 `sourceType` 必須是**被模擬的來源種類**（通常 `phone_location`），模擬性質只由 `qualityFlags` 的 `synthetic` 表示。把 `sourceType` 設為 `synthetic` 會使合成資料無法重播成與真實來源相同的程式路徑，是明確禁止的。
- 無效或不可得的量測值保存 `null`，不得用 `0` 冒充。
- `headingDeg` 為相對真北順時針角度，範圍 `[0, 360)`。
- 原始資料與過濾結果分開保存。本契約描述的是原始採集，過濾後的結果不回寫本檔案。

## 6. qualityFlags

字串陣列，不重複。已知值：

| 旗標 | 意義 |
|---|---|
| `speed_unavailable` | `speedMps` 不可得 |
| `heading_unavailable` | `headingDeg` 不可得 |
| `horizontal_accuracy_unavailable` | `horizontalAccuracyM` 不可得 |
| `speed_accuracy_unavailable` | `speedAccuracyMps` 不可得 |
| `altitude_unavailable` | `altitudeM` 不可得 |
| `measurement_monotonic_unavailable` | 該來源無原生單調測量時鐘 |
| `synthetic` | 合成資料，非真實硬體來源 |

規則：

1. **null ⟺ 旗標**：可為 null 的量測欄位為 `null` 時，對應的 `*_unavailable` 旗標必須存在；旗標存在時該欄位必須為 `null`。雙向都由 schema 與驗證器強制（錯誤碼 `NULL_FLAG_MISMATCH`）。
2. **命名區分「不可得」與「被拒絕」**。`*_unavailable` 表示來源沒有給值（例如 Android `hasSpeed() == false`）。將來若加入過濾，被過濾掉的值使用保留的 `*_rejected` 後綴。兩者對計時的意義不同，不得共用一個名字。
3. **未知旗標必須原樣保留**，不得丟棄，也不得當成有效。消費端計數並回報（`UNKNOWN_QUALITY_FLAG` 警告）。這是本契約的擴充點：新增品質資訊優先走旗標，而非新增欄位。

## 7. 序號與跨 boot

1. `sequence` 的唯一性範圍是 `(recordingId, sourceId)`，從 `0` 起算。
2. **`sequence` 跨 boot 連續。** 崩潰或重開機後續錄同一 `recordingId` 時，序號接續，不重設。
3. **`deviceBootId` 可在同一 recording 中途改變。** 該處即為單調時間的不連續點：
   - 消費端**必須**在 `deviceBootId` 改變處切斷單調時間的推算，退回 UTC，並對跨越該點的間隔標記品質降級；
   - `timing_core` 若在此處直接相減單調時間，會算出錯誤的穿線間隔。這是本契約最容易出錯的一條。
4. **boot 改變必須被宣告**：改變前後之間必須有 `clock_adjusted` 或 `recording_resumed` 事件。未宣告的改變是警告（`BOOT_ID_CHANGE_UNDECLARED`），因為資料層無法分辨它與時鐘漂移。
5. **序號缺口必須有來源。** 尾行損壞被截斷時，寫入端必須寫 `log_truncated` 事件記錄缺口，否則消費端無法分辨「資料遺失」與「定位本來就沒有產生樣本」。無事件佐證的缺口是警告（`SEQUENCE_GAP`）。
6. **同一檔案內重複序號是缺陷。** 完全相同的重複（`SEQUENCE_DUPLICATE`）與內容不同的衝突（`SEQUENCE_CONFLICT`）都是錯誤，代表單一寫入者的保證被破壞。匯入器保留先到者，但必須計數並回報為 fail，不是 warn。
7. **重讀整份檔案必須冪等。** 以 `(recordingId, sourceId, sequence)` 為鍵，重複匯入同一檔案不得產生重複樣本。這與第 6 條不衝突：第 6 條說的是單一檔案內部。

### boot 識別的已知弱點

Android 與 iOS 目前都以「`UTC 減 uptime` 的 anchor 差超過 60 秒」判定新 boot。這個啟發式有兩種誤判：時鐘跳動超過 60 秒會被誤判為新 boot；真重開機而漂移小於 60 秒會被誤判為同一 boot。

本契約不要求調整門檻值，而要求**把判斷依據保存下來**：`recording_started` 必須帶 `bootAnchorUtcMs` 原始值，`clock_adjusted` 必須帶變更前後的 anchor 與當時門檻。啟發式失準時，資料層仍可事後判斷與修正。

## 8. 事件

事件與樣本寫在同一檔案、同一序列化寫入路徑，檔案順序即發生順序。

共同欄位：`recordingId`、`sourceId`、`deviceBootId`、`occurredAtUtc`、`occurredMonotonicUs`、`lastSequence`。

- `occurredMonotonicUs` 為必填。`clock_adjusted` 事件裡 UTC 正是受質疑的那個值，只有 UTC 會讓校時事件本身無法定位。
- **`lastSequence` 標示事件發生時「已寫出的最後一個有效樣本序號」，第一筆樣本之前為 `-1`。** 事件**不佔用樣本序號**，序號空間保持連續。`lastSequence` 不得超過檔案中實際已出現的最大序號（`EVENT_SEQUENCE_AHEAD`）。

| `eventType` | 時機 | 專屬欄位 |
|---|---|---|
| `recording_started` | 每次開始或續錄，**排在該段任何樣本之前** | `platform`、`appVersion`、`sourceType`、`sourceCapabilities`、`bootAnchorUtcMs` |
| `clock_adjusted` | 偵測到系統時鐘調整或 boot anchor 位移 | `previousDeviceBootId`、`previousBootAnchorUtcMs`、`bootAnchorUtcMs`、`thresholdMs` |
| `log_truncated` | 修復損壞尾行後 | `truncatedBytes`、`resumedSequence` |
| `recording_resumed` | 崩潰、行程重啟或重開機後續錄 | `reason`（`crash`／`process_restart`／`boot`）、`resumedSequence` |

`sourceCapabilities.measurementMonotonic` 為 `false` 時，該來源的每一筆樣本 `measurementMonotonicUs` 皆為 `null`。`monotonicIncludesSleep` 在符合本契約的寫入端恆為 `true`；保留此欄位是為了讓不符規範的歷史紀錄能自我描述。

## 9. 寫入端規則

1. 單一寫入者。事件與樣本共用同一序列化寫入路徑，不得由不同執行緒各自追加。
2. `recording_started` 必須排在該段定位 callback 之前，確保消費端先看到來源能力再看到樣本。
3. 崩潰可能留下不完整的末行。續錄前截斷至最後一個完整換行，並寫 `log_truncated`。
4. 序號只在成功寫入後遞增。
5. 紀錄檔不得寫入 token、帳號資料或其他與定位無關的敏感內容。

## 10. 版本與相容性

- `schemaVersion` 為整數 `1`。
- **新增可選欄位仍須走契約 PR**，因為 `additionalProperties: false`。優先考慮以 `qualityFlags` 的新旗標或新 `eventType` 擴充，兩者都已有向前相容規則，不需動版本。
- 破壞性變更使用新的 `schemaVersion`，並在本文件寫明兩版本的判別方式與遷移。
- 測試者手機上可能留有舊版 App。服務端與資料層必須容忍已承諾支援的版本。
- 每次契約變更必須附合法與非法案例、重啟案例、相容性說明（見 `docs/engineering-rules.md` §5）。

## 11. 驗證與案例

```bash
npm install --prefix contracts/tools
npm test --prefix contracts/tools
node contracts/tools/validate-location-log.mjs <你的紀錄檔.ndjson>
```

fixtures 位於 `testdata/contracts/location-log/v1/`：

- `valid/` — 必須零 error（warning 允許且預期）
- `invalid/` — 每個 `.ndjson` 有同名 `.expected`，列出必須出現的 error 代碼

依 §12 的決定，**Dart 端沿用 `packages/mobile_data` 的手寫模型，但必須通過同一批 fixtures**。fixtures 是雙端一致性的防線，不是裝飾。

### 錯誤碼

error（資料不可信，驗證失敗）：`NOT_JSON`、`MISSING_RECORD_TYPE`、`SCHEMA_INVALID`、`NULL_FLAG_MISMATCH`、`SEQUENCE_CONFLICT`、`SEQUENCE_DUPLICATE`、`MONOTONIC_REGRESSION`、`MEASUREMENT_MONOTONIC_REGRESSION`、`EVENT_SEQUENCE_AHEAD`

warning（契約明文容忍，不失敗）：`SEQUENCE_GAP`、`BOOT_ID_CHANGE_UNDECLARED`、`SOURCE_TYPE_DEPRECATED`、`UNKNOWN_QUALITY_FLAG`、`UNKNOWN_RECORD_TYPE`、`UNKNOWN_EVENT_TYPE`、`MISSING_RECORDING_STARTED`

warning 刻意不致命：把未知記錄型別或未知旗標判為失敗，會讓較新寫入端的資料整批作廢，破壞向前相容。

## 12. 型別策略

JSON Schema 是唯一真實來源。**暫不導入 schema → Dart／TypeScript 的生成器**，兩端以 fixtures 對齊。理由與重新評估時機見 `docs/decisions/0001-location-log-format.md` D8。

這是 `docs/engineering-rules.md` §5 第 2 條的明文例外，**僅限本機 `location-log` v1**，不延伸至車隊 HTTP／WebSocket 契約。

## 13. 已知限制

- iOS 單調時間語義的結論來自 static validation（讀 Swift 原始碼推論），**尚未經真機驗證**。排實機時應比對首末樣本的 `receivedAtUtc` 差與 `receivedMonotonicUs` 差，iOS 明顯短少即確認。
- 本契約不保證斷電零遺失。正常執行時的設計目標是最多一秒的寫入緩衝，實際值依耗電量測調整。
- 時間戳與品質旗標改善的是資料可判讀性，不構成防作弊，也不構成跨裝置精準校時。
