# 動態感測與傾角紀錄契約 v1（motion／lean）

`schemaVersion: 1`。本文件是規範本文；`common.schema.json`、`motion.schema.json`、`lean.schema.json` 是可機器檢查的部分。兩者衝突時以本文件為準。schema 只驗證單行形狀；跨行規則（序號、時間、校準分段、最大值）與「null ⟺ 旗標」配對由 `contracts/tools/validate-motion-lean.mjs` 強制，錯誤碼見 §13。

決策背景見 [`docs/decisions/0002-motion-lean-format.md`](../../../docs/decisions/0002-motion-lean-format.md)。

## 0. 範圍與檔案佈局

這份契約描述**裝置本機**的兩個追加式 NDJSON 檔案，與 `location-log` v1 **完全分離**，不經過伺服器，與車隊 HTTP／WSS 契約無關。

| 檔案 | 內容 | 性質 |
|---|---|---|
| `motion/<recordingId>.motion.ndjson` | 原始加速度、角速度、平台姿態＋時鐘映射與缺樣事件 | **原始資料**，落盤後不改寫 |
| `motion/<recordingId>.lean.ndjson` | 校準、傾角估算、分段最大值＋事件 | **衍生資料**，可由原始資料與更新的演算法重新產生為**新檔** |
| `recordings/<recordingId>.ndjson` | 既有 location-log v1 | 不變 |

路徑為建議值，歸 Codex 在 `device_bridge` 決定；契約只要求兩個檔案共用同一個 `recordingId`。

規則：

1. **不把非定位資料寫進 location-log。** motion／lean 的每一行都使用自己的 `recordType`（`motion_sample`、`motion_event`、`lean_calibration`、`lean_estimate`、`lean_extremum`、`lean_segment_closed`、`lean_event`），沒有任何一行使用 `sample` 或 `event`。
2. **原始與衍生分離。** `motion` 檔只放平台給的量測；任何濾波、校準、傾角都只出現在 `lean` 檔。重新計算（新演算法、修正過的參考）寫成**新的 lean 檔**，帶新的 `algorithmVersion`，不得改寫既有檔案的任何一行。
3. 檔案格式同 location-log §2：UTF-8、每行一個 JSON 物件、`\n` 結尾、只追加、空白行略過、可能在任意位置截斷。
4. 單一寫入者（§11）。

## 1. 識別與序號

| 欄位 | 範圍 | 規則 |
|---|---|---|
| `recordingId` | 一次記錄 | 與同一次記錄的 location-log 相同。motion／lean 兩檔共用。 |
| `deviceBootId` | 一次開機的單調時間域 | 與 location-log **同一個判定結果**（同一份啟發式與 anchor，見 location-log §7），不另外判定。 |
| `sourceId` | 一個感測器或一條衍生串流 | motion：每個感測器一個，例如 `android-accelerometer`、`android-gyroscope`、`android-game-rotation-vector`。lean：`lean-estimator`（lean 檔所有非事件記錄共用一個序號空間）。 |
| `sequence` | `(recordingId, sourceId)`，從 `0` 起算 | **跨 boot 連續**。只在成功寫入後遞增。**事件不佔序號。** |

與 location-log 的差異：**缺樣不佔序號。** 有界緩衝丟棄的樣本從未被寫入、也從未被指派序號，序號因此保持連續；缺口由 `samples_dropped` 事件以測量時間範圍表達（§9）。序號缺口只可能來自尾行截斷，且必須有 `log_truncated`／`recording_resumed` 事件佐證，否則是警告 `SEQUENCE_GAP`。

事件的 `lastSequences`（motion，各 `sourceId` → 事件發生時已寫出的最後序號，之前為 `-1`）與 `lastSequence`（lean，單一序號空間）不得超過檔案中實際已出現的最大序號（`EVENT_SEQUENCE_AHEAD`）。

## 2. 座標軸與單位（motion）

所有 motion 數值使用 **SI 單位**與**裝置固定座標**。不使用顯示旋轉座標，也不做任何 remap：螢幕轉向、橫放／直放／斜裝都不影響原始資料，安裝方位由 lean 檔的校準（§7）吸收。

### 裝置座標 `axisFrame`

| `axisFrame` | 定義 |
|---|---|
| `android_sensor` | Android 感測器座標系，相對**裝置自然方向**（不隨螢幕轉向改變）：+X 朝螢幕右、+Y 朝螢幕上緣、+Z 垂直螢幕朝外。右手系。 |
| `core_motion_device` | Core Motion 裝置座標系，軸向與上列相同。 |

兩者軸向相同；分開列舉是為了讓紀錄自我描述資料來源平台，而不是兩套慣例。

### 各 `sensorType`

| `sensorType` | 欄位 | 單位 | 語義 |
|---|---|---|---|
| `accelerometer` | `xMps2`、`yMps2`、`zMps2` | m/s² | **比力（specific force）、含重力**，Android `TYPE_ACCELEROMETER` 慣例：靜止時向量指向**上方**，量值約 9.81，手機平放螢幕朝上時 `z ≈ +9.8`。iOS 寫入端必須自行換算（Core Motion 的 `acceleration` 單位為 g 且符號相反：乘以 9.80665 並取負）。 |
| `gyroscope` | `xRadPerS`、`yRadPerS`、`zRadPerS` | rad/s | 繞各軸角速度，右手定則，平台已作偏差補償的校正值（Android `TYPE_GYROSCOPE`）。未校正型別不在 v1 範圍（見 §12 未知 `sensorType`）。 |
| `attitude` | `qw`、`qx`、`qy`、`qz` | 無（單位四元數） | **平台融合結果**，不是原始量測；來源宣告的 `platformFused` 恆為 `true`。表示**從裝置座標到世界座標的旋轉**：`v_world = q ⊗ v_device ⊗ q*`。世界座標 +Z 向上、與重力反向。長度必須為 1（容差 `1e-3`，否則 `QUATERNION_NOT_UNIT`）。 |

`attitudeReference`（宣告在 `motion_started`）：

| 值 | 來源 | 世界座標水平軸 |
|---|---|---|
| `game_rotation_vector` | Android `TYPE_GAME_ROTATION_VECTOR`（不用磁力計） | 方位任意，Z 向上，**不指北** |
| `rotation_vector` | Android `TYPE_ROTATION_VECTOR` | 東－北－上（ENU） |
| `core_motion_arbitrary_z_vertical` | `CMAttitudeReferenceFrame.xArbitraryZVertical` | 方位任意，Z 向上 |

姿態的欄位名稱（`qw` 在前）與 Android `SensorEvent.values` 的順序（x、y、z、w）不同，寫入端必須顯式對應，不得依賴陣列位置。

> 傾角演算法需要的是「世界向上向量在裝置座標中的表示」。由姿態取得：`up_device = q* ⊗ (0,0,1) ⊗ q`。**動態中的加速度計不能直接當作向上向量**：加減速與向心加速度會污染它。這是演算法層的責任，契約只保證輸入的座標與單位無歧義。

## 3. 時間（最容易出錯的部分）

延續 location-log §3 的原則：不同的時間概念不得互換。

| 概念 | 欄位 | 規則 |
|---|---|---|
| 測量單調時間 | `measurementMonotonicUs` | Android：`SensorEvent.timestamp`（ns）÷ 1000，**捨去小數**取整數微秒；該值與 `SystemClock.elapsedRealtimeNanos()` 同一時間域（含睡眠），也與 location-log 的 `measurementMonotonicUs`（`Location.getElapsedRealtimeNanos()`）同一時間域。 |
| 接收單調時間 | `receivedMonotonicUs` | callback 時刻的 `elapsedRealtimeNanos()` ÷ 1000。**不得**當測量時間。 |
| 接收 UTC | `receivedAtUtc` | callback 時刻的系統時鐘，RFC3339、字面 `Z`。 |
| 測量 UTC | **不存在於樣本** | UTC 是**映射值**，見下。 |

### 3.1 單調時間

- 單調時間只在同一 `deviceBootId` 內可相減；跨 boot、跨裝置相減一律非法（同 location-log §7）。
- `measurementMonotonicUs` 不可超過同一筆的 `receivedMonotonicUs`（`MEASUREMENT_AFTER_RECEIVED`）。違反幾乎必然是單位誤用（把 ns 或 ms 當 us 寫入）或時間域不符。
- 測量落後接收超過 10 秒是警告 `MEASUREMENT_RECEIVED_SKEW`：批次延遲不會這麼長，通常代表感測器時間戳其實不在 `elapsedRealtime` 域（部分裝置曾回報 `uptimeMillis` 域）。
- `measurementMonotonicUs` 為 `null`（旗標 `measurement_monotonic_unavailable`）時，消費端**不得**以 `receivedMonotonicUs` 代替做測量間隔運算（同 location-log §3.4）。

### 3.2 來源時鐘狀態 `measurementClock`（有生命週期）

每個來源在任何時刻都處於三個狀態之一：

| 狀態 | 意義 | 樣本的 `measurementMonotonicUs` |
|---|---|---|
| `elapsed_realtime` | 已驗證：感測器時間戳與 `SystemClock.elapsedRealtimeNanos()` 同域。 | **必須非 null** |
| `unverified` | 尚未（或不再）被證明。**iOS 在 v1 一律如此。** | **必須為 `null`**＋`measurement_monotonic_unavailable` |
| `unavailable` | 沒有可用的測量時鐘。 | **必須為 `null`**＋`measurement_monotonic_unavailable` |

違反上表是 `MEASUREMENT_CLOCK_MISMATCH`。**`unverified` 時寫 null，不得寫一個「可能正確」的時間**：未驗證的時間域一旦被當成精準對齊依據，錯誤會悄悄混進計時。

**狀態是位置性的、不可追溯的。** 某筆樣本適用的狀態，是檔案中它之前最近一次宣告或變更事件所設定的：

1. 初始狀態由 `motion_started.sources[].measurementClock` 宣告（啟動時可能是 `unverified`）。
2. 之後的變更**只能**用 `source_clock_state` 事件：`sourceId`、`previousMeasurementClock`、`measurementClock`、`reason`（`verification_passed`｜`verification_failed`｜`clock_domain_changed`）。`previousMeasurementClock` 必須等於當時的現行狀態，且與新狀態不同（`SOURCE_CLOCK_STATE_CHAIN`），因此變更可排序、可重播。
3. 驗證通過**不會**讓先前的 null 樣本變成有時間；運行中失敗**不會**讓先前已寫出的時間失效。已落盤樣本永不改寫。
4. **同一段（`motion_started` 到下一次 `recording_resumed`／`clock_adjusted`）內，重複的 `motion_started` 不得改變任何來源的時鐘狀態**（`SOURCE_CLOCK_REDECLARED`）：它不是狀態變更的通道。續錄後的新 `motion_started` 重新宣告初始狀態。
5. 每次進出 `elapsed_realtime` 都是該來源輸入的**中斷點**：估算不得橫跨（§9.1），濾波必須重設（§9.4）。

**精準單調對齊需要同時滿足**：兩邊來源在該時段都處於 `elapsed_realtime`（motion 側由本節狀態、location-log 側由 `sourceCapabilities.measurementMonotonic = true`），且 `deviceBootId` 相同。`unverified` 時段只能以 `receivedMonotonicUs`／UTC 做粗略顯示，不得進入精準對齊或傾角估算。

驗證方法（啟動時如何判斷時間戳屬 elapsedRealtime 域、門檻多少）歸 Codex 實作；契約只定義狀態的意義與轉換規則。

### 3.3 UTC 映射 `clock_map`

UTC 只能由單調時間加上映射偏移得到，映射以 `clock_map` 事件宣告，樣本以 `clockMapId` 引用：

```
測量 UTC（微秒，Unix epoch） = measurementMonotonicUs + offsetUtcMinusMonotonicUs
```

| 欄位 | 規則 |
|---|---|
| `mapId` | 整數，檔案內唯一（`CLOCK_MAP_ID_REUSED`），從 0 起。 |
| `deviceBootId` | 映射只對該 boot 有效；樣本的 `deviceBootId` 與其 `clockMapId` 指向的映射不同是 `CLOCK_MAP_BOOT_MISMATCH`。 |
| `effectiveFromMonotonicUs` | 映射生效的單調時間（樣本的測量時間不可早於它——由寫入端保證，驗證器未檢查）。 |
| `offsetUtcMinusMonotonicUs` | UTC 微秒減單調微秒。以整數保存（Unix 微秒約 1.8e15，在 IEEE‑754 雙精度的精確整數範圍內）。 |
| `mappingSource` | `wall_clock_pair`：同一瞬間讀 `System.currentTimeMillis()` 與 `elapsedRealtimeNanos()`；`gps_fix_pair`：以 GPS 定位的 UTC 與其 `elapsedRealtimeNanos` 配對；`carried_forward`：沿用前一個映射。 |
| `uncertaintyUs` | **寫入端宣稱**的映射誤差半寬（±）。是未經驗證的宣稱，**不是**測得的精度（工程規則 §2.8）。`wall_clock_pair` 受毫秒解析度與兩次讀取間隔限制，合理下限約 1000 µs。 |

規則：

1. 一個新映射在下列時機產生：錄製開始、`clock_adjusted`、`recording_resumed`、寫入端判定漂移超出自己宣稱的 `uncertaintyUs`。
2. **映射更新不得追溯。** 已寫入的樣本保留舊 `clockMapId`；新映射只對其後的樣本生效。UTC 在映射切換處不連續，消費端**不得**跨映射補點或內插 UTC。
3. 單調時間永遠是權威。UTC 只用於呈現與跨裝置顯示；**計時與 GPS 對齊不得依賴 UTC 映射**。
4. 沒有映射時 `clockMapId` 為 `null`＋旗標 `clock_map_unavailable`；單調對時仍然成立。

### 3.4 與 GPS 對齊

對齊主鍵是 `(deviceBootId, measurementMonotonicUs)`，與 location-log 的 `measurementMonotonicUs` 直接比較，不經過 UTC。規則：

1. 兩邊的 `measurementMonotonicUs` 都必須非 null（即兩邊來源在該時段都已驗證，§3.2），且 `deviceBootId` 相同。
2. 消費端以時間最近鄰或在兩個相鄰 GPS 之間分段處理；**不得**在跨 `samples_dropped` 缺口、跨 boot 或跨 `clock_adjusted` 處內插。
3. GPS 固定間隔通常為 1 Hz，感測器為數十 Hz：對齊是「GPS 樣本對應其測量時間前後的傾角估算」，不是反過來。
4. UTC 對齊只在兩邊都有映射／GPS UTC、且 boot 相同時作為輔助，並承擔 `uncertaintyUs`。

## 4. motion 檔：樣本 `motion_sample`

共同欄位（欄位型別與範圍見 `motion.schema.json`）：

`schemaVersion`、`recordType`、`recordingId`、`sourceId`、`sensorType`、`deviceBootId`、`sequence`、`measurementMonotonicUs`（nullable）、`receivedMonotonicUs`、`receivedAtUtc`、`clockMapId`（nullable）、`accuracyLevel`（nullable：`unreliable`／`low`／`medium`／`high`，對應 Android `SENSOR_STATUS_*`）、`qualityFlags`，加上 §2 的感測器數值欄位。

- 感測數值欄位不可為 `null`：沒有值就不寫樣本（以缺樣處理，§9）。
- 已知（可為 null 的）欄位與旗標必須雙向一致（`NULL_FLAG_MISMATCH`）：

| 欄位為 null | 旗標 |
|---|---|
| `measurementMonotonicUs` | `measurement_monotonic_unavailable` |
| `accuracyLevel` | `accuracy_unavailable` |
| `clockMapId` | `clock_map_unavailable` |

- 另有已知旗標 `synthetic`（合成資料）。**未知旗標必須原樣保留**（`UNKNOWN_QUALITY_FLAG` 警告），同 location-log §6。
- 額外未知欄位對**已知** `sensorType` 為非法（`additionalProperties: false`）；對**未知** `sensorType`（§12）則允許。

## 5. motion 檔：事件 `motion_event`

共同欄位：`recordingId`、`deviceBootId`、`occurredAtUtc`、`occurredMonotonicUs`、`lastSequences`。事件與樣本同一寫入路徑，檔案順序即發生順序。

| `eventType` | 時機 | 專屬欄位 |
|---|---|---|
| `motion_started` | 每次開始或續錄，**排在該段任何樣本之前** | `platform`、`appVersion`、`bootAnchorUtcMs`、`sources[]` |
| `clock_map` | §3.3 | `mapId`、`effectiveFromMonotonicUs`、`offsetUtcMinusMonotonicUs`、`mappingSource`、`uncertaintyUs` |
| `source_clock_state` | 來源時鐘狀態變更（§3.2） | `sourceId`、`previousMeasurementClock`、`measurementClock`、`reason` |
| `samples_dropped` | 有界緩衝、寫入失敗或感測中斷造成缺樣，**在缺口之後第一筆樣本之前寫出** | `sourceId`、`droppedCount`（可為 null）、`firstDroppedMonotonicUs`／`lastDroppedMonotonicUs`（可為 null）、`reason`（`buffer_full`｜`writer_error`｜`sensor_unavailable`｜`sensor_interrupted`｜`recording_paused`） |
| `clock_adjusted` | 同 location-log：偵測到時鐘調整或 boot anchor 位移 | `previousDeviceBootId`、`previousBootAnchorUtcMs`、`bootAnchorUtcMs`、`thresholdMs` |
| `log_truncated` | 修復損壞尾行後 | `truncatedBytes`、`resumedSequences`（各 `sourceId` → 下一個序號） |
| `recording_resumed` | 崩潰、行程重啟或重開機後續錄 | `reason`（`crash`／`process_restart`／`boot`）、`resumedSequences` |

`sources[]` 的每個宣告：`sourceId`、`sensorType`、`available`、`measurementClock`（§3.2）；可用時另需 `axisFrame`、`platformFused`、`requestedSamplingPeriodUs`、`maxReportLatencyUs`、`storageStride`、`gapThresholdUs`，`attitude` 另需 `attitudeReference`；不可用時需 `unavailableReason`（例如 iOS 的 `not_implemented`）。

- **採樣、儲存頻率分開**（工程規則 §2.5）：`requestedSamplingPeriodUs` 是向平台請求的週期；`storageStride` 為每 N 筆感測事件寫入一筆（1 表示全存）。被 stride 略過的樣本**不是缺樣**，不產生 `samples_dropped`。
- `gapThresholdUs`：該來源相鄰兩筆測量時間差超過此值即視為缺口。超過且沒有 `samples_dropped`／resume／truncate 事件涵蓋時，驗證器報警告 `MOTION_TIME_GAP`。建議值為請求週期（含 stride）的 3–5 倍，由寫入端宣告。
- 未列出的 `eventType` 見 §12。

## 6. 傾角的定義（lean）

**傾角 `leanAngleDeg`**：機車相對**鉛直方向**的左右傾斜角，單位為度，範圍 `[-90, 90]`。**負值＝向左傾，正值＝向右傾**（面向車頭、騎士視角）。

幾何定義（演算法的輸出必須符合這個式子，演算法的內部做法不在契約內）：

設校準提供兩個裝置座標單位向量：

- `u0 = upDevice`：機車**直立**時，世界向上在裝置座標中的方向（即車身「向上」軸）。
- `a = leanAxisDevice`：側傾旋轉軸（機車縱軸，朝前或朝後均可，由下述左傾確認固定符號），且 `a ⊥ u0`（容差 `|a·u0| ≤ 0.02`，否則 `AXIS_NOT_ORTHOGONAL`）。兩者長度皆為 1（容差 `1e-3`，否則 `VECTOR_NOT_UNIT`）。

設 `u` 為某一時刻世界向上在裝置座標中的方向（§2 由姿態取得）。把 `u` 投影到垂直於 `a` 的平面並重新正規化得 `u'`，則：

```
leanAngleDeg = atan2( (u0 × u') · a , u0 · u' ) × 180/π
```

**符號由「左傾確認」固定**：校準時使用者把車向**左**傾，演算法選擇 `a` 的方向，使該動作產生**負**的 `leanAngleDeg`。因此 `a` 的指向是校準的一部分，不能由安裝方位推斷；沒有左傾確認、也沒有繼承自前一個校準的軸，傾角必須為 `null`（`lean_axis_unknown`）。

這個定義刻意不涉及手機橫放、直放或斜裝：這些全部被 `u0` 與 `a` 吸收。

## 7. lean 檔：校準 `lean_calibration`

每次校準建立一個**分段**（§8）。欄位：

| 欄位 | 規則 |
|---|---|
| `calibrationId` | 檔案內唯一字串（`CALIBRATION_DUPLICATE_ID`）。 |
| `supersedesCalibrationId` | 被取代的前一個校準，或 `null`。若同 boot 內已有未被取代、未失效、未結案的現行校準，必須指向它（`CALIBRATION_SUPERSEDES_MISMATCH`）。指向不存在者為 `CALIBRATION_SUPERSEDES_UNKNOWN`。 |
| `origin` | `manual_upright`（手動靜止直立）｜`auto_straight_ride`（行進中穩定直行累積）｜`carried_over`（跨 boot 沿用，§9）。 |
| `effectiveFromMonotonicUs` | **生效時間**：從此測量時間起，新寫入的傾角估算才可使用本校準。 |
| `writtenMonotonicUs` | 寫入此記錄的時刻。`effectiveFromMonotonicUs` 不得晚於它（不能在未來生效；`CALIBRATION_ORDER`）。 |
| `upDevice`、`leanAxisDevice` | §6。 |
| `leanAxisSource` | `manual_left_lean`：由本次左傾確認得到；`inherited_from_previous`：沿用前一個校準的軸（`supersedesCalibrationId` 必須非 null）；`unknown`：軸未知。**未知的值（含較新寫入端的新值）一律視為 `unknown`。** |
| `leftLeanConfirmation` | `leanAxisSource = manual_left_lean` 時必為物件（`peakLeanMagnitudeDeg`、`durationUs`、`sourceRange`），否則必為 `null`。 |
| `evidence` | 校準依據，依 `origin` 判別：`manual_rest`（`restDurationUs`、`upSpreadDeg`、`sourceRange`）｜`auto_straight`（`accumulatedDurationUs`、`windowCount`、`minSpeedMps`、`maxYawRateRadPerS`、`upSpreadDeg`、`sourceRange`）｜`carried_over` 為 `null`。`sourceRange` 是 motion 檔的單調時間範圍，**早於**生效時間。 |
| `carriedOverFromCalibrationId` | 僅 `carried_over` 為非 null。 |
| `algorithmVersion` | 產生此校準的演算法版本。 |

語義：

1. **手動優先。** 手動校準必須帶 `leftLeanConfirmation`（除非明確繼承前一個軸）。
2. **自動校準只由行進中穩定直行的候選區段建立**，依「累積有效持續時間」（`accumulatedDurationUs`）達標才建立，候選篩選條件（GPS 品質、速度、轉向、震動門檻）屬演算法版本，**不在契約內**，但實際使用的量必須記錄在 `evidence`，讓資料層事後可審。自動校準只提供直立參考；其軸來自繼承或為 `unknown`。
3. **自動參考更新不得追溯改寫已落盤樣本。** 新校準只能在**所有已寫出估算的測量時間之後**生效；否則 `CALIBRATION_RETROACTIVE`。要用新參考重算舊時段，寫新的 lean 檔（§0 規則 2）。
4. **舊校準保留**：新校準不刪除、不修改前一個校準，只標記被取代。
5. **失效** 以 `lean_event.calibration_invalidated` 宣告（`mount_shift_detected`｜`evidence_expired`｜`user_cleared`｜`manual_replaced`｜`auto_replaced`），帶 `invalidatedAtMonotonicUs`。失效時間之後的估算必須 `calibrationId = null`（`no_valid_calibration`），否則 `ESTIMATE_ON_INVALIDATED_CALIBRATION`。

## 8. lean 檔：估算、分段與最大值

### 8.1 估算 `lean_estimate`

| 欄位 | 規則 |
|---|---|
| `measurementMonotonicUs` | **測量有效時刻**：等於其 `sourceRefs` 所引用輸入樣本中**最新**那筆的測量時間（`ESTIMATE_TIME_MISMATCH`，需 motion 檔配對才檢查）。不是計算時刻、不是 UI 時刻。 |
| `computedMonotonicUs` | 計算完成時刻，只用於延遲診斷；不得早於測量時刻（`COMPUTED_BEFORE_MEASURED`）。 |
| `leanAngleDeg` | §6。`null`＋`lean_unavailable`，**不得用 0 代替**。 |
| `calibrationId` | 使用的校準；沒有有效校準時為 `null`＋`no_valid_calibration`，且 `leanAngleDeg` 必為 `null`（`ANGLE_WITHOUT_CALIBRATION`）。 |
| `sourceRefs[]` | 來源樣本關聯：`{sourceId, firstSequence, lastSequence}`，指向 motion 檔同一 `recordingId`、同一 `deviceBootId` 的序號範圍。 |
| `algorithmVersion` | 估算演算法版本（融合與投影）。 |
| `filterEpoch` | 融合狀態紀元：最近一次 `estimator_reset` 的編號（§9.4）。估算依賴該次重設起的**全部**輸入，不只 `sourceRefs`。 |
| `clockMapId` | 輸入樣本的映射，供 UTC 呈現；不影響對時。 |
| `extremumEligible` | 此估算是否可參與分段最大值。 |
| `qualityFlags` | 見下。 |

估算檢查：

- **沒有測量時間就沒有估算。** 輸入樣本的 `measurementMonotonicUs` 為 null 時，寫入端**不得**用 `receivedMonotonicUs` 或任何接收時間填 `lean_estimate.measurementMonotonicUs`，允許（且預期）**完全不寫 `lean_estimate`**，改以 `estimator_state: unavailable` 事件讓 UI 與消費端知道傾角不可用（§8.3）。引用沒有測量時間的樣本是 `SOURCE_REF_NO_MEASUREMENT_TIME`。
- `filterEpoch` 必須等於現行紀元（`ESTIMATE_EPOCH_STALE`／`ESTIMATE_EPOCH_UNKNOWN`）；`estimator_state` 為 `unavailable` 期間不得有任何估算（`ESTIMATE_WHILE_UNAVAILABLE`）。
- `calibrationId` 非 null 時，必須是**現行**校準：校準存在（`CALIBRATION_UNKNOWN`）、同 boot（`CALIBRATION_BOOT_MISMATCH`）、未被取代（`ESTIMATE_STALE_CALIBRATION`）、測量時間不早於其生效（`ESTIMATE_BEFORE_CALIBRATION`）、分段未結案（`ESTIMATE_AFTER_SEGMENT_CLOSED`）。
- 校準的 `leanAxisSource` 不是 `manual_left_lean`／`inherited_from_previous` 時，`leanAngleDeg` 必為 `null`（`ANGLE_WITH_UNKNOWN_AXIS`）。
- 已知旗標：`lean_unavailable`、`no_valid_calibration`、`lean_axis_unknown`、`input_gap`、`after_input_gap`、`dynamic_acceleration_high`、`carried_over_unverified`、`clock_map_unavailable`、`synthetic`。
- **阻擋旗標**（有任一個就不可 `extremumEligible`，`EXTREMUM_ELIGIBLE_BLOCKED`）：`lean_unavailable`、`no_valid_calibration`、`lean_axis_unknown`、`input_gap`、`after_input_gap`、`dynamic_acceleration_high`。`carried_over_unverified` 不阻擋，但存在即表示數值依賴未重新驗證的安裝方位。
- null ⟺ 旗標雙向一致：`leanAngleDeg`↔`lean_unavailable`、`calibrationId`↔`no_valid_calibration`、`clockMapId`↔`clock_map_unavailable`。

### 8.2 分段與最大值

**一個校準 = 一個分段**，分段範圍是 `[effectiveFromMonotonicUs, 結束)`。分段在下列時機結束：被新校準取代、失效、記錄停止、**boot 改變**（單調時間域切斷）、記錄中斷。每個分段**各自保存**左、右最大值，舊分段的最大值永不被新分段覆蓋或合併。

**最大值只計品質合格的估算**：`extremumEligible = true`，因此不含無效值、`dynamic_acceleration_high`、缺口後尚未收斂等。

**最大值的保守定義**（工程起始規則，契約把規則本身記為資料，不寫死數值）：`lean_started.extremumPolicy` 宣告 `rule: "min_abs_in_same_side_window"` 與 `minWindowUs`：取「連續至少 `minWindowUs`、全部同側、全部合格」的窗口內**絕對值最小**的估算作為該窗口的峰值。尖峰、單筆雜訊因此不會成為最大值。窗口被無效值、跨 boot、時間逆序或缺口打斷時清除。**這個規則尚未與動態參考比較，不代表真實最大傾角的準確度。**

最大值以**追加記錄**表達，不改寫：

`lean_extremum`：`calibrationId`、`side`（`left`｜`right`）、`peakAbsAngleDeg`（≥0 的大小，不帶符號）、`eventMonotonicUs`（**事件時間**＝代表該峰值的那筆估算的測量時間）、`estimateSequence`（該估算的序號）、`windowStartMonotonicUs`／`windowEndMonotonicUs`、`policyVersion`。

- 同一 `(calibrationId, side)` 的 `peakAbsAngleDeg` **不遞減**（`EXTREMUM_DECREASED`）：只在創新高時才追加。
- 引用的估算必須存在、屬同一校準、`extremumEligible`，且符號與 `side` 一致、`|leanAngleDeg| = peakAbsAngleDeg`、`measurementMonotonicUs = eventMonotonicUs`（`EXTREMUM_ESTIMATE_INELIGIBLE`／`EXTREMUM_VALUE_MISMATCH`）。
- 窗口須包含事件時間，且長度不短於 `lean_started.extremumPolicy.minWindowUs`（`EXTREMUM_WINDOW_TOO_SHORT`）。
- **沒有任何合格估算的一側，最大值為 `null`**，不是 0。

`lean_segment_closed`：分段結束時寫入，`calibrationId`、`closedAtMonotonicUs`、`closeReason`（`recalibrated`｜`calibration_invalidated`｜`recording_stopped`｜`boot_changed`｜`recording_interrupted`）、`maxLeft`／`maxRight`（`{peakAbsAngleDeg, eventMonotonicUs, extremumSequence}` 或 `null`）、`eligibleEstimateCount`、`ineligibleEstimateCount`（供 UI 顯示，**驗證器不核對**，因 `records_dropped` 會使它們不精確）。

- `maxLeft`／`maxRight` 必須等於該分段 `lean_extremum` 記錄中該側**最後（即最大）**的一筆，沒有則為 `null`（`SEGMENT_SUMMARY_MISMATCH`）。
- 每個分段最多結案一次（`SEGMENT_CLOSED_TWICE`）；結案後不得再有估算引用它。
- **`lean_segment_closed` 是可選的。** 崩潰或截斷後分段可能沒有結案記錄：消費端必須能只由 `lean_extremum` 記錄還原未結案分段的最大值。
- `lean_segment_closed.deviceBootId` 是**該分段所屬的 boot**（結案可能在重開機後才寫，此時它不參與 boot 變更的偵測）。

### 8.3 lean 事件 `lean_event`

共同欄位同 location-log 事件（單一序號空間，`lastSequence`）。

| `eventType` | 專屬欄位 |
|---|---|
| `lean_started` | `platform`、`appVersion`、`algorithmVersion`、`inputSourceIds[]`、`maxInputGapUs`、`replayable`、`extremumPolicy{policyVersion, rule, minWindowUs}`。其後必須有 `estimator_reset`（`filterEpoch = 0`，`reason = start`）。 |
| `estimator_reset` | `filterEpoch`、`reason`（`start`｜`after_input_gap`｜`input_clock_state_change`｜`raw_write_failure`｜`boot_changed`｜`recovery`）、`initialInputs[]`（`{sourceId, firstSequence}`：新紀元消費的第一筆輸入序號）。紀元從 0 起逐一遞增（`ESTIMATOR_EPOCH_ORDER`）。 |
| `estimator_state` | `state`（`available`｜`unavailable`）、`reason`（`unavailable` 時必填：`input_clock_not_verified`｜`input_interrupted`｜`raw_write_failed`；`available` 時為 `null`）。從 `unavailable` 回到 `available` 之後，第一筆估算必須屬於**新**紀元（需要 `estimator_reset`），因為融合狀態沒有撐過中斷。 |
| `calibration_invalidated` | `calibrationId`、`invalidatedAtMonotonicUs`、`reason` |
| `records_dropped` | `droppedCount`、`firstDroppedMonotonicUs`、`lastDroppedMonotonicUs`（可為 null）、`reason`（`buffer_full`｜`writer_error`｜`recording_paused`） |
| `clock_adjusted`／`log_truncated`／`recording_resumed` | 同 location-log，`resumedSequence` 為單一整數 |

## 9. 缺樣、跨 boot、截斷恢復

### 9.1 缺樣

1. 缺樣以 `samples_dropped`（motion）或 `records_dropped`（lean）表達，**不佔序號**。測量時間範圍可為 `null`（寫入端不知道時），此時缺口視為落在「該來源最後一筆樣本」與事件時刻之間。
2. 相鄰樣本時間差超過 `gapThresholdUs` 而沒有事件涵蓋，是警告 `MOTION_TIME_GAP`（資料不可信，但不整檔作廢）。
3. **禁止跨缺口插出假資料。** 估算的 `sourceRefs` 範圍若橫跨該來源已記錄的缺口，該估算必須 `leanAngleDeg = null` 且帶 `input_gap`（`ESTIMATE_SPANS_GAP`，需配對檢查）。缺口之後第一個估算建議帶 `after_input_gap`，並維持 `extremumEligible = false` 直到濾波重新收斂；收斂條件屬演算法版本。
4. **不知道缺了多少就不要猜。** 感測器中斷（`sensor_interrupted`／`sensor_unavailable`／`writer_error`）時 `droppedCount` 與兩個時間界限可為 `null`；只有寫入端自己的計數器能確知數量的 `buffer_full` 必須帶數字（schema 強制）。範圍為 null 時，缺口視為落在該來源最後一筆樣本與事件時刻之間。
5. 有界緩衝滿載時**丟棄新樣本並計數**，不得阻塞感測器 callback、不得無界成長（§11）。

### 9.2 跨 boot

沿用 location-log §7：

1. `deviceBootId` 可在同一 recording 中途改變；該處是單調時間不連續點。消費端必須在此切斷單調推算，**不得**跨 boot 相減。
2. boot 改變必須先由 `clock_adjusted` 或 `recording_resumed` 宣告，否則警告 `BOOT_ID_CHANGE_UNDECLARED`。
3. **序號跨 boot 連續**（`recording_resumed.resumedSequences` 接續）。
4. 新 boot 必須寫新的 `motion_started`（來源能力可能不同）與新的 `clock_map`（舊映射不適用，`CLOCK_MAP_BOOT_MISMATCH`）。
5. **校準只對產生它的 boot 有效**（`CALIBRATION_BOOT_MISMATCH`）。重開機後：
   - 舊分段以 `boot_changed` 結案（或不結案，§8.2）；
   - 寫入端可寫一個 `origin = carried_over` 的新校準沿用舊安裝方位（需 `carriedOverFromCalibrationId`、`evidence = null`，估算帶 `carried_over_unverified`），**或**停止輸出傾角（`calibrationId = null`）直到新的手動／自動校準。使用者可能在重開機期間取下手機，v1 不規定寫入端必須沿用哪一個，見 §14 問題 4。
   - 新分段的最大值**從「沒有有效最大值」（`null`）開始**，不與舊分段合併；有第一筆合格估算之後才出現數值（§8.2）。

### 9.3 截斷恢復

1. 崩潰可能留下不完整的末行。續錄前截斷至最後一個完整換行，寫 `log_truncated`（motion：`resumedSequences` 為各來源下一個序號；lean：`resumedSequence`）。被截斷而消失的序號是**有佐證的缺口**，不報 `SEQUENCE_GAP`。
2. 恢復後同一 boot 內的續錄寫 `recording_resumed`（`crash`／`process_restart`）。
3. 恢復**不重寫**舊資料；lean 的未結案分段保持未結案。若寫入端能確定該分段已過期，在續錄後以 `recording_interrupted` 結案，結案時間取最後已知估算的測量時間。
4. 重讀整份檔案必須冪等：鍵為 `(recordingId, sourceId, sequence)`（同 location-log §7.7）。單一檔案內重複序號是缺陷（`SEQUENCE_DUPLICATE`／`SEQUENCE_CONFLICT`）。

### 9.4 融合重播與 `sourceRefs`

融合有歷史狀態（姿態濾波器的內部狀態取決於它看過的整段輸入），所以：

1. **`sourceRefs` 只標示估算的最新輸入，它定義估算時刻，不等於融合歷史。** 重播一個估算，必須從它所屬紀元的邊界開始：`estimator_reset.initialInputs` 指出每個輸入來源的起點序號，重播使用該序號到估算引用的 `lastSequence` 之間**完整且已保存**的 motion 輸入。
2. **紀元在輸入不連續時必須重設**：缺樣（`samples_dropped`）、序號缺口（截斷）、來源時鐘狀態變更、boot 改變、原始寫入失敗、續錄恢復。重設的 `reason` 記錄原因。
3. **`replayable`（`lean_started`）是寫入端的宣告**，`true` 的意思是：每個非 null 估算都可僅憑已存的輸入從紀元邊界重播。配對驗證強制：
   - 輸入來源的 `storageStride` 必須為 1，否則 `REPLAY_STRIDE_DROPS_INPUTS`——**被 stride 略過的樣本是演算法實際用過的輸入時，不能聲稱可重播**。需要降低儲存頻率時，寫入端必須宣告 `replayable = false`（估算仍然有效，只是不可重播）；
   - 紀元起點到引用終點之間，輸入序號必須連續存在且在同一 boot、沒有缺口／狀態變更（`REPLAY_INPUTS_INCOMPLETE`）；
   - 引用不得早於紀元起點（`SOURCE_REF_BEFORE_EPOCH`）。
   `sourceRefs` 必須列出每個影響該估算的輸入來源；null 角度的估算（例如橫跨缺口者）不主張重播。
4. **原始寫入失敗**：估算只可引用**已成功追加**到 motion 檔的序號（`SOURCE_REF_UNRESOLVED`）。寫入失敗的樣本沒有序號、以 `samples_dropped`（`writer_error`）記錄；若濾波器已經消費了該樣本，必須立即 `estimator_reset`（`raw_write_failure`），起點為失敗之後第一個已存序號，之後的估算才可聲稱可重播。
5. **寫入順序**：lean 估算引用的 motion 行，必須先於該估算行被追加（並依寫入端的 flush 策略落盤）。崩潰後若 lean 引用了 motion 檔尾端已遺失的序號，那是資料遺失而非合法狀態，驗證會報 `SOURCE_REF_UNRESOLVED`；續錄時 `estimator_reset`（`recovery`）把紀元切在恢復點。

## 10. 與 location-log v1 的相容性

- location-log v1 **完全不變**，沒有新欄位、新 `eventType` 或新旗標。
- motion／lean 的 `recordType` 在 location-log v1 的驗證器與匯入器中屬**未知 `recordType`**：依 location-log §4 原樣保留、計數、繼續，**不視為損壞**，也不會被誤判為 `sample` 或 `event`。這由 fixtures 強制：每個合法 motion／lean fixture 必須通過 `validate-location-log.mjs` 且零 sample、零 event。
- 反向：motion／lean 驗證器遇到 location-log 的 `sample`／`event` 行同樣視為未知 `recordType`（警告）。
- `deviceBootId`、`recordingId` 的判定與 location-log 完全共用，不在這份契約重新定義。

## 11. 寫入端規則

1. **單一寫入者**：每個檔案一條序列化寫入路徑。多個感測器 callback 把樣本放進**有界緩衝**，由單一寫入執行緒消費並指派序號。事件與樣本同一路徑。
2. **有界緩衝**：容量與溢位策略由 Codex 定；契約只要求溢位時丟棄並以 `samples_dropped` 記錄，且 callback 不阻塞。
3. `motion_started` 與其 `clock_map` 必須排在該段第一筆樣本之前。
4. 序號只在成功寫入後遞增。
5. **儲存量須預估**：一筆樣本約 330 位元組（fixtures 實測）。三個感測器各 50 Hz、全存，約 50 KB/s、約 180 MB／小時；100 Hz 約 360 MB／小時。這是 `storageStride`／採樣週期必須可調的原因，見 §14 問題 3。
6. 不得用「反覆讀整個高頻檔案」取得即時值；即時顯示由原生端記憶體中的最新估算經 EventChannel（限頻）傳遞，檔案只用於事後。
7. 紀錄檔不得寫入 token、帳號資料或其他與感測無關的敏感內容。

## 12. 版本與前向相容

- `schemaVersion` 為整數 `1`，兩個檔案共用。
- 未知 `recordType`：原樣保留、計數、繼續（`UNKNOWN_RECORD_TYPE` 警告）。
- 已知 `recordType` 的未知 `eventType`：只要滿足事件共同欄位就保留並計數（`UNKNOWN_EVENT_TYPE` 警告）。
- 未知 `sensorType`：只要滿足樣本共同欄位就保留（`UNKNOWN_SENSOR_TYPE` 警告），感測器數值欄位不檢查；它仍須在 `motion_started` 宣告並與宣告的 `sensorType` 一致。
- 未知 `qualityFlag`：原樣保留，不視為有效（`UNKNOWN_QUALITY_FLAG` 警告）。**`extremumEligible` 以寫入端的宣告為準，消費端不依旗標重新判定。**
- 未知 `leanAxisSource`：視為 `unknown`。
- 新增可選欄位仍須走契約 PR（已知記錄 `additionalProperties: false`）；優先以新旗標、新 `eventType`、新 `sensorType` 擴充，三者都有向前相容規則，不需動版本。
- 破壞性變更使用新 `schemaVersion`，並在本文件寫明判別與遷移。
- 舊版 App 與舊檔案：v1 之前沒有 motion／lean 檔，沒有遷移需求。沒有 motion／lean 檔的記錄是合法的（功能未啟用），消費端不得因檔案不存在而失敗。

## 13. 驗證與案例

```bash
npm install --prefix contracts/tools
npm test --prefix contracts/tools
node contracts/tools/validate-motion-lean.mjs <motion.ndjson>
node contracts/tools/validate-motion-lean.mjs [--motion <motion.ndjson>] <lean.ndjson>
```

不加 `--motion` 時，lean 檔只做單檔規則；加上之後才檢查 `sourceRefs`、估算時間與缺口。

fixtures 位於 `testdata/contracts/motion-lean/v1/`：

- `motion/valid|invalid/`、`lean/valid|invalid/` — `valid/` 必須零 error；`invalid/` 每個 `.ndjson` 有同名 `.expected` 列出必須出現的 error 代碼；`valid/` 內可有 `.warnings` 列出必須出現的警告。
- `pairs/valid|invalid/<案例>/{motion,lean}.ndjson` — 需要兩份檔案才能判定的規則。invalid 的 lean 單獨驗證必須通過（跨檔規則是 opt-in）。
- 合法案例涵蓋：最小 Android、缺樣有佐證、跨 boot 續錄、截斷有佐證、iOS 時鐘未驗證、`clock_adjusted` 新映射、前向相容未知項、手動＋自動分段與最大值、無校準的 null、跨 boot 沿用校準、截斷後未結案分段、校準失效。
- 非法案例涵蓋：單位誤用、四元數非單位、null／旗標不一致、序號衝突／重複、時間逆序、時鐘映射缺漏／跨 boot、來源未宣告、事件序號超前、軸不正交、追溯校準、使用已被取代的校準、最大值遞減／與估算不符、分段摘要不符、尾行損毀等。

### 錯誤碼

error（資料不可信，驗證失敗）：
`NOT_JSON`、`MISSING_RECORD_TYPE`、`SCHEMA_INVALID`、`NULL_FLAG_MISMATCH`、`SEQUENCE_CONFLICT`、`SEQUENCE_DUPLICATE`、`MONOTONIC_REGRESSION`、`MEASUREMENT_MONOTONIC_REGRESSION`、`EVENT_SEQUENCE_AHEAD`、`MEASUREMENT_AFTER_RECEIVED`、`MEASUREMENT_CLOCK_MISMATCH`、`QUATERNION_NOT_UNIT`、`SOURCE_NOT_DECLARED`、`SENSOR_TYPE_MISMATCH`、`SOURCE_CLOCK_STATE_CHAIN`、`SOURCE_CLOCK_REDECLARED`、`CLOCK_MAP_UNKNOWN`、`CLOCK_MAP_BOOT_MISMATCH`、`CLOCK_MAP_ID_REUSED`、`VECTOR_NOT_UNIT`、`AXIS_NOT_ORTHOGONAL`、`CALIBRATION_DUPLICATE_ID`、`CALIBRATION_SUPERSEDES_UNKNOWN`、`CALIBRATION_SUPERSEDES_MISMATCH`、`CALIBRATION_ORDER`、`CALIBRATION_RETROACTIVE`、`CALIBRATION_UNKNOWN`、`CALIBRATION_BOOT_MISMATCH`、`ESTIMATE_STALE_CALIBRATION`、`ESTIMATE_BEFORE_CALIBRATION`、`ESTIMATE_ON_INVALIDATED_CALIBRATION`、`ESTIMATE_AFTER_SEGMENT_CLOSED`、`ANGLE_WITHOUT_CALIBRATION`、`ANGLE_WITH_UNKNOWN_AXIS`、`COMPUTED_BEFORE_MEASURED`、`EXTREMUM_ELIGIBLE_BLOCKED`、`EXTREMUM_DECREASED`、`EXTREMUM_ESTIMATE_INELIGIBLE`、`EXTREMUM_VALUE_MISMATCH`、`EXTREMUM_WINDOW_TOO_SHORT`、`SEGMENT_SUMMARY_MISMATCH`、`SEGMENT_CLOSED_TWICE`、`ESTIMATOR_EPOCH_ORDER`、`ESTIMATE_EPOCH_UNKNOWN`、`ESTIMATE_EPOCH_STALE`、`ESTIMATE_WHILE_UNAVAILABLE`；配對檢查另有 `SOURCE_REF_UNRESOLVED`、`SOURCE_REF_BOOT_MISMATCH`、`SOURCE_REF_NO_MEASUREMENT_TIME`、`SOURCE_REF_BEFORE_EPOCH`、`ESTIMATE_TIME_MISMATCH`、`ESTIMATE_SPANS_GAP`、`REPLAY_INPUTS_INCOMPLETE`、`REPLAY_STRIDE_DROPS_INPUTS`。

warning（契約明文容忍，不失敗）：
`SEQUENCE_GAP`、`BOOT_ID_CHANGE_UNDECLARED`、`UNKNOWN_QUALITY_FLAG`、`UNKNOWN_RECORD_TYPE`、`UNKNOWN_EVENT_TYPE`、`UNKNOWN_SENSOR_TYPE`、`MISSING_MOTION_STARTED`、`MISSING_LEAN_STARTED`、`MOTION_TIME_GAP`、`MEASUREMENT_RECEIVED_SKEW`。

### 型別策略

沿用 location-log 的決定（`docs/decisions/0001-location-log-format.md` D8）：JSON Schema 是唯一真實來源，**暫不生成** Dart／Kotlin 模型，兩端以同一批 fixtures 對齊。Kotlin 寫入端（Codex）不需要 schema 生成的模型，但輸出必須通過 `validate-motion-lean.mjs`。

## 14. 已知限制與待 Codex 確認

這份契約**不證明任何量測準確度**：幾何核心的合成向量只驗證座標與校準窗口，不證明道路量測。沒有與參考設備比較前，只能宣稱重播一致性與邏輯正確（工程規則 §2.8）。

iOS：v1 對 iOS 只定義宣告與型別（`measurementClock = unverified`、來源 `unavailable`），**不聲稱已能採集傾角**，也不聲稱 Core Motion 時間戳的時間域。待 Android V1.0 基礎功能／UI 真機通過後再排 iOS 真機。

Codex 對 PR 初版的實作決定（已採納為契約前提，不再是開放問題）：

- callback 非等待式放入有界緩衝，滿載丟新；單一 writer，完整行追加成功後才遞增序號；保留缺樣事件的緩衝容量。
- 初版三個來源各目標 50 Hz、`storageStride = 1`；批次寫入多行 NDJSON，不新增 `motion_batch`。
- 跨 boot **不沿用**有效校準：重新校準前傾角不可用，新分段最大值為 `null`。`carried_over` 在 v1 保留為合法值但本實作不使用。
- 姿態優先 `game_rotation_vector`，`rotation_vector` 為替代；動態融合在 Kotlin，Dart 只做 UI／控制。
- UTC 映射先用 `wall_clock_pair`；UI 只發布**已成功寫入**的估算。
- 最大值窗口起始值 `minWindowUs = 100000`，仍是**未驗證的估算政策**。

仍待實作與真機確認：

1. 啟動時驗證 `SensorEvent.timestamp` 屬 elapsedRealtime 域的判斷與門檻；運行中失敗的偵測方式（何時寫 `source_clock_state` ＝ `verification_failed`）。
2. `wall_clock_pair` 實際的 `uncertaintyUs` 量級。
3. 儲存量（約 180 MB／小時）在目標手機上是否可接受；若需降頻，必須同時把 `replayable` 宣告為 `false`（§9.4）。
4. §9.4 第 5 點的寫入順序在崩潰時能否保證，或需要在續錄時主動比對兩個檔案。
5. `after_input_gap`／濾波收斂條件的具體判定（屬演算法版本）。
