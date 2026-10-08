# 0003：motion／lean 可靠性修訂設計（schemaVersion 2）

日期：2026-10-08
狀態：**設計，未實作、未生效。** 本文件不改 `contracts/motion-lean/v1/` 任何檔案，也不是新 schema。待 Codex 復核手機端可實作性後，才進 C1／C2／C3 的實作 PR。
影響路徑：`contracts/motion-lean/`、`contracts/tools/`、`testdata/contracts/motion-lean/`（皆為契約擁有者路徑；本文件不要求任何人改 `device_bridge`、`apps/mobile`、`mobile_data`、`timing_core`）。
相關：0002（v1）、手機端提案 `packages/device_bridge/RECORDING_RELIABILITY_DESIGN.md`（D1）、`CONTRACT_FEASIBILITY_REVIEW.md`（F1，PR #11 `13b68a3`）。
第三版（Codex 最終復核，PR #11 `1e85c5f`）：消除 §B.5 錯誤碼文字、§D.1a 狀態事件的內部矛盾，並新增 §H C1 驗收條件。
契約基準：PR #10 `7474933`。本文件取代上一輪口頭回覆中的 revision 方案（見 §A）。
第二版（回應 F2，PR #11 `ffdb350`）：補 §A.3 相容影響、§B.5 policy／stride 單一解釋、§D.1a 自動參考控制狀態、§F 案例與回歸。其餘 A～E 已被 Codex 接受，未重開。

證據類型一律標註：`static validation`＝讀原始碼／schema；`untested`＝尚無實測。本文件**沒有任何**效能、精度、耗時實測。

## 0. 對 F1 的逐項處理

| 項目 | 結論 | 一句話理由 |
|---|---|---|
| A 版本 | **接受 Codex 建議**：motion／lean 新語義用 `schemaVersion: 2`；撤回 `revision` 方案 | 已知記錄 `additionalProperties:false`，舊工具必拒新欄位；稱「可加性」是錯的 |
| B1 session 邊界 | 接受 | 同 boot 的 UTC 校時不應重設桶或換策略 |
| B2 引用解析 | 接受 | 依 raw 樣本在 motion 檔的 session 解析；跨 session 引用拒絕 |
| B3 桶內 high→unreliable→high | **修訂**：承認端點檢查證明不了；改為「觀測計數對帳」＋寫入端合成測試，並把保證範圍寫明 | 驗證器無法證明未被觀測的事 |
| B4 控制事件 cursor | 接受，新增 `controlSequence` 與消費 cursor | 否則同一組 raw refs 可對應不同品質歷史 |
| B5 統計窗口 | 接受，重寫欄位 | 空窗口、未結算、成功追加計數都要明訂 |
| B6 未驗證時鐘的選樣 | 接受，新增 `timeBase` | 不用假 anchor |
| C 序號與 run | 接受，改為每串流 `lastSequences`、一檔一 run、每行帶 `leanRunId` | 避免單行脫離上下文 |
| C 濾波時間／IIR／四元數／係數 | 接受，`validAtMonotonicUs`、`filterStateEpoch`、半球規則、內嵌係數才可 refilter | 見 §C |
| C 容量 | **同意不鎖 20 Hz**；用夾具實測行長度算出：三串流 derived 在 50 Hz 不可能達標，提出聯合 frame 候選，待量測 | 見 §C.7 |
| C 父 run 驗證欄位 | 接受，`parentLastSequences` 允許 null | 損壞父檔不可判定 |
| D `lean_hint` | 接受，涵蓋 `AutoUprightReference` 全部輸入、重設、消費邊界；手動校準明列為記錄值 | 見 §D.1 |
| D 污染傳遞 | 接受，泛化為污染集合 | 舊格式只帶 `sensor_accuracy_unreliable` 的校準也要傳遞 |
| D 資格綁定 | 接受，改為內嵌完整配置＋驗證器重算指紋；區分「宣告」與「本機核驗」 | `kind+policyVersion` 不足 |
| E canonical 比較 | **接受，並承認上一輪我說「回讀位元組比較」是錯的**：現行 `canonicalJson`（`validate-motion-lean.mjs:214`）排序鍵 | 欄位順序不同不是 conflict |
| E CLI | 接受：`--tmp-dir` 可選、`--json` 預設完整串流；摘要為 opt-in | 不破壞現有呼叫者 |
| E watchdog／驗收 | 接受 | watchdog 中止＝失敗，不算達標 |

## A. 版本與相容

### A.1 決定

- motion／lean 的新語義使用 **`schemaVersion: 2`**。新增目錄 `contracts/motion-lean/v2/`（schema＋規範文字）。
- `v1/` 保持可讀。新工具同時驗證 v1 與 v2；**舊工具（PR #10 的 `7474933` 版）遇到 v2 一律拒絕**，這是預期而非缺陷。
- location-log **維持 v1，不變**。
- 一個實體檔固定一個 `schemaVersion`，**禁止混寫**：檔內任一行版本不同，錯誤 `SCHEMA_VERSION_MIXED`。
- 撤回上輪的 `revision` 欄位與「rev1／rev2」說法。

### A.2 兩個品質旗標屬於 v1 的歷史修正

`sensor_accuracy_unreliable`、`calibration_input_unverified` 在 v1 工具中改為已知且阻擋 extrema。這是 v1 的**有意變更**，同時寫入 v2。因 PR #10 尚未合併，不需遷移既有發行物；影響僅限測試機上已存在的私有檔，Codex 已在本機專項檢查通過（僅 pass／fail，不傳統計）。

### A.3 v1 有意變更完整清單（回歸測試必須逐項對應）

分成兩類，不混在一起：**檔案語義**（同一個檔案在新舊工具下判定可能不同）與**工具執行**（與檔案內容無關的執行結果）。

**甲、檔案語義（對 v1 檔）**

| # | 變更 | 對 v1 檔的影響 | 方向 |
|---|---|---|---|
| V1-1 | `sensor_accuracy_unreliable`、`calibration_input_unverified` 列為已知旗標 | 原本的 `UNKNOWN_QUALITY_FLAG` 警告消失 | 放寬（警告） |
| V1-2 | 兩旗標列為阻擋旗標 | 估算 `extremumEligible=true` 又帶任一旗標 → `EXTREMUM_ELIGIBLE_BLOCKED` error | 收緊 |
| V1-3 | 宣告改按 session 解析，取代 `Math.max(storageStride)`（`validate-motion-lean.mjs:391`） | 多 session 檔的 `REPLAY_STRIDE_DROPS_INPUTS`：**報告位置與是否報告都可能改變**（見 §F 回歸，需核對實際 error 與所屬 session，不預設舊工具漏報） | 雙向 |
| V1-4 | **污染傳遞**（§D.3），適用 v1 | 校準 `qualityFlags` 含 `sensor_accuracy_unreliable` 或 `calibration_input_unverified`，而使用它的估算**沒有**帶 `calibration_input_unverified` → `ESTIMATE_CALIBRATION_TAINT_DROPPED` error。**不限於 `extremumEligible=true`**：eligible=false 但漏傳旗標同樣違規 | 收緊 |
| V1-5 | `carried_over` 校準必須保留來源校準的污染旗標 | 丟失 → `CARRIED_OVER_TAINT_DROPPED` error（v1 保留 `carried_over` 為合法值，PR #11 runtime 不使用） | 收緊 |

- `sensor_accuracy_unknown` **只屬 v2**。v1 的污染集合只有上述兩旗標；v1 檔出現 `sensor_accuracy_unknown` 仍按舊規則為未知旗標（`UNKNOWN_QUALITY_FLAG` 警告），不回溯。
- V1-4／V1-5 是在 PR #10 尚未合併時對 v1 做的**歷史收緊**，不是新增欄位。已存在的 v1 檔若違反，結果是該檔「不符合修正後規則」，不會被改寫。
- Codex 先前的私有專項（估算自身兩旗標與 `extremumEligible`）**只覆蓋 V1-2**，不涵蓋 V1-4／V1-5。V1-4／V1-5 的正式結果要等 C2 驗證器存在後才能在本機檢查；在那之前這兩項對私有檔是 **untested**。

**乙、工具執行（與檔案語義無關，適用任何 schemaVersion）**

| # | 變更 | 說明 |
|---|---|---|
| X-1 | 新增 exit code 3（容量／IO／環境不支援／watchdog 中止）、130（取消） | v1 檔同樣可能遇到。執行**未完成**時輸出「未完成」並以 3／130 結束，**不得**報 PASS；已發現的 findings 仍輸出 |
| X-2 | 新增 exit code 4（`UNSUPPORTED_SCHEMA_VERSION`） | 只在遇到 >2 的版本；v1、v2 不會觸發 |
| X-3 | 0／1／2 的語義不變 | 完成驗證且無 error → 0；有 error → 1；用法錯誤 → 2 |
| X-4 | `--json`、文字輸出的既有結構不變 | 新增欄位只在使用新選用旗標時出現 |

舊版 A.3 的 V1-4（「新 exit 僅 v2 使用」）不成立，已刪除並改為本表 X-1～X-4。

上輪我寫「v1 新增 error 只有兩旗標」與 V1-3 互相矛盾，更正如上；本版再補 V1-4／V1-5。

### A.4 相容矩陣

| | v1 檔 | v2 檔 | 未知 `schemaVersion`（≥3） |
|---|---|---|---|
| PR #10 舊工具（`7474933`） | 照舊 | **拒絕**（`SCHEMA_INVALID`） | 拒絕（`SCHEMA_INVALID`） |
| 新工具（C2 以後） | 讀、驗證；含 V1-1～V1-5 | 讀、驗證 | **`UNSUPPORTED_SCHEMA_VERSION`，exit 4，不報 PASS** |
| v1 寫入端（目前 PR #11 runtime） | 寫 | 不寫 | — |
| v2 寫入端 | **不得續錄或追加**（封存） | 寫 | — |
| location-log 驗證器 | 不受影響；motion／lean 行屬未知 `recordType`，依 location-log §4 保留 | 同左 | 同左 |

最低工具版：v2 檔需要 C2 之後的 `contracts/tools`（版本號由 C2 PR 在 `package.json` 定）。未知未來版本**不得**套當前規則後回報完整通過。

### A.5 升級時的進行中記錄

v2 寫入端遇到 v1 的 motion／lean 檔：**不追加**。該 recording 的 motion／lean 就地封存（GPS 照常），使用者新開 recording 才使用 v2。降版（v1 寫入端遇 v2 檔）同理。不做「中途換版續錄」。此規則與 §C.3、§4 的封存機制相同，不另設路徑。

## B. 選樣、順序與統計

### B.1 session 與 policy

**session** ＝ 一個 `motion_started` 起，到下一個 `recording_resumed`，或下一個「改變 `deviceBootId` 的 `clock_adjusted`」為止。

- `clock_adjusted` 且 `previousDeviceBootId == deviceBootId`（純 UTC 校時）：**不是** session 邊界。只新增 `clock_map`；不重設選樣桶、不重設 `source_clock_state`、不許換 policy 或宣告。
- 改 boot 的 `clock_adjusted` 與 `recording_resumed`：session 邊界，後面必須有新的 `motion_started`。
- policy、`storageStride`、`gapThresholdUs`、`requestedSamplingPeriodUs` 等宣告**只在新 session 的 `motion_started` 生效**；同 session 內重複宣告不同值 → `POLICY_REDECLARED`。
- v1 以 `clock_adjusted` 為 segment 邊界、v2 收窄為上述定義，列入 v1→v2 差異（不回溯改 v1）。

### B.2 引用解析

索引為每筆樣本記錄 `sessionOrdinal`（以 motion 檔內 `motion_started` 的出現順序編號，由該樣本在 motion 檔的行位置決定；**不**比較 lean 行號與 motion 行號）。

- 估算的 `sourceRefs[]` 以 `firstSequence`、`lastSequence` 各查一次 `sessionOrdinal`；兩者不同 → `SOURCE_REF_SPANS_SESSIONS`（拒絕，不選其一）。session 邊界本來就強制 `estimator_reset`（v1 §9.4.2），所以合法檔不會出現。
- 宣告取該 `sessionOrdinal` 的宣告。

### B.3 控制事件的順序與 cursor

- 每個 `motion_event` 新增必填 `controlSequence`：整數，從 0 起、**全檔連續**（含跨 boot）、只在成功追加後遞增；與樣本 `sequence` 獨立。尾行截斷造成的缺號需 `log_truncated` 佐證（同 v1 §9.3）。
- 事件相對樣本的位置仍由 `lastSequences` 表達；重播順序＝檔案順序。
- **穩定消費規則（stored_only 路徑）**：`lean_estimate.motionControlCursor` ＝ 該估算**最新輸入樣本之前**、檔案中最後一個 `motion_event` 的 `controlSequence`；「之前」且「不含之後」。等式由驗證器強制（索引為每筆樣本存 `controlSeqBefore`，純量）：
  - 不等 → `CONTROL_CURSOR_MISMATCH`；超過檔內最大值 → `CONTROL_CURSOR_AHEAD`。
- `estimator_reset` 新增 `initialControlCursor`，語義同上，為新紀元起點。
- 控制事件**不得**被佇列重排或略過：寫入端的資料佇列與事件佇列必須共用同一個排序（手機端 F1 §2 第 1 項已同意）。保存不了轉換事件就停止 motion。
- **衍生輸入路徑**：濾波階段消費 motion 控制事件，記在 `lean_input.controlCursor`（見 §C.4）；估算階段只消費 lean 檔記錄，不再帶 `motionControlCursor`。

### B.4 準確度狀態與桶內轉換（修訂）

我上輪的 `ACCURACY_CHANGE_UNRECORDED` 只能檢查「相鄰保留樣本品質不同卻沒事件」，**無法證明沒有漏事件**——例如 high→unreliable→high 全發生在被略過的 callback，保留樣本兩端都是 high。本修訂把保證範圍講清楚，不假裝驗證器能證明：

1. **保證範圍**：寫入端 looper 觀測到的每一次準確度轉換（`onAccuracyChanged` 回呼，或樣本自帶的 `accuracyLevel` 變化，不論該樣本是否被選樣保留）都寫 `source_accuracy_state`。OS 沒回報的轉換**不在保證內**。
2. **狀態集合**：`unobserved`（session 開始時每來源的初始值）、`unavailable`（平台不提供，樣本帶 `accuracy_unavailable`）、`unreliable`、`low`、`medium`、`high`。第一次觀測會產生 `previous = unobserved` 的事件。
3. **去重**：兩種回呼來源共用同一個「現行值」，值未變不寫事件；兩者同時報同一值不重複。
4. **事件欄位**：`{sourceId, previousAccuracyState, accuracyState, atMeasurementMonotonicUs（回呼沒有則 null，不得套上一筆樣本的時間）, atReceivedMonotonicUs, reason: accuracy_callback | sample_observed, controlSequence}`。鏈式檢查：`previous` 必須等於現行值且與新值不同 → `ACCURACY_STATE_CHAIN`。
5. **對帳**：每個 `selection_stats` 帶 `observedAccuracyTransitions`，必須等於該窗口內該來源 `source_accuracy_state` 事件數 → `SELECTION_STATS_MISMATCH`。這只抓寫入端自己的帳不平，不證明沒漏觀測。
6. **端點檢查降級**：相鄰保留樣本 `accuracyLevel` 不同而其間沒有 `source_accuracy_state` → `ACCURACY_CHANGE_UNRECORDED`，保留為 error（必要條件）；文件明寫它不是充分條件。
7. **寫入端必須通過的合成測試**（Codex 路徑，列入 fixtures 預期供對齊）：callback 序列「high → unreliable → high」每一筆都落在被略過的位置，檔案中仍須有兩個 `source_accuracy_state`。
8. **消費端**：估算輸入的最差準確度排序為 `unreliable` < `unobserved` ＝ `unavailable` < `low` < `medium` < `high`，**未知（unobserved／unavailable）不會被 high 蓋掉**。新增已知且阻擋旗標 `sensor_accuracy_unknown`，輸入含 unobserved／unavailable 時必須帶。

### B.5 選樣宣告與統計

**宣告**（`motion_started.sources[]`）：

```json
"inputPolicy": {
  "kind": "time_bucket_first", "periodUs": 20000, "policyVersion": "tbf-1", "lossy": true,
  "verifiedAnchorRule": "first_verified_measurement",
  "unverifiedRule": "received_time_bucket"
}
```
- **v2 的 `inputPolicy` 與 `storageStride` 只有兩種合法組合**。其餘組合一律拒絕，錯誤碼依原因分兩種：`storageStride` 型別不屬於 `{1, null}`（例如 ≥2）→ `SCHEMA_INVALID`；型別合法但組合矛盾 → `STRIDE_POLICY_CONFLICT`。下表逐列標明：

| `inputPolicy` | `storageStride` | 結果 | 語義 |
|---|---|---|---|
| 缺省 | `1` | 合法 | 全存（非 lossy） |
| `kind = time_bucket_first`、`lossy = true` | `null` | 合法 | 時間桶選樣（lossy） |
| 缺省 | `≥ 2` | `SCHEMA_INVALID` | v2 不保留型號除數 |
| 缺省 | `null` | `STRIDE_POLICY_CONFLICT` | |
| 存在 | `1` | `STRIDE_POLICY_CONFLICT` | |
| 存在 | `≥ 2` | `SCHEMA_INVALID` | |

- v2 schema：`storageStride ∈ {1, null}`；`inputPolicy.kind` 只允許 `time_bucket_first`，`lossy` 必為 `true`；其他 kind 為 `SCHEMA_INVALID`（新增 kind 需契約 PR）。
- 整數 stride（>1）只存在於 v1，不為已決定移除的型號除數增加 v2 模式。
- 「非 lossy」的判定在 v2 只有一種：缺 policy 且 stride = 1（用於 §C.6 `refilter`）。
- `available: false` 的來源既無 policy 也無 stride（沿用現行 schema）。

**`selection_anchor`**（`motion_event`）：`{sourceId, policyVersion, timeBase: "measurement" | "received", anchorUs, reason: start | clock_epoch | gap | resume, controlSequence}`。
- 時鐘 `unverified`／`unavailable`：`timeBase = received`，以 `receivedMonotonicUs` 分桶限制診斷量；樣本 `measurementMonotonicUs` 維持 null，**不得**進估算。這是明確的第二分支，不用假的測量 anchor。
- `source_clock_state` 變更（驗證通過／失敗／域變更）→ 必須緊接 `selection_anchor(reason=clock_epoch)`，換 `timeBase`、清桶。
- 緩衝丟樣（`samples_dropped`）、resume → 重設 anchor。純 UTC 校時**不**重設。
- 驗證：`SELECTION_BUCKET_VIOLATION`＝同 anchor、同 `timeBase` 下連續兩筆保留樣本落同一桶（純量狀態即可）。

**`selection_stats`**（`motion_event`）：

| 欄位 | 語義 |
|---|---|
| `sourceId`、`policyVersion`、`windowIndex` | 每來源每 session 從 0 連號；窗口**不重疊** |
| `closeReason` | `periodic`｜`sync`｜`segment_end`｜`stop`｜`session_end`｜`recovered_unsettled` |
| `firstKeptSequence`、`lastKeptSequence` | 窗口內保留樣本的首尾序號；`keptCount = 0` 時**兩者必為 null**，不得發明序號 |
| `keptCount` | **只計成功追加**到檔案的樣本（writer 實際追加數；producer offer 成功不算） |
| `receivedCount` | looper 觀測到的回呼數 |
| `skippedIntentionalCount` | 選樣主動略過 |
| `invalidCount` | 值不合法（非有限值等）被拒 |
| `nonmonotonicCount` | 重複／逆序測量（同時有 `samples_dropped(measurement_nonmonotonic)`，見下） |
| `bufferDroppedCount` | 有界緩衝丟棄（應等於窗口內 `samples_dropped(buffer_full)` 數的總和） |
| `pendingIn`／`pendingOut` | 前一窗口結束時已接收但尚未完成追加的筆數（帶入下一窗口） |
| `observedAccuracyTransitions` | 見 B.4 |
| `complete` | 本窗口是否完整結算 |

- **對帳等式**僅在 `complete = true` 時由驗證器檢查：
  `receivedCount + pendingIn = keptCount + skippedIntentionalCount + invalidCount + nonmonotonicCount + bufferDroppedCount + pendingOut`
  `keptCount`、`firstKept`、`lastKept` 另由檔案實際內容核對（窗口起點取前一個 stats 之後該來源的樣本計數，純量計數器）。
- **崩潰未結算**：raw 已寫、stats 尚未寫就崩潰，該來源最後一個窗口在 EOF 前沒有 stats → 警告 `UNSETTLED_SELECTION_WINDOW`，**不把有效 raw 判為損壞**。續錄時寫入端先為該窗口補一筆 `closeReason = recovered_unsettled`、`complete = false`，`receivedCount`、`skipped…`、`pending…` 為 null，只剩可由檔案掃描得出的 `keptCount` 與首尾序號；等式不適用。
- **結算頻率與容量**：至少每 5 秒及每次邊界結算一次，不跟每次 500 ms sync；三來源約 0.15 KB/s（約 0.5 MB/h，以本文件 §C.7 的行長估計，未實測）。
- `samples_dropped.reason` 新增 `measurement_nonmonotonic`（重複／逆序測量；`droppedCount` 必須為已知數字），不得冒充主動略過。

## C. 衍生輸入與 run

### C.1 識別與序號（每串流）

lean v2 的所有串流都有 `sourceId` 與各自從 0 起的 `sequence`：

| `sourceId` | 內容 |
|---|---|
| `lean-estimator` | `lean_calibration`、`lean_estimate`、`lean_extremum`、`lean_segment_closed`（沿用 v1 的單一序號空間） |
| `derived-gyroscope`／`derived-accelerometer`／`derived-attitude` | `lean_input` |
| `lean-hint` | `lean_hint`（§D） |

- 事件不佔序號。`lean_event` 的 `lastSequence` 改為 **`lastSequences`**（`sourceId → 已寫出的最後序號`，之前為 `-1`），`log_truncated`／`recording_resumed` 的 `resumedSequence` 改為 **`resumedSequences`**（對齊 motion）。
- `estimator_reset.initialInputs[]` 的 `{sourceId, firstSequence}`：`sourceId` 在整個 recording 中唯一，所屬檔案由 `lean_started.inputSources[] = {sourceId, stream: "motion" | "lean_input"}` 宣告；`inputSourceIds` 保留為 `inputSources` 的 sourceId 清單。
- 引用規則：`sourceRefs[]` 以 `sourceId` 解析所屬串流。**禁止 forward ref**：被引用的 `lean_input` 必須已在檔案中先出現（`SOURCE_REF_FORWARD`）。**禁止跨 boot**（`SOURCE_REF_BOOT_MISMATCH`，既有）。**禁止跨 run**（§C.3）。
- 恢復與 epoch 的統一規則：任何 `recording_resumed`／`log_truncated` 都要為**每個串流**寫 `resumedSequences`；其後紀元重設為 `estimator_reset(recovery)`，其 `initialInputs` 對每個輸入串流指出新紀元第一筆。

### C.2 `lean_input`

| 欄位 | 語義 |
|---|---|
| `leanRunId`、`recordingId`、`sourceId`、`deviceBootId`、`sequence`、`schemaVersion: 2`、`recordType: "lean_input"` | 識別 |
| `sensorType`＋數值欄位 | 與 motion 同欄位名與單位；`attitude` 見 C.5 |
| `filterSpecId` | 必須指向**本檔先前**已出現的 `filter_spec`（`FILTER_SPEC_UNKNOWN`） |
| `filterStateEpoch` | 濾波器狀態紀元；reset／warm-up 重新開始時遞增 |
| `supportToMonotonicUs` | 此輸出所用最新原始回呼的測量時間（因果上界、「資訊到達」時間） |
| `supportFromMonotonicUs` | 只對 `memory: "finite"` 的濾波器有意義；`infinite`（IIR）為 null |
| `validAtMonotonicUs` | **訊號有效時間** ＝ `supportToMonotonicUs − groupDelayUs`（`groupDelayUs` 為 spec 的**設計宣稱**） |
| `consumedCallbackCount` | 區間內消費的全部回呼數，含未保存者 |
| `storedRawRefs[]` | `{sourceId, firstSequence, lastSequence}`，只列已落盤子集，可空陣列；**不得**暗示完整 |
| `worstAccuracyState` | B.4 排序下的最差值；任一輸入為未知則結果最高為未知 |
| `controlCursor` | 產生此輸出時濾波階段已消費到的 `motion_event.controlSequence` |
| `clockMapId`、`qualityFlags` | 同 v1；新增 `filter_warmup`（阻擋 extrema） |

**時間慣例（回應 F1「supportTo 不等於有效時刻」）**：

- 不同來源的濾波器有不同群延遲時，**一律用 `validAtMonotonicUs` 對齊**；`supportToMonotonicUs` 只表達「最早何時能知道」，供延遲診斷。
- 使用 derived 輸入的 `lean_estimate`：`measurementMonotonicUs` ＝ 其最新 ref 的 **`validAtMonotonicUs`**；新增 `informationMonotonicUs` ＝ 最新 ref 的 `supportToMonotonicUs`（≥ `measurementMonotonicUs`）。與 GPS 對齊用 `measurementMonotonicUs`。
- 這使 v1「估算測量時間＝最新輸入樣本測量時間」在 derived 路徑上改為「＝最新輸入的 validAt」；raw 路徑不變。`ESTIMATE_TIME_MISMATCH` 兩者分別檢查。
- `groupDelayUs` 是設計值，`filter_spec.delayVerified` 預設 `false`；延遲在合成頻寬掃描完成並寫入資格配置前，不得被當成已量測的 R1 L05 延遲。IIR 的群延遲隨頻率變化，spec 必須標明適用的通帶頻率；通帶外不保證。

### C.3 一檔一 run

- 一個 lean 檔只含一個 `leanRunId`。**每一行**都帶 `leanRunId`（`RUN_ID_MISMATCH`），故單行脫離檔案仍可辨識。
- 檔名含 `leanRunId`：`<recordingId>.lean.<leanRunId>.ndjson`（路徑為建議；不一致為警告 `RUN_ID_FILENAME_MISMATCH`）。**不用 manifest 檔**——它是可變狀態，與 append-only 原則衝突；探索靠目錄列舉與每個檔的 `derivesFrom`。
- 序號鍵：`(recordingId, leanRunId, sourceId, sequence)`；motion 檔不變。
- **禁止**跨 run 引用：校準、估算、`supersedesCalibrationId`、`carriedOverFromCalibrationId`、`filterSpecId`、`hint` 皆只在本 run 內解析。新 run 不繼承舊 run 的校準與最大值；需重新校準或重算。
- 新 run 必須是**另一個檔**，不得追加到舊 run 檔。`lean_started.derivesFrom`：

```json
"derivesFrom": null | {
  "leanRunId": "…", "reason": "recompute" | "recovery_after_corruption" | "algorithm_upgrade",
  "parentByteLength": 123456, "parentPrefixSha256": "…",
  "parentLastSequences": {"lean-estimator": 4210, "derived-gyroscope": null},
  "parentValidation": {"status": "failed" | "passed" | "not_run", "errorCodes": ["…"]},
  "coverage": {"fromMonotonicUs": 0, "toMonotonicUs": 0, "complete": false}
}
```
- `parentByteLength`／`parentPrefixSha256` 指封存父檔的一段**不可變位元組前綴**（從檔首起）；**不得**藉排除損壞行讓失敗的父檔看似通過——`parentValidation` 描述的就是這段前綴整體。
- `parentLastSequences` 的值在損壞或不可判定時為 `null`（每串流獨立），不編造。
- `coverage` 表示新 run 涵蓋的時段與是否完整；**部分重算（`complete=false`）不得被消費端當成全行程結果**。「最新驗證通過 run」的選擇規則：只在 `coverage.complete` 為真、或該 run 為原始（`derivesFrom=null`）且驗證通過時才可作為整段結果；否則只能標示為「部分」。
- 驗證 `--parent <old.lean>`：核對前綴雜湊與長度（`DERIVED_RUN_PARENT_MISMATCH`）。未提供 `--parent` 時，結果標記 `crossFileChecks.parent: "not_run"`，不假裝已驗。
- 父檔雜湊在手機端以背景串流計算（F1 已確認可行、耗時未量測）；雜湊完成前**不宣告新 run 已建立**，GPS 不等待。這屬寫入端行為，契約只規定「新 run 的 `lean_started` 在 `derivesFrom` 完整後才寫」。

### C.4 濾波器：spec、warm-up、IIR 歷史

`lean_event.filter_spec`：

```json
{"filterSpecId":"…","kind":"fir_linear_phase|iir_biquad_cascade|quaternion_nlerp_fir",
 "memory":"finite|infinite","version":"…","outputPeriodUs":20000,
 "passbandHz":[0,8],"stopbandHz":25,"designStopbandAttenuationDb":40,
 "groupDelayUs":0,"delayVerified":false,"warmupUs":0,
 "coefficients":{"inline":[…]}  ,   // 或 {"sha256":"…"}（只能辨識，不能重算）
 "initialState":"zero"|"first_input"}
```
- `designStopbandAttenuationDb`、`groupDelayUs` 都是**設計宣稱**，不是實測；與 `uncertaintyUs` 同性質。
- 係數內嵌上限 256 項（IIR 以 biquad 區段列表，同上限計）。超限或只給雜湊 → 該 spec 為 **不可解析**。
- **IIR 的無限歷史**：不以短 `supportFromMonotonicUs` 假裝完整；以 `filterStateEpoch` ＋ `filter_reset` 事件（`{filterStateEpoch, reason, sourceId, initialState}`）表達。輸出自 reset 起算，未滿 `warmupUs` 的輸出帶 `filter_warmup`（`FILTER_WARMUP_UNFLAGGED`）。缺口或任何輸入不連續必須 `filter_reset` 並同時 `estimator_reset`。
- 缺口兩邊不得接續濾波器內部狀態（`FILTER_STATE_ACROSS_GAP`，在配對模式查 motion 的 breaks）。

### C.5 四元數（`derived-attitude`）

- `kind` 必須是 `quaternion_*`；對 `attitude` 套用純量 `fir_*`／`iir_*` → `FILTER_KIND_SENSOR_MISMATCH`。不得逐分量套純量濾波後宣稱姿態有效。
- 規則：與前一輸出同半球（`dot ≥ 0`，必要時整體取負）後加權、再正規化；輸出長度須為 1（容差 `1e-3`，既有 `QUATERNION_NOT_UNIT`）。
- `q` 與 `−q` 為同一旋轉，不是錯誤；同一 `filterStateEpoch` 內相鄰輸出 `dot < 0` 為警告 `QUATERNION_HEMISPHERE_JUMP`。

### C.6 可重播與 refilter 的條件（C 部分）

- `refilter = true` 必須同時滿足：(1) 所用 `filter_spec` 可解析（係數內嵌、`initialState` 已宣告、版本固定）；(2) raw 來源 `inputPolicy` 非 lossy 且自該 `filter_reset` 起無 `samples_dropped`；(3) 該來源每個 `lean_input` 的 `consumedCallbackCount` 等於 `storedRawRefs` 的實際筆數合計。違反：`REFILTER_SPEC_UNRESOLVABLE`／`REFILTER_ON_LOSSY_RAW`／`REFILTER_RAW_INCOMPLETE`。離線拿不到係數就只能 false。
- 係數只有雜湊 → refilter 恆為 false，但 `estimate` 重播不受影響（輸入已存）。

### C.7 容量（回應 F1「不採 300 B 假設」）

方法：以 PR #10 fixtures 的**實際 NDJSON 行長度**（`static validation`，非真機）：`motion_sample` 約 383–389 B，`lean_estimate` 約 454–494 B（測試用的短 ID；真實 UUID 的 `recordingId` 與 boot id 會更長，此表偏低）。`lean_input` 尚無 schema，**以 `motion_sample` 加 `filterSpecId`／`filterStateEpoch`／`supportTo`／`validAt`／`controlCursor`／refs 估約 520 B（草稿，未實測）**；聯合 frame 草稿約 450 B。以下為算術結果，**不是量測**，未含事件、stats、診斷。

| raw（×3，Hz） | derived（Hz） | raw MB/h | derived 三串流 | derived 聯合 frame | 估算 20 Hz | 合計（三串流） | 合計（聯合 frame） |
|---|---|---|---|---|---|---|---|
| 50 | — | 208 | — | — | 33 | 241 | 241 |
| 10 | — | 42 | — | — | 33 | 75 | 75 |
| 50 | 20 | 208 | 112 | 32 | 33 | **353** | 273 |
| 10 | 50 | 42 | 281 | 81 | 33 | **356** | 156 |
| 10 | 20 | 42 | 112 | 32 | 33 | 187 | 107 |
| 50 | 50 | 208 | 281 | 81 | 33 | **522** | **322** |

結論（算術上成立）：
1. 三條獨立 `lean_input` 串流在 derived 50 Hz 時，不論 raw 取 10 或 50 Hz，都超過 R1 的 300 MB/h。
2. 若 derived 必須維持約 50 Hz（F1 的要求），可行方向只有：聯合 frame、縮短欄位格式（變更欄位名＝新的格式版本）、或提高 R1 預算（R2，需使用者決定）。**不壓縮欄位語義。**
3. 聯合 frame 候選（一筆含 gyro＋accel＋attitude，各成員帶自己的 `validAt` 與 `ageUs`）需要在濾波階段把三個來源放到共同時間格，這是新的重取樣語義，**本文件不定案**，僅保留為 S5 比較項。
4. 在 S5 的合成頻寬／延遲掃描之前，輸出率與格式都不鎖；序列化後的實測容量（含真實 ID）才是定案依據。

### C.8 raw 完整損壞的處理（本階段定案，不另開 C4）

raw 檔出現完整損壞行（`NOT_JSON`、重複／衝突序號、身分異常）：**封存 raw，不再追加；該 recording 的 motion 停止，GPS 繼續**。同一 recording 不續寫新的 raw 檔。F1 §5 已同意這點。

## D. 重播、校準與資格

### D.1 `lean_hint`（涵蓋 `AutoUprightReference` 實際使用的所有值）

依 `AutoUprightReference.kt` 的 `updateFix(Fix)` 與 `add(...)`（`static validation`，讀原始碼；Codex 擁有此檔，本文件不改）：

`updateFix` 的輸入：`boot`、`measuredUs`（可 null）、`clockVerified`、`speedMps`、`horizontalAccuracyM`、`speedAccuracyMps`、`headingDeg`、`headingAccuracyDeg`（皆可 null）；**任何一項無效都會清空候選窗口**。`add` 的輸入：`time`、`up`（由姿態推得的向上向量）、`gyroNorm`、`accelerationNorm`；`reset()` 清空全部候選。

因此 `recordType: "lean_hint"`（`sourceId: "lean-hint"`，自己的序號）每次 `updateFix` 呼叫寫**一筆，不論有效或無效**：

```json
{"hintKind":"gps_fix",
 "fix":{"deviceBootId":"…","measurementMonotonicUs":null,"clockVerified":false,
        "speedMps":null,"horizontalAccuracyM":null,"speedAccuracyMps":null,
        "headingDeg":null,"headingAccuracyDeg":null},
 "gpsRef":{"sourceId":"…","sequence":0} | null,
 "afterInputs":[{"sourceId":"android-accelerometer","sequence":1234},…]}
```
- `fix` 是**實際被消費的值**（權威副本）；`gpsRef` 只供交叉核對，可為 null。location-log v1 不變。
- `afterInputs`：此 hint 被消費時，自動參考已消費的各輸入來源最後序號（motion 或 `lean_input`），定義 hint 與輸入的**消費邊界**；每來源非遞減、不超過檔內已存在最大值（`HINT_CURSOR_AHEAD`／`HINT_CURSOR_REGRESSION`）。derived 路徑下檔案順序本身即消費順序，`afterInputs` 仍必填以一致。
- 新增 `lean_event.auto_reference_reset`：`{reason: session | boot | explicit | epoch_reset, afterInputs[]}`，對應 `reset()`；`saturated`／`delivered` 屬演算法決定性狀態，由輸入重現，不另存。
- 演算法參數（3 秒窗、30 秒門檻、速度／精度上限等）屬 `algorithmVersion`；`lean_started.autoReferenceConfigFingerprint`（SHA-256）綁定參數內容，並列入資格配置（D.3）。
- `lean_calibration.evidence`（`auto_straight`）新增 `hintRange: {firstHintSequence, lastHintSequence}`：必須涵蓋**自最近一次 `auto_reference_reset` 以來**的全部 hint，序號連續（`HINT_RANGE_INCOMPLETE`）；校準行不得早於其所列 hint（`HINT_AFTER_CALIBRATION`）。
- **`--location <log>`**（選用）：核對 `gpsRef` 所指樣本的 `deviceBootId`、測量時間、速度、精度與 `fix` 一致，不一致 `HINT_GPS_MISMATCH`。未提供時輸出 `crossFileChecks.location: "not_run"`，hint 視為「未與 GPS 交叉驗證」，**不報告為已驗證**。

### D.1a 自動參考的控制狀態（啟用／暫停）

來源：`LeanPipeline.kt`（`static validation`，Codex 路徑，只讀）。`rideFix` 只有在 `available`、非 `experimental`、無 mount、無現行 `calibrationId`、且 `command == "idle"` 時才呼叫 `updateFix`；`automatic.add` 另受 `pendingAutomatic` 及紀元起點後一秒的條件限制；`control(upright|left)` 會 `reset` 並進入手動收集，`cancel` 也 `reset` 但回到 `idle`。因此只保存 hint 與 reset，**不足以判斷之後是否該呼叫 `add`**；尚未完成的手動動作也沒有 `lean_calibration` 行可供推知。

新增 `lean_event.auto_reference_state`（`sourceId` 不佔序號，同其他事件）：

```json
{"eventType":"auto_reference_state","state":"enabled|suspended|disabled",
 "reason":"initial|recovery|manual_command_started|manual_command_cancelled|manual_calibration_activated|calibration_present|calibration_cleared|estimator_unavailable|estimator_available|experimental_input|experimental_cleared|session_stop",
 "afterInputs":[{"sourceId":"…","sequence":0}]}
```

規則：
1. **初始狀態必記**：每個 `lean_started` 之後、每個 `recording_resumed` 之後，在第一筆 `lean_hint` 之前，必須有一筆 `auto_reference_state`（`reason = initial` 或 `recovery`）。缺 → `AUTO_STATE_MISSING`。
2. **所有有效的 `enabled`／`suspended`／`disabled` 轉換均保存**（不得省略、不得因去重丟掉），每筆帶 `afterInputs`（與 `lean_hint.afterInputs` 同語義：此刻自動參考已消費的各輸入最後序號；每來源非遞減、不超過檔內已存在最大值）。
3. **語義**：`enabled` 是**必要而非充分**條件：`updateFix` 與 `add` 仍分別套用版本化演算法的呼叫條件（`add` 另受 `pendingAutomatic`、紀元起點後一秒等限制）。`enabled` ＝ 允許呼叫；`suspended` ＝ 外部（使用者手動指令）暫停；`disabled` ＝ 因條件不成立而停用（現行校準存在、估算不可用、實驗輸入）。`suspended` 與 `disabled` 期間**不得**出現 `lean_hint`（`HINT_WHILE_NOT_ENABLED`），也不累積候選。
4. **與 reset 的次序**（同一個 `afterInputs` 邊界內，依 lean 檔出現順序處理）：
   - 進入 `suspended`（手動指令開始）：先 `auto_reference_reset`，再 `auto_reference_state(suspended, manual_command_started)`。
   - 手動指令取消：先 `auto_reference_reset`，再記**取消後的實際狀態**。`cancel` **只解除手動暫停**，不能抹掉其他阻擋條件：若現行校準、mount、估算不可用或 experimental 仍成立，必須記 `auto_reference_state(disabled, <對應原因>)`，**不得無條件寫 `enabled`**；只有所有阻擋條件都已解除才記 `enabled, manual_command_cancelled`。缺少 reset 就恢復 `enabled` → `AUTO_RESUME_WITHOUT_RESET`；取消後仍受阻卻記 `enabled` → `AUTO_ENABLED_WHILE_BLOCKED`。
   - **每次實際 reset 都保存**，即使前後狀態相同（例如 upright→left，`suspended`→`suspended`）；`auto_reference_reset` 不受狀態去重影響。
   - **初始狀態須在首次候選處理或第一筆 hint 之前存在**（規則 1）。
   - 恢復邊界之後的輸入才開始重新累積；暫停期間的輸入不屬於候選。
5. **可由版本化演算法與完整輸入重算的**內部條件不重複保存：`pendingAutomatic`、紀元起點後一秒、候選容量飽和、`delivered` 等。**這是唯一可省略的類別**；有效的狀態轉換（規則 2）一律保存，包含 `available`、現行校準、實驗輸入造成的 `disabled`／`enabled` 轉換。驗證器另單檔檢查「現行校準存在期間出現 hint」→ `HINT_WHILE_CALIBRATED`。若寫入端無法判定某個外部條件，`replayScope.calibration` 必須為 false。
6. **不擴張範圍**：手動校準結果仍是記錄輸入，不要求保存整套手動證據，也不重算手動校準（§D.2）。
7. 缺初始狀態、轉換或 reset 卻宣告 `replayScope.calibration = true` → `CALIBRATION_REPLAY_STATE_INCOMPLETE`。

### D.2 `replayScope.calibration` 的範圍（誠實界線）

- `calibration = true` 的意思：**自動校準的決策**可由已存 hint、已存輸入、`autoReferenceConfigFingerprint`、**自動參考控制狀態事件（§D.1a）** 重現，包含無效 hint、重設與暫停區間。
- **手動校準不是從證據重算**：它是人為動作的記錄值（向量、`sourceRange`、`leftLeanConfirmation`），視為已記錄的輸入。契約**不宣稱**可由 motion 證據重算手動校準。任何要求把手動指令視窗保存成可重算證據的需求，另案（現不在 v2）。
- 未寫入 `lean_hint`、初始狀態或轉換事件前（目前 Codex 的實驗模式已停用自動參考），`calibration` 恆為 false。三種 `replayScope` 在各自資料與 Kotlin 決定性測試完成前均維持 false。

### D.3 污染傳遞

定義**污染集合** `T = {sensor_accuracy_unreliable, calibration_input_unverified, sensor_accuracy_unknown}`。

- 校準的 `qualityFlags` 與 `T` 有交集 → 所有使用該校準的 `lean_estimate` 必須帶 `calibration_input_unverified`，且 `extremumEligible=false`。漏帶旗標即 `ESTIMATE_CALIBRATION_TAINT_DROPPED`，**與該估算是否 eligible 無關**（eligible=false 但漏傳旗標同樣違規）。**舊格式只帶 `sensor_accuracy_unreliable` 的校準也適用**，這正是 F1 指出的漏洞。
- 來源準確度恢復 high **不洗白**舊校準：估算自己的輸入旗標乾淨，仍要帶傳遞而來的旗標。只有**新的**校準（新 `calibrationId`、乾淨旗標、完整 evidence）才能解除。
- `carried_over` 校準必須包含來源校準旗標 ∩ `T`（`CARRIED_OVER_TAINT_DROPPED`）。
- 這條規則是單檔規則，不需要配對。v1 檔同樣適用，列為 A.3 的 V1-4／V1-5（不是 V1-2 的延伸，影響範圍包含 eligible=false 的估算）。`sensor_accuracy_unknown` 只屬 v2 的污染集合；v1 的污染集合只有前兩個旗標。

### D.4 資格（修訂）

`lean_started.qualification`：

```json
{"status":"experimental"|"qualified",
 "qualificationRef": null | "<本機證據 UUID>",
 "qualifiedConfiguration": { … },
 "configurationFingerprint": "<sha256>"}
```
- `qualifiedConfiguration` 是**完整配置**物件，內含：`algorithmVersion`、`extremumPolicy`、`autoReferenceConfigFingerprint`、每個輸入來源的完整 `inputPolicy` 與（若有）`filter_spec` 內容或其指紋、估算輸出週期、`applicability: {platform, sensorProfileId, mountProfileId}`（皆為不含個資的不透明 ID，語義由本機證據定義）。
- 驗證器**重算**配置指紋（canonical JSON → SHA-256）並比對 `configurationFingerprint`（`QUALIFICATION_FINGERPRINT_MISMATCH`），再把配置與**檔案實際宣告**（motion／lean 的 `inputPolicy`、`filter_spec`、`algorithmVersion`、`extremumPolicy`）逐項比對（`QUALIFIED_CONFIG_MISMATCH`）。`kind＋policyVersion` 相同但 period／spec／來源不同，會在此被抓到。
- `status = qualified` 必須有非 null `qualificationRef`（`QUALIFIED_WITHOUT_REF`）。`experimental` 時每個估算帶 `algorithm_unqualified` 且 `extremumEligible=false`、不得有 `lean_extremum`（`EXTREMUM_IN_EXPERIMENTAL_RUN`）。
- **`qualificationRef` 存在不是精度證明。** 檔案中的 `qualified` 只是**寫入端的宣告**；驗證器預設輸出 `qualificationStatus: "declared_unverified"`。提供 `--qualification-registry <本機私有 JSON>`（ref → 配置指紋）且指紋相符，才輸出 `locally_verified`；仍不輸出任何準確度數字，文字固定為「資格紀錄相符，不是精度宣稱」。
- 消費端／UI：只有 `locally_verified` 才可作正式最大值；`declared_unverified` 與 `experimental` 一律受限實驗顯示。規格沿用工程規則 §2.8。
- 目前 R1 L03～L05 無參考設備，**任何 run 都不可能合法取得本機核驗的 qualified**，這是預期。

## E. 驗證器（C2）

### E.1 比較語義（更正）

- duplicate／conflict 使用 **canonical JSON 比較**（鍵排序，與現行 `canonicalJson` 一致）。同值不同欄位順序＝`SEQUENCE_DUPLICATE`，不是 `SEQUENCE_CONFLICT`；位元組比較只能當快速路徑。
- 索引存 `SHA-256(canonicalJson)`（完整 32 位元組）＋offset。雜湊**不同**＝canonical 必不同＝conflict（雜湊是確定函數，無需回讀）；雜湊**相同**＝回讀該行、重新 canonical 後比對，通過才算 duplicate，因此雜湊碰撞不影響正確性。
- 鍵含 `leanRunId` 與 `sourceId`：`(recordingId, leanRunId | null, sourceId, sequence)`。

### E.2 引擎與資源

- 索引：`better-sqlite3`，exact 版本寫入 `package-lock.json`，版本號與預編譯二進位可用性由 C2 PR 以煙霧測試決定（本機 Node 22.23.2 的 `node:sqlite` 仍印 `ExperimentalWarning`，不採用）；僅支援 Node 22 系列，啟動自檢不符 → exit 3。**尚未選定版本、尚未實測。**
- 小檔與大檔走**同一份程式**；`:memory:`／磁碟只是索引後端。以輸入總位元組數決定，初始門檻 16 MiB；索引膨脹需量測（見 E.5）。測試以隱藏旗標強制兩種後端，讓 PR 快速工作也跑到磁碟程式路徑。
- 凡基數由輸入控制的集合都進索引：序號、session 宣告、`clock_map`、紀元、校準、估算、最大值、結案分段、breaks、連續區段、`controlSeqBefore`、`lean_hint`、filter spec。記憶體只留現行狀態純量＋固定 page cache。

### E.3 CLI 相容與遷移

| 項目 | 決定 |
|---|---|
| `--tmp-dir` | **選用**。預設在 `os.tmpdir()` 下 `mkdtemp`（0700），可顯式覆寫為私有目錄；不強制，不破壞現有 CI 與使用者命令 |
| 文字輸出 | 逐筆串流輸出全部 findings，行為與現行相同；記憶體有界。`--max-print N` 為選用 |
| `--json` | **預設仍為完整輸出**，改為串流寫出（不累積陣列）；結構與現行相同。不截斷 |
| 新選用旗標 | `--summary`（計數＋前 N 筆，並指出 findings 檔）、`--findings-out <path>`（JSONL，完整）、`--index memory\|disk`（測試用）、`--parent`、`--location`、`--qualification-registry` |
| 完整 findings | 只要有 findings，且沒有 `--findings-out` 時，完整內容仍輸出到 stdout；因此不存在「第 101 筆之後無處可查」的情況。`--summary` 必須搭配 `--findings-out` 或明確警告 |
| exit code | 0 通過；1 有 error；2 用法；**3 容量／IO／環境不支援／watchdog 中止**；**4 不支援的 schemaVersion**；130 取消 |

### E.4 暫存、失敗與取消

- 暫存目錄內放標記檔（pid、啟動時間、主機名、uid）。SIGINT／SIGTERM 清理；**SIGKILL 無法保證清理**。下次啟動只清理能確認屬自己（同 uid、標記檔存在、pid 已不存在、逾 1 小時）的過期目錄，且只限所選暫存父目錄下。
- `ENOSPC`（含 SQLite `SQLITE_FULL`）、findings 檔 IO 失敗、無權限、取消 → 精確分類，exit 3（取消為 130）；**保留輸入與已指定的 findings 檔**；清理失敗在 stderr 報告路徑，不覆蓋原結果。
- 啟動預檢可用空間（初始估計需要 `max(512 MiB, 1.0 × 輸入總大小)`，C2 實測後收緊）；執行中每 64 MiB 輸入以 `fs.statfsSync` 再檢，保留 128 MiB 底線。預檢不是保證，仍須處理執行中 `ENOSPC`。

### E.5 驗收（S3 完成條件）

- 差異測試：PR #10 的 `7474933` 驗證器保留為測試用 oracle，對 v1 fixtures 與隨機變異比對錯誤碼與行號，逐項標示 A.3 的有意變更。
- 2 GiB 合成輸入由 `contracts/tools/gen-synthetic-large.mjs`（固定種子、串流寫出）產生，**必須完整跑完**：合法、尾行損壞、長距離重複（同值不同鍵序）／衝突、跨 session 策略變更、dangling refs、反覆校時、極多 findings。
- **watchdog 中止（RSS 超限）= 驗收失敗，不算通過 256 MiB 目標。** watchdog 只是安全網（初始設 240 MiB），驗收要求完整跑完且峰值 RSS ≤ 256 MiB（以 `/usr/bin/time -v` 量測）。耗時與暫存占用同時記錄；**耗時目前沒有目標值**。
- 跨多檔（motion＋lean＋location＋parent）的總量與整個行程 RSS 才是預算；`:memory:` 後端的索引膨脹也要量。
- **S3 宣告完成之前**必須實際在本機或 `workflow_dispatch`／nightly 跑完上述大檔案例並貼上結果摘要；PR 快速工作只跑小檔差異測試與磁碟路徑。現階段 **untested**。

## F. Fixtures 預期（C1／C2／C3 實作時建立；現在只列清單）

位置：`testdata/contracts/motion-lean/v2/{motion,lean,pairs}/{valid,invalid}/`，沿用 v1 的 `.expected`／`.warnings` 慣例。v1 目錄不動；V1-1～V1-3 的回歸案例放 `v1/` 並標明新舊工具差異。

### 合法（valid，零 error）

| 編號 | 案例 |
|---|---|
| V-01a | 最小 v2：缺 policy＋`storageStride=1`（全存） |
| V-01b | 最小 v2：`time_bucket_first`＋`lossy=true`＋`storageStride=null` |
| V-02 | 初始 `unobserved` → 首次觀測事件；`unavailable` 來源 |
| V-03 | 桶內 high→unreliable→high 全在略過位置，兩個 `source_accuracy_state` 存在 |
| V-04 | 純 UTC `clock_adjusted`（同 boot）：只新增 `clock_map`，policy／anchor 不變 |
| V-05 | 時鐘 unverified：`selection_anchor(timeBase=received)`；驗證通過後 `clock_epoch` 換 `measurement` |
| V-06 | 多 session：session A 全存、session B `time_bucket_first`；引用各自解析 |
| V-07 | `selection_stats`：空窗口（`keptCount=0`、首尾 null）；`complete=true` 對帳平衡；`pendingIn`／`pendingOut` 帶入 |
| V-08 | 崩潰未結算窗口（EOF 無 stats → 警告）；續錄後 `recovered_unsettled`、`complete=false` |
| V-09 | `controlSequence` 連續；估算 `motionControlCursor` 等於其最新輸入之前的事件 |
| V-10 | derived 路徑：`filter_spec`→`lean_input`→`lean_estimate`；`validAt`＝`supportTo−groupDelay`；estimate 的 `measurementMonotonicUs`＝validAt |
| V-11 | IIR：`filter_reset`、warm-up 輸出帶 `filter_warmup`；缺口前後 `filterStateEpoch` 不同 |
| V-12 | 四元數 `quaternion_nlerp_fir`，q／−q 相鄰輸出僅警告 |
| V-13 | 每串流 `lastSequences`／`resumedSequences`；截斷後 `estimator_reset(recovery)` 對每個輸入串流有 `initialInputs` |
| V-14 | 新 run：`derivesFrom` 完整、`parentPrefixSha256` 相符、`--parent` 通過；`parentLastSequences` 含 null；`coverage.complete=false` |
| V-15 | 污染傳遞：舊格式只帶 `sensor_accuracy_unreliable` 的校準，估算帶 `calibration_input_unverified` 且 `extremumEligible=false`；新校準解除 |
| V-16 | `lean_hint`：有效與無效（全 null）hint、`auto_reference_reset`、`hintRange` 完整；`--location` 一致 |
| V-17 | 資格：`experimental`＋`algorithm_unqualified`；`qualified`＋配置指紋重算相符（輸出仍為 `declared_unverified`） |
| V-16a | 自動參考狀態：路徑一——`initial=enabled`，無任何手動指令，連續 hint 累積 |
| V-16b | 路徑二（相同 motion、相同 GPS）——中途 `reset`→`suspended(manual_command_started)`，尚未完成即 `reset`→`enabled(manual_command_cancelled)`；暫停區間沒有 hint，恢復邊界之後才重新累積，候選數與路徑一不同 |
| V-16d | 取消手動指令時校準仍存在：reset→`disabled`（不是 `enabled`），之後 `calibration_invalidated` 才 reset→`enabled` |
| V-16e | 暫停中連續兩次 reset（upright→left）：兩筆 `auto_reference_reset` 都保存，狀態維持 `suspended` |
| V-16f | 同一 `afterInputs` 邊界內 hint／reset／state 多筆，依檔案順序處理，結果與逐筆重播一致 |
| V-16c | 校準存在期間 `disabled(calibration_present)`；`calibration_invalidated` 後 `enabled(calibration_cleared)`（先 reset） |
| V-18 | v1 檔與 v2 檔各自通過；location-log 零 sample、零 event 測試延續到 v2 檔 |

### 非法（invalid，`.expected` 列出必須出現的碼）

| 編號 | 案例 | 預期碼 |
|---|---|---|
| I-01 | 同檔 `schemaVersion` 1 與 2 混寫 | `SCHEMA_VERSION_MIXED` |
| I-02 | `schemaVersion: 3` | `UNSUPPORTED_SCHEMA_VERSION`（exit 4，非 PASS） |
| I-03 | v1 估算帶兩旗標又 `extremumEligible=true` | `EXTREMUM_ELIGIBLE_BLOCKED` |
| I-04 | 同 session 內改 `inputPolicy` | `POLICY_REDECLARED` |
| I-05a | 缺 policy＋`storageStride=2` | `SCHEMA_INVALID`（v2 stride 只允許 1／null） |
| I-05b | 缺 policy＋`storageStride=null` | `STRIDE_POLICY_CONFLICT` |
| I-05c | `time_bucket_first`＋`storageStride=1` | `STRIDE_POLICY_CONFLICT` |
| I-05d | `time_bucket_first`＋`storageStride=2` | `SCHEMA_INVALID` |
| I-05e | `time_bucket_first`＋`lossy=false`，或未知 `kind` | `SCHEMA_INVALID` |
| I-06 | 同桶兩筆保留樣本 | `SELECTION_BUCKET_VIOLATION` |
| I-07 | 相鄰保留樣本 accuracy 不同且無事件 | `ACCURACY_CHANGE_UNRECORDED` |
| I-08 | `previous` 與現行準確度狀態不符 | `ACCURACY_STATE_CHAIN` |
| I-09 | `selection_stats` 等式不平（`complete=true`） | `SELECTION_STATS_MISMATCH` |
| I-10 | `keptCount=0` 卻有首尾序號 | `SCHEMA_INVALID` |
| I-11 | `controlSequence` 不連續（無截斷佐證） | `CONTROL_SEQUENCE_GAP` |
| I-12 | 估算 cursor 少於其輸入之前的事件／大於檔內最大值 | `CONTROL_CURSOR_MISMATCH`／`CONTROL_CURSOR_AHEAD` |
| I-13 | 引用跨 session | `SOURCE_REF_SPANS_SESSIONS` |
| I-14 | 引用尚未出現的 `lean_input`（forward） | `SOURCE_REF_FORWARD` |
| I-15 | 檔內不同 `leanRunId` | `RUN_ID_MISMATCH` |
| I-16 | 跨 run 引用校準或 spec | `CALIBRATION_UNKNOWN`／`FILTER_SPEC_UNKNOWN` |
| I-17 | `lean_input` 引用不存在 `filterSpecId` | `FILTER_SPEC_UNKNOWN` |
| I-18 | 純量濾波套用到 `attitude` | `FILTER_KIND_SENSOR_MISMATCH` |
| I-19 | warm-up 輸出缺 `filter_warmup` | `FILTER_WARMUP_UNFLAGGED` |
| I-20 | 缺口兩邊不重設濾波狀態 | `FILTER_STATE_ACROSS_GAP` |
| I-21 | `refilter=true` 但係數只有雜湊／raw 為 lossy／筆數對不上 | `REFILTER_SPEC_UNRESOLVABLE`／`REFILTER_ON_LOSSY_RAW`／`REFILTER_RAW_INCOMPLETE` |
| I-22a | 校準帶污染旗標，估算 `extremumEligible=true` 且未帶 `calibration_input_unverified` | `ESTIMATE_CALIBRATION_TAINT_DROPPED`（另有 `EXTREMUM_ELIGIBLE_BLOCKED` 視旗標而定） |
| I-22b | 同上但 `extremumEligible=false`、仍漏傳旗標（v1 與 v2 各一） | `ESTIMATE_CALIBRATION_TAINT_DROPPED` |
| I-22c | v1 檔只帶 `sensor_accuracy_unknown` | **不**視為污染（只有 `UNKNOWN_QUALITY_FLAG` 警告）；v2 檔同情況則算污染 |
| I-23 | `carried_over` 校準丟失來源校準的污染旗標（v1 與 v2 各一） | `CARRIED_OVER_TAINT_DROPPED` |
| I-24a | `lean_started` 之後第一筆 hint 前沒有 `auto_reference_state` | `AUTO_STATE_MISSING` |
| I-24b | `suspended`／`disabled` 期間出現 `lean_hint` | `HINT_WHILE_NOT_ENABLED` |
| I-24c | 現行校準存在期間出現 `lean_hint`（未標 disabled 亦然） | `HINT_WHILE_CALIBRATED` |
| I-24d | 暫停後直接 `enabled` 而沒有 `auto_reference_reset` | `AUTO_RESUME_WITHOUT_RESET` |
| I-24g | 取消後 estimator 不可用／experimental／mount 仍成立卻記 `enabled` | `AUTO_ENABLED_WHILE_BLOCKED` |
| I-24h | 暫停中第二次 reset 被省略，使重播邊界與完整基準不同 | `AUTO_RESET_MISSING`（以與完整重播基準比對的配對 fixture 驗證 reset 與轉換的必要次序） |
| I-24e | `afterInputs` 倒退／超前（含狀態事件） | `HINT_CURSOR_REGRESSION`／`HINT_CURSOR_AHEAD` |
| I-24f | 缺初始狀態或轉換卻宣告 `replayScope.calibration=true` | `CALIBRATION_REPLAY_STATE_INCOMPLETE` |
| I-24 | `hintRange` 有缺號／晚於校準 | `HINT_RANGE_INCOMPLETE`／`HINT_AFTER_CALIBRATION` |
| I-25 | hint 的 `afterInputs` 倒退或超前 | `HINT_CURSOR_REGRESSION`／`HINT_CURSOR_AHEAD` |
| I-26 | `--location` 下 `gpsRef` 與 `fix` 不符 | `HINT_GPS_MISMATCH` |
| I-27 | experimental run 出現 extremum | `EXTREMUM_IN_EXPERIMENTAL_RUN` |
| I-28 | `qualified` 無 ref／指紋不符／配置與檔案宣告不符 | `QUALIFIED_WITHOUT_REF`／`QUALIFICATION_FINGERPRINT_MISMATCH`／`QUALIFIED_CONFIG_MISMATCH` |
| I-29 | 父檔前綴雜湊不符 | `DERIVED_RUN_PARENT_MISMATCH` |
| I-30 | 同值不同欄位順序的重複行 | `SEQUENCE_DUPLICATE`（**不得**判 `SEQUENCE_CONFLICT`） |
| I-31 | 同序號內容不同 | `SEQUENCE_CONFLICT` |
| I-32 | 完整損壞行（有換行）／尾行未完成 | `NOT_JSON`（完整行為 error；尾行維持 v1 語義，由 `log_truncated` 處理） |
| I-33 | 長距離（>1M 行）重複與衝突（大檔案例，C2 才產生） | `SEQUENCE_DUPLICATE`／`SEQUENCE_CONFLICT` |
| I-34 | 極多 findings（>1M，大檔案例） | 全部可在 `--findings-out` 或預設輸出完整找到，行程記憶體不隨之成長 |


### 差異回歸（雙向）

位置：`testdata/contracts/motion-lean/v1/regression/`。舊工具指 PR #10 的 `7474933`。

**舊工具的實際行為**（`static validation`，讀 `validate-motion-lean.mjs`）：motion 宣告先以 `Math.max(known.storageStride ?? 1, source.storageStride)` 累積成**全檔**的最大 stride（行 391）；配對時以該值檢查，每個來源**只報一次**（`strideReported`，行 874–877），報在**該來源第一個 `replayable=true` 估算的引用處**。因此：只要全檔任一 session 的 stride > 1，舊工具對該來源就會看到 stride > 1，**位置可能落在錯誤的 session**；它並非「必然漏報」。

每個 R 案例的 `.expected` 在建立 fixtures 時**以舊工具實際執行的 error 碼與行號為準記錄**（寫入 `.old-tool` 檔供差異測試比對），新工具僅依「被引用樣本所屬 session」的宣告判斷，每個 (來源, session) 至多報一次。不強造「舊 PASS、新 FAIL」。

| 案例 | 結構 | 舊工具（預期，建立時以實跑為準） | 新工具 |
|---|---|---|---|
| R-01 | session A stride 2、session B stride 1；`replayable=true`，估算引用只在 B | 看到全檔 stride 2，在 B 的第一個引用報 `REPLAY_STRIDE_DROPS_INPUTS`（**錯誤 session，false positive**） | 無 error |
| R-02a | session A stride 1、session B stride 2；`replayable=true`，估算引用在 A 與 B | 看到 stride 2，**在 A 的第一個引用報**（錯誤 session），B 不再報 | 只在 B 的引用報，A 無 |
| R-02b | 同 R-02a，但估算引用只在 B | 在 B 報（位置碰巧正確） | 在 B 報（相同） |
| R-02c | 同 R-02a，但估算引用只在 A | 在 A 報（false positive） | 無 error |
| R-03 | v1 估算帶兩旗標＋eligible=true | 兩旗標為未知旗標：只有警告，不報 error | `EXTREMUM_ELIGIBLE_BLOCKED` |
| R-04 | v1 校準帶 `sensor_accuracy_unreliable`；估算 eligible=false 且漏傳 `calibration_input_unverified` | 無 error | `ESTIMATE_CALIBRATION_TAINT_DROPPED` |
| R-05 | v1 `carried_over` 校準丟失來源的 `calibration_input_unverified` | 無 error | `CARRIED_OVER_TAINT_DROPPED` |
| R-06 | v1 檔出現 `sensor_accuracy_unknown` | `UNKNOWN_QUALITY_FLAG` 警告 | 同左（V1 不回溯） |

R-01、R-02 同時涵蓋 2→1 與 1→2 兩種方向。R-03～R-05 是歷史收緊（A.3 V1-2、V1-4、V1-5），新工具的 error 屬**預期的有意變更**，差異測試以此清單為豁免依據，其餘 v1 fixtures 結果必須逐碼逐行相同。

## G. 已知限制與未決事項

1. **聯合 frame、輸出率、濾波係數、群延遲**：全部未定。S5 先做合成頻寬／延遲掃描，再提交 schema 與係數；若 50 Hz 與 R1 預算／延遲不能同時達標，提 R2，不暗中放寬。
2. **容量表為算術**，`lean_input`／stats／事件行長是草稿；真實 ID 長度未計。需序列化實測。
3. **`better-sqlite3` 版本**、索引膨脹、耗時與暫存占用：全部 untested。
4. **`qualificationRef` 的本機註冊表格式**（`--qualification-registry`）只定義語義，欄位細節在 C2 PR。
5. **v2 目錄的規範文字**：C1 PR 產生完整的 v2 README（含 v1 差異對照）；在此之前以本文件為設計依據，衝突時以 C1 PR 的 README 為準。
6. **location-log 驗證器**仍為整檔讀取，GPS 檔體量小，不在 2 GiB 範圍；不排工作。
7. **R 案例的舊工具預期**目前是依原始碼推導，fixtures 建立時必須以舊工具實跑結果覆寫；若與本表不同，以實跑為準並更正本文件。
8. **自動參考控制狀態的 reason 清單**依 `LeanPipeline.kt` 現況列出；寫入端若有未列入的外部開關，需先回報契約擁有者增列，不得自行新增 reason。
9. **V1-4／V1-5 對既有私有 v1 檔**：untested，待 C2 驗證器存在。
10. **跨裝置 `sampleAgeMsAtSend` 等工程規則 §10 待定項**與本文件無關，不處理。

## H. C1 驗收條件（Codex 最終復核，PR #11 `1e85c5f`）

下列條件須在 C1 review 核對；缺任一項，`replayScope.calibration = true` 不得驗收。本節只記錄條件，C1 尚未開始。

1. §B.5 錯誤碼文字與表格一致（本版已修正）：stride ≥2 → `SCHEMA_INVALID`；型別合法但組合矛盾 → `STRIDE_POLICY_CONFLICT`；`available=false` 來源不帶 stride／policy 的分支保留。
2. §D.1a：所有有效狀態轉換均保存；只省略可重算的內部條件；`enabled` 為必要非充分；cancel 後仍受阻必須 `disabled`；每次實際 reset 都保存；初始狀態先於首次候選處理與第一筆 hint。
3. 上述邊界必須同時出現在 C1 fixtures（V-16a～f、I-24a～h）與後續 Kotlin replay 驗收；缺條件卻宣告 `calibration=true` 必須被拒絕。
4. R-01／R-02a～c 建立 fixtures 時必須**實跑舊工具（`7474933`）**，以實際 error 碼與行號寫入 `.old-tool`；文中推導值只是預期，不是基準。
5. V1-4／V1-5 對既有私有 v1 檔仍為 untested，待 C2；不改寫歷史檔。
6. 三種 `replayScope`（`estimate`／`calibration`／`refilter`）在各自必要資料與 Kotlin 決定性測試完成前均維持 false；schema 通過或 `qualificationRef` 存在不能替代重播／精度證據。
7. S5 聯合 frame 為正式比較候選，但不鎖 frame 格式、輸出率，也不提高 R1 容量預算；需定義來源時間對齊、過期與缺值規則，資訊可得時間不得早於任何被使用輸入。

## I. 與手機端的邊界（不要求、僅供對齊）

契約擁有者不修改 `device_bridge`、`apps/mobile`、`mobile_data`、`timing_core`。以下為 Codex 實作時需要自行確認的前提，列出來是為了避免假設落差：

- `onAccuracyChanged` 目前為空方法（F1 §2），新增後需與樣本回呼走同一 looper 且與事件佇列共序。
- `keptCount` 必須由 writer 成功追加數計算。
- 父檔雜湊在背景計算，期間 GPS 不受影響；`derivesFrom` 完整前不寫新 run 的 `lean_started`。
- `replayScope.*` 在 Kotlin 側有確定性重播測試與完整控制事件／hint／spec 之前，一律維持 `false`。
- 現有 `LeanReplayAssertions` 只涵蓋小型合成 raw＋既定校準（F1 §2），不是 C3 重播器。

## J. C1 實作對照（實作時與本設計稿的出入）

C1 的規範本文是 [`contracts/motion-lean/v2/README.md`](../../contracts/motion-lean/v2/README.md)；與本文件有出入處以該 README 為準。出入：

1. **`AUTO_RESET_MISSING` 的語義縮小。** 本文件 I-24h 設想「暫停中第二次 reset 被省略」可由配對 fixture 偵測。單一檔案內做不到（需要完整重播基準）。C1 的 `AUTO_RESET_MISSING` 只檢查「進入手動指令前沒有 `auto_reference_reset`」；「某次 reset 被省略」改由 Kotlin 重播驗收負責，v2 README §8 明寫驗證器通過不代表 reset 完整。I-24h 因此不是驗證器 fixture。
2. **`QUALIFICATION_UNSPECIFIED` 取消。** v2 的 `qualification` 為必填；v1 檔沒有此欄位，不產生新警告。
3. **`ACCURACY_CHANGE_UNRECORDED` 只對有 `inputPolicy` 的來源檢查**（全存來源的轉換在樣本本身可見）。
4. **新增錯誤碼**：`CONTROL_SEQUENCE_REGRESSION`、`SELECTION_ANCHOR_MISSING`、`ANCHOR_TIMEBASE_MISMATCH`、`SELECTION_WITHOUT_POLICY`、`EXPERIMENTAL_ESTIMATE_UNFLAGGED`（設計稿未列）。
5. **`--location`（`HINT_GPS_MISMATCH`）、`--qualification-registry`、`lean_input`／`filter_spec`／`FILTER_*`／`REFILTER_*`（除 `REFILTER_SPEC_UNRESOLVABLE`）、exit 3／130、有界引擎**：未在 C1 實作；`lean_hint.gpsRef` 目前只是可為 `null` 的參照，不被核對。
6. **`lean_started.inputSourceIds` 在 v2 由 `inputSources[]` 取代**；`lean_event` 的 `lastSequence`／`resumedSequence` 在 v2 改為 `lastSequences`／`resumedSequences`。
7. **`auto_reference_reset.reason`** 列為 `session｜boot｜manual_command｜epoch_reset｜explicit`；`auto_reference_state` 的 reason 清單與 §D.1a 相同。
8. 驗證器只能核對 `AUTO_ENABLED_WHILE_BLOCKED` 的「現行校準」與「估算不可用」兩種阻擋；`experimental` 輸入在檔案中沒有可核對的來源。
9. **v1 回歸 R-01～R-06 的舊工具欄是實跑結果**（`7474933` 凍結副本，記於各案 `old-tool.json`）：R-01 在 session B 的引用處誤報（false positive）；R-02a 在 session A 的引用處報（錯誤 session）；R-02b 在 B 報（位置碰巧正確）；R-02c 在 A 誤報；R-03～R-06 舊工具只有 `UNKNOWN_QUALITY_FLAG` 警告。與 §F 的推導一致。
