# 動態感測與傾角紀錄契約 v2（motion／lean）

`schemaVersion: 2`。本文件是 v2 的規範本文；`common.schema.json`、`motion.schema.json`、`lean.schema.json` 是可機器檢查的部分，兩者衝突時以本文件為準。跨行規則由 `contracts/tools/validate-motion-lean.mjs` 強制，錯誤碼見 §9。

**v2 是 v1 的修訂，不是另一份格式。** [`../v1/README.md`](../v1/README.md) 中**未在本文件列出差異的部分，全部原樣適用於 v2**（座標軸、單位、時間、`clock_map`、傾角定義、校準分段、缺樣、跨 boot、截斷、`sourceRefs` 語義等），只把 `schemaVersion` 讀作 `2`。本文件與 v1 衝突時以本文件為準。

決策背景：[`docs/decisions/0003-motion-lean-reliability-r2.md`](../../../docs/decisions/0003-motion-lean-reliability-r2.md)（設計稿；本文件是其 C1 範圍的規範化結果，有出入處以本文件為準，出入已列在該文件末尾）。

## 0. 範圍

C1（本文件）涵蓋：版本與相容、session 與時間選樣、準確度狀態、控制序號、lean run 識別、資格、污染傳遞、自動參考控制狀態與 hint。

**不在 v2 目前的規範內**（schema 與驗證器都不接受，須走後續契約 PR）：`lean_input`、`filter_spec`、`derived-*` 串流、聯合 frame、`refilter` 重播（`replayScope.refilter` 必須為 `false`）、`--location` 交叉核對、有界／外存驗證器（C2）。

location-log v1 **完全不變**。motion／lean 的 `recordType` 在 location-log 驗證器中仍屬未知 `recordType`。

## 1. 版本與相容

1. 一個實體檔固定一個 `schemaVersion`。檔內任一行版本不同 → `SCHEMA_VERSION_MIXED`。motion 與 lean 配對驗證時版本必須相同。
2. 工具遇到 `schemaVersion` 不是 1 或 2 → `UNSUPPORTED_SCHEMA_VERSION`，exit code **4**，不回報 PASS，不套用任何規則。
3. **v2 寫入端不得續錄或追加 v1 檔，v1 寫入端也不得追加 v2 檔。** 版本不符的 recording，其 motion／lean 就地封存（GPS 照常），使用者新開 recording 才使用新版。
4. 工具相容矩陣：

| | v1 檔 | v2 檔 | 版本 ≥3 |
|---|---|---|---|
| PR #10 初版工具（`7474933`） | 照舊 | 拒絕（`SCHEMA_INVALID`） | 拒絕 |
| 目前工具 | 讀、驗證，含 v1 §A.3 的歷史修正 | 讀、驗證 | exit 4 |

v1 的歷史修正（V1-1～V1-5）見 [`../v1/README.md`](../v1/README.md) 末節「修正紀錄」。

## 2. session 與宣告

**session** ＝ 一個 `motion_started` 起，到下一個 `recording_resumed`，或下一個「改變 `deviceBootId` 的 `clock_adjusted`」為止。

- **同 boot 的純 UTC `clock_adjusted`**（`previousDeviceBootId == deviceBootId`）**不是** session 邊界：只新增 `clock_map`；不重設選樣桶、不重設來源時鐘狀態、不許換 policy。（v1 把它當 segment 邊界。）
- 宣告（`inputPolicy`、`storageStride`、`gapThresholdUs`、`requestedSamplingPeriodUs`）**只在新 session 的 `motion_started` 生效**；同 session 內重複宣告不同值 → `POLICY_REDECLARED`。
- 每筆樣本與每個 `sourceRefs` 引用，以它**所在 session** 的宣告判定（`sessionOrdinal` ＝ 該樣本在 motion 檔內位於第幾個 `motion_started` 之後）。跨檔引用依 raw 樣本在 motion 檔的位置解析，不比較 lean 行號與 motion 行號。引用的首尾樣本不在同一 session → `SOURCE_REF_SPANS_SESSIONS`。

## 3. `inputPolicy` 與 `storageStride`（只有兩種合法組合）

| `inputPolicy` | `storageStride` | 結果 |
|---|---|---|
| 缺省 | `1` | 合法：全存（非 lossy） |
| `time_bucket_first`、`lossy: true` | `null` | 合法：時間桶選樣（lossy） |
| 缺省 | ≥2 | `SCHEMA_INVALID`（v2 不保留型號除數） |
| 缺省 | `null` | `STRIDE_POLICY_CONFLICT` |
| 存在 | `1` | `STRIDE_POLICY_CONFLICT` |
| 存在 | ≥2 | `SCHEMA_INVALID` |

`inputPolicy.kind` 只允許 `time_bucket_first`，`lossy` 必為 `true`，其餘 kind 或 `lossy: false` → `SCHEMA_INVALID`（新增 kind 需契約 PR）。`available: false` 的來源既無 policy 也無 stride。

```json
"inputPolicy": { "kind": "time_bucket_first", "periodUs": 20000, "policyVersion": "tbf-1", "lossy": true,
                 "verifiedAnchorRule": "first_verified_measurement", "unverifiedRule": "received_time_bucket" }
```

## 4. 時間桶選樣

每來源每個 anchor 之後：`bucket = floor((t − anchorUs) / periodUs)`，每個桶最多保存一筆**真實**事件，不補點、不內插、不改時間。已驗證的時鐘用 `measurementMonotonicUs`（`timeBase: measurement`）；未驗證／不可用用 `receivedMonotonicUs`（`timeBase: received`），此時樣本的測量時間維持 `null`，**不得**進估算。

新增 `motion_event`（皆帶 `controlSequence`，§5）：

| `eventType` | 欄位 | 規則 |
|---|---|---|
| `selection_anchor` | `sourceId`、`policyVersion`、`timeBase`、`anchorUs`、`reason`（`start`｜`clock_epoch`｜`gap`｜`resume`） | 每個 session 開始、`source_clock_state` 變更、`samples_dropped`（對有 policy 的來源）之後，下一筆保存樣本之前必須有一筆（否則 `SELECTION_ANCHOR_MISSING`）。`timeBase` 必須與當時時鐘狀態相符（`ANCHOR_TIMEBASE_MISMATCH`）。無 policy 的來源出現它 → `SELECTION_WITHOUT_POLICY`。純 UTC 校時**不**重設 anchor。 |
| `selection_stats` | 見 §4.1 | 不重疊窗口的結算。 |
| `source_accuracy_state` | `sourceId`、`previousAccuracyState`、`accuracyState`、`atMeasurementMonotonicUs`（可為 `null`）、`atReceivedMonotonicUs`、`reason`（`accuracy_callback`｜`sample_observed`） | 見 §4.2。 |

同一 anchor、同一 `timeBase` 下連續兩筆保存樣本落在同一桶 → `SELECTION_BUCKET_VIOLATION`。

`samples_dropped.reason` 新增 `measurement_nonmonotonic`（重複／逆序測量；`droppedCount` 必須為已知數字）。它不是主動略過。

### 4.1 `selection_stats`

窗口以 `windowIndex`（每來源每 session 從 0 連號）標示，**不重疊**。欄位：`closeReason`（`periodic`｜`sync`｜`segment_end`｜`stop`｜`session_end`｜`recovered_unsettled`）、`firstKeptSequence`／`lastKeptSequence`（`keptCount = 0` 時**必為 `null`**，不得發明序號）、`keptCount`（只計成功追加）、`receivedCount`、`skippedIntentionalCount`、`invalidCount`、`nonmonotonicCount`、`bufferDroppedCount`、`pendingIn`／`pendingOut`、`observedAccuracyTransitions`、`complete`。

- 驗證器核對：`windowIndex` 連號、`policyVersion`、`keptCount` 與首尾序號等於窗口內實際保存的樣本、`observedAccuracyTransitions`（若非 `null`）等於窗口內 `source_accuracy_state` 數 → `SELECTION_STATS_MISMATCH`。
- `complete = true` 時另核對等式 `receivedCount + pendingIn = keptCount + skippedIntentionalCount + invalidCount + nonmonotonicCount + bufferDroppedCount + pendingOut`，`bufferDroppedCount` 等於窗口內 `samples_dropped(buffer_full)` 的總和，`pendingIn` 等於前一窗口的 `pendingOut`。`complete = false`（`recovered_unsettled`）時各計數為 `null`，等式不適用。
- **崩潰未結算**：檔案結尾（或下一個 session 開始前）仍有保存樣本而無 `selection_stats` → 警告 `UNSETTLED_SELECTION_WINDOW`，**不把有效 raw 判為損壞**。續錄時寫入端補一筆 `recovered_unsettled`。
- 結算至少每 5 秒及每次邊界一次，不跟每次 sync。

### 4.2 準確度狀態

狀態集合：`unobserved`（session 開始時每來源的初始值）、`unavailable`（平台不提供，樣本帶 `accuracy_unavailable`）、`unreliable`、`low`、`medium`、`high`。

- **保證範圍**：寫入端 looper **觀測到**的每一次轉換（`onAccuracyChanged` 或樣本自帶的 `accuracyLevel` 變化，不論該樣本是否被選樣保留）都寫 `source_accuracy_state`。OS 沒回報的轉換**不在保證內**；驗證器**不能**證明沒有漏掉的觀測。
- 兩種回呼共用同一個現行值；值未變不寫事件。回呼沒有測量時間時 `atMeasurementMonotonicUs` 為 `null`，不得套用上一筆樣本的時間。
- 鏈式檢查：`previousAccuracyState` 必須等於現行值且與新值不同 → `ACCURACY_STATE_CHAIN`。
- 對**有 `inputPolicy` 的來源**，保存樣本的 `accuracyLevel`（`null` 視為 `unavailable`）與現行狀態不同而其間沒有事件 → `ACCURACY_CHANGE_UNRECORDED`。這是必要條件檢查：high→unreliable→high 全發生在被略過的 callback 時，保留樣本兩端都是 high，此檢查看不見，由 `observedAccuracyTransitions` 對帳與寫入端的合成測試承擔。
- 估算輸入的最差準確度排序：`unreliable` < `unobserved` ＝ `unavailable` < `low` < `medium` < `high`；未知不會被 high 蓋掉。

## 5. 控制序號

每個 `motion_event` 帶必填 `controlSequence`：整數，從 0 起、全檔連續（含跨 boot）、只在成功追加後遞增，與樣本 `sequence` 獨立。

- 跳號 → `CONTROL_SEQUENCE_GAP`，除非該事件是 `log_truncated` 或 `recording_resumed`（被截斷而消失的事件由它們佐證）；倒退或重複 → `CONTROL_SEQUENCE_REGRESSION`。
- 事件相對樣本的位置仍由 `lastSequences` 表達；重播順序＝檔案順序。
- 控制事件不得被佇列重排或略過；保存不了狀態轉換就停止 motion。
- lean 的消費邊界：`lean_estimate.motionControlCursor` ＝ 該估算**最新輸入樣本之前**、motion 檔中最後一個事件的 `controlSequence`（沒有則 `-1`），**不含**之後的事件。配對驗證：超過 motion 檔最大值 → `CONTROL_CURSOR_AHEAD`；不等於 → `CONTROL_CURSOR_MISMATCH`。`estimator_reset.initialControlCursor` 同語義（只檢查不超前）。

## 6. lean：run 與串流

- **一個 lean 檔只含一個 `leanRunId`，每一行都帶它**（`RUN_ID_MISMATCH`）。建議檔名 `<recordingId>.lean.<leanRunId>.ndjson`。不使用 manifest 檔（它是可變狀態）。序號鍵為 `(recordingId, leanRunId, sourceId, sequence)`。
- 每個串流有自己的 `sourceId` 與序號：`lean-estimator`（`lean_calibration`、`lean_estimate`、`lean_extremum`、`lean_segment_closed`）、`lean-hint`（`lean_hint`）。事件不佔序號；`lean_event` 的 `lastSequence` 改為 `lastSequences`（`sourceId → 最後序號`，之前 `-1`），`log_truncated`／`recording_resumed` 的 `resumedSequence` 改為 `resumedSequences`。
- `lean_started` 新增必填欄位：`inputSources[]`（`{sourceId, stream: "motion"}`，取代 `inputSourceIds`）、`inputConsumption`（`stored_only`：估算只消費已保存的輸入與控制事件）、`replayScope`、`autoReferenceConfigFingerprint`、`qualification`、`derivesFrom`。
- 禁止跨 run 引用（校準、估算、`supersedesCalibrationId`、`carriedOverFromCalibrationId` 皆只在本 run 內解析）。新 run 必須是**另一個檔**，不得追加到舊 run；不繼承舊 run 的校準與最大值。
- `derivesFrom: null | {leanRunId, reason, parentByteLength, parentPrefixSha256, parentLastSequences, parentValidation, coverage}`。`parentByteLength`／`parentPrefixSha256` 指封存父檔從檔首起的一段不可變位元組前綴；`parentValidation` 描述這段前綴整體，**不得**藉排除壞行令失敗的父檔看似通過；`parentLastSequences` 可逐串流為 `null`；`coverage.complete = false` 的部分重算不得被消費端當成全行程結果。`--parent <old.lean>` 核對前綴長度與 SHA-256（`DERIVED_RUN_PARENT_MISMATCH`）；未提供則結果的 `crossFileChecks.parent` 為 `not_run`。
- raw 檔出現完整損壞行（`NOT_JSON`、重複／衝突序號、身分異常）：**封存 raw，不再追加；該 recording 的 motion 停止，GPS 繼續**。完整行永不截斷、不改寫。

## 7. 重播範圍、資格與污染

### 7.1 `replayScope`

`{estimate, calibration, refilter}` 三個布林。`replayable` 必須等於 `replayScope.estimate`（`REPLAY_SCOPE_MISMATCH`）。`refilter` 在 v2 目前必為 `false`（`REFILTER_SPEC_UNRESOLVABLE`）。**三者在各自資料與寫入端的決定性重播測試完成前一律維持 `false`**；schema 通過、驗證器通過或 `qualificationRef` 存在都不能替代重播證據。`stored_only` 輸入下，從時間桶保存的輸入重播估算在結構上完整（序號只計已保存的樣本）；`REPLAY_STRIDE_DROPS_INPUTS` 只對 v1 的整數 stride 有意義，v2 的 `storageStride` 只會是 `1` 或 `null`。

### 7.2 資格 `qualification`

`{status: experimental | qualified, qualificationRef, qualifiedConfiguration, configurationFingerprint}`。

- `experimental`：每個估算必須帶 `algorithm_unqualified`（`EXPERIMENTAL_ESTIMATE_UNFLAGGED`），`extremumEligible` 必為 `false`，不得有 `lean_extremum`（`EXTREMUM_IN_EXPERIMENTAL_RUN`）。
- `qualified`：`qualificationRef` 必須非空（`QUALIFIED_WITHOUT_REF`）；`qualifiedConfiguration`（完整配置：`algorithmVersion`、`extremumPolicy`、`autoReferenceConfigFingerprint`、每個輸入的 `inputPolicy`／`storageStride`、`estimatorOutputPeriodUs`、`applicability`）的 canonical JSON SHA-256 必須等於 `configurationFingerprint`（`QUALIFICATION_FINGERPRINT_MISMATCH`），並與 `lean_started` 的 `algorithmVersion`／`extremumPolicy`／`autoReferenceConfigFingerprint`，以及（配對模式）motion 各 session 的輸入宣告逐項相符（`QUALIFIED_CONFIG_MISMATCH`）。
- **檔案中的 `qualified` 只是寫入端的宣告，`qualificationRef` 的存在不是精度證明**（工程規則 §2.8）。驗證器不查私有證據，因此不輸出「已核驗」；本機核驗註冊表（`--qualification-registry`）留待 C2。

### 7.3 污染傳遞（含 v1）

污染集合：v1 ＝ {`sensor_accuracy_unreliable`, `calibration_input_unverified`}；v2 再加 `sensor_accuracy_unknown`。

- 校準的 `qualityFlags` 與污染集合有交集 → 所有使用該校準的 `lean_estimate` 必須帶 `calibration_input_unverified`（`ESTIMATE_CALIBRATION_TAINT_DROPPED`），**與該估算是否 eligible 無關**。
- 來源準確度恢復 high **不洗白**舊校準；只有新的校準（新 `calibrationId`、乾淨旗標、完整 evidence）能解除。
- `carried_over` 校準必須保留來源校準的污染旗標（`CARRIED_OVER_TAINT_DROPPED`）。
- v2 已知旗標新增 `sensor_accuracy_unreliable`、`calibration_input_unverified`、`sensor_accuracy_unknown`、`algorithm_unqualified`，皆為阻擋旗標（有任一個就不可 `extremumEligible`）。

## 8. 自動參考：`lean_hint` 與控制狀態

`AutoUprightReference` 的決策由下列記錄重現（手動校準結果仍是記錄輸入，**不**宣稱可重算）。

**`lean_hint`**（`sourceId: lean-hint`）：每次餵給自動參考一筆 GPS 觀測就寫一筆，**有效無效都寫**。`fix` 是被消費的值（權威副本）：`deviceBootId`、`measurementMonotonicUs`（可為 `null`）、`clockVerified`、`speedMps`、`horizontalAccuracyM`、`speedAccuracyMps`、`headingDeg`、`headingAccuracyDeg`（皆可為 `null`）。`gpsRef` 只供交叉核對，可為 `null`。`afterInputs` 是此刻自動參考已消費的各輸入最後序號，定義消費邊界。

**`auto_reference_reset`**：`{reason: session | boot | manual_command | epoch_reset | explicit, afterInputs}`。**每次實際 reset 都保存**，即使前後狀態相同。

**`auto_reference_state`**：`{state: enabled | suspended | disabled, reason, afterInputs}`。

1. **初始狀態必記**：每個 `lean_started` 與每個 `recording_resumed` 之後，在第一筆 `lean_hint` 之前必須有一筆（`AUTO_STATE_MISSING`）。
2. **所有有效的 `enabled`／`suspended`／`disabled` 轉換均保存**；唯一可省略的是可由版本化演算法與完整輸入重算的內部條件（`pendingAutomatic`、紀元起點後一秒、候選容量飽和、`delivered`）。`enabled` 是必要而非充分條件：`updateFix`／`add` 仍分別套用演算法的呼叫條件。
3. `suspended` ＝ 外部（使用者手動指令）暫停；`disabled` ＝ 條件不成立（現行校準存在、估算不可用、實驗輸入）。`suspended` 與 `disabled` 期間不得出現 `lean_hint`（`HINT_WHILE_NOT_ENABLED`）；現行校準存在期間不得出現 `lean_hint`（`HINT_WHILE_CALIBRATED`）。
4. **與 reset 的次序**（同一個 `afterInputs` 邊界內依檔案順序處理）：進入手動指令：先 `auto_reference_reset` 再 `suspended`（缺 reset → `AUTO_RESET_MISSING`）。離開 `suspended`：先 reset 再記**取消後的實際狀態**（缺 reset → `AUTO_RESUME_WITHOUT_RESET`）。`cancel` **只解除手動暫停**：若現行校準或估算不可用等條件仍成立，必須記 `disabled`，不得記 `enabled`（`AUTO_ENABLED_WHILE_BLOCKED`；驗證器只能檢查「現行校準」與「估算不可用」，`experimental` 輸入在檔案中沒有可核對的來源）。
5. `afterInputs` 每來源非遞減（`HINT_CURSOR_REGRESSION`）；配對模式下不得超過 motion 檔該來源的最大序號（`HINT_CURSOR_AHEAD`）。
6. `lean_calibration.evidence`（`auto_straight`）新增必填 `hintRange: {firstHintSequence, lastHintSequence}`：必須涵蓋自最近一次 `auto_reference_reset` 以來的全部 hint（`HINT_RANGE_INCOMPLETE`），且不得引用尚未寫出的 hint（`HINT_AFTER_CALIBRATION`）。
7. 宣告 `replayScope.calibration = true` 但缺初始狀態、轉換，或上述任何一項違規 → `CALIBRATION_REPLAY_STATE_INCOMPLETE`。

**驗證器無法偵測的缺口**：「某次 reset 被省略」（例如暫停中 upright→left 的第二次 reset 沒寫）在單一檔案內無法判定——它需要與一份完整的重播基準比對。這項由寫入端的 Kotlin 重播驗收負責，驗證器通過**不**代表 reset 完整。

## 9. 新增與變更的錯誤碼

warning：`UNSETTLED_SELECTION_WINDOW`。

error（新增）：`UNSUPPORTED_SCHEMA_VERSION`、`SCHEMA_VERSION_MIXED`、`STRIDE_POLICY_CONFLICT`、`POLICY_REDECLARED`、`SELECTION_WITHOUT_POLICY`、`SELECTION_ANCHOR_MISSING`、`ANCHOR_TIMEBASE_MISMATCH`、`SELECTION_BUCKET_VIOLATION`、`SELECTION_STATS_MISMATCH`、`ACCURACY_STATE_CHAIN`、`ACCURACY_CHANGE_UNRECORDED`、`CONTROL_SEQUENCE_GAP`、`CONTROL_SEQUENCE_REGRESSION`、`CONTROL_CURSOR_AHEAD`、`CONTROL_CURSOR_MISMATCH`、`SOURCE_REF_SPANS_SESSIONS`、`RUN_ID_MISMATCH`、`DERIVED_RUN_PARENT_MISMATCH`、`REPLAY_SCOPE_MISMATCH`、`REFILTER_SPEC_UNRESOLVABLE`、`EXPERIMENTAL_ESTIMATE_UNFLAGGED`、`EXTREMUM_IN_EXPERIMENTAL_RUN`、`QUALIFIED_WITHOUT_REF`、`QUALIFICATION_FINGERPRINT_MISMATCH`、`QUALIFIED_CONFIG_MISMATCH`、`ESTIMATE_CALIBRATION_TAINT_DROPPED`、`CARRIED_OVER_TAINT_DROPPED`、`AUTO_STATE_MISSING`、`AUTO_RESET_MISSING`、`AUTO_RESUME_WITHOUT_RESET`、`AUTO_ENABLED_WHILE_BLOCKED`、`HINT_WHILE_NOT_ENABLED`、`HINT_WHILE_CALIBRATED`、`HINT_CURSOR_REGRESSION`、`HINT_CURSOR_AHEAD`、`HINT_RANGE_INCOMPLETE`、`HINT_AFTER_CALIBRATION`、`CALIBRATION_REPLAY_STATE_INCOMPLETE`。其餘沿用 v1 §13。

## 10. 驗證與 fixtures

```bash
npm ci --prefix contracts/tools
npm test --prefix contracts/tools
node contracts/tools/validate-motion-lean.mjs <motion.ndjson>
node contracts/tools/validate-motion-lean.mjs [--motion <motion.ndjson>] [--parent <old.lean.ndjson>] <lean.ndjson>
```

exit code：`0` 通過、`1` 有 error、`2` 用法、`4` 不支援的 `schemaVersion`。（容量／IO 的 exit 3 與取消的 130 屬 C2 的有界引擎。）目前的驗證器是**記憶體內的參考實作**；C2 的外存引擎必須在小檔上重現相同結果。

fixtures 位於 `testdata/contracts/motion-lean/v2/`，**由 `contracts/tools/test/build-v2-fixtures.mjs` 產生**（`npm test` 會檢查已提交檔案與產生器輸出完全一致）：`motion|lean/{valid,invalid}/`（`.expected` 必須出現的錯誤碼、`.absent` 必須不出現的碼、`.warnings`）、`pairs/{valid,invalid}/<案例>/{motion,lean}.ndjson`、`runs/{valid,invalid}/<案例>/{parent,lean}.ndjson`（`--parent`）。v1 的回歸案例在 `testdata/contracts/motion-lean/v1/regression/`，每案的舊工具（`7474933`）結果由實跑記錄於 `old-tool.json`，測試會重跑該凍結工具核對。
