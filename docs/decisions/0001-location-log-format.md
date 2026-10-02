# 0001：原生位置紀錄格式與擁有權決定

日期：2026-10-01
狀態：已決定（使用者拍板）
影響路徑：`contracts/location-log/`、`packages/device_bridge/`、`packages/mobile_data/`、`packages/timing_core/`、`.github/workflows/`
相關：PR #2（P0 原生記錄器）、PR #3（分工文件）

## 背景

PR #2 實作了 Android／iOS 原生 NDJSON 採集與暫定 `LocationSample`，並在 PR 留言提出五項契約校對請求。Claude Code 完成 static validation 後，額外發現三項 PR 留言未涵蓋的問題。使用者同時決定將純 Dart 記錄資料與正式計時核心由 Codex 移交 Claude Code。

實機驗證（30 分鐘／2 小時採集）刻意延後：原生輸出格式即將變更，先採集的資料在變更後無法沿用。

## 決定

### D1 CI 擁有權
新增 `.github/workflows/dart-core.yml`（Claude Code 擁有），涵蓋 `packages/timing_core` 與 `packages/mobile_data` 的 `pub get`／`analyze`／`test`。`.github/workflows/mobile.yml`（Codex 擁有）移除這兩個套件的步驟，只保留 `apps/mobile` 與 `packages/device_bridge`。

執行時點：`mobile_data` 在交接生效前仍由 Codex 維護，其 CI 也應留在 `mobile.yml`。因此 `dart-core.yml` 與 `mobile.yml` 的實際拆分在交接生效時一併執行。

補充（2026-10-02）：`main` 上的 `packages/timing_core/` 目前只有 `.gitkeep`，沒有任何 Dart 套件，`mobile_data` 也還不在 `main` 上。此時建立 `dart-core.yml` 會在空目錄執行 `flutter pub get` 而必然失敗，因此該 workflow 延到 `timing_core` 有第一份程式碼時才建立。contracts v1 PR 只建立 `contracts.yml`。

### D2 「真機驗證完成」的定義
交接完成需同時滿足：
1. Android 真機 30 分鐘與 2 小時各一次完整採集，含鎖屏區段；
2. iPhone 真機 30 分鐘與 2 小時各一次，含鎖屏區段；
3. 依 `05-mac-iphone-checklist.md` 回報格式提交報告，附樣本數、間隔分布、缺口與耗電；
4. 匯出的紀錄通過當時版本的契約驗證器；
5. 由使用者在 PR #2 宣告交接生效。

安裝成功、App 可啟動、CI 綠燈、`flutter analyze` 通過均不構成交接條件。

### D3 `testdata/` 切分
- `testdata/contracts/**` — Claude Code，契約 fixture，與 `contracts/` 同版本
- `testdata/device/**` — Codex，原生採集樣本

PR #2 的 `testdata/location-sample-synthetic.ndjson` 尚未進入 `main`。該檔在 PR #2 合併或交接時由 Claude Code 併入 `testdata/contracts/location-log/v1/`，本決定不要求 Codex 先搬動。

### D4 NDJSON 加入 `recordType` 判別欄位
每行加 `recordType`，值 `sample` 或 `event`，`schemaVersion` 維持 `1`。

必要性：原 `LocationSampleImporter.addNdjson()` 把每一行都當樣本，無法解析者計入 `invalidLines`。若直接往同檔寫入校時事件，現有匯入器會把它們當損壞資料。判別欄位必須先於事件存在。

同時定義四種事件：`recording_started`、`clock_adjusted`、`log_truncated`、`recording_resumed`。事件共用 `recordingId`、`sourceId`、`deviceBootId`，並以 `lastSequence` 標示發生時最後一個有效樣本序號；事件**不佔用樣本序號**，序號空間保持連續。

### D5 `sourceType` 改 `phone_location`
Core Location 不保證單筆測量只來自 GNSS，`phone_gnss` 名不副實。`sourceType` 的允許值為 `phone_location`、`external_gnss`、`obd`，對應 `01-master-plan.md` §11 的來源介面；實作差異由 `sourceId`（`android-gps`／`ios-corelocation`）表示。

`phone_gnss` 列為過渡期可接受別名，驗證器接受但標記 deprecated，匯入時映射為 `phone_location`；P1 結束時移除別名。

另決定：模擬資料的 `sourceType` 必須是被模擬的來源種類（通常 `phone_location`），模擬性質只由 `qualityFlags` 的 `synthetic` 表示。原先把 `sourceType` 設為 `synthetic` 的做法把「來源種類」與「是否模擬」兩個正交軸混進同一欄位，使合成資料無法重播成與真實來源相同的程式路徑。

### D6 `qualityFlags` 改用 `*_unavailable` 命名
允許值：`speed_unavailable`、`heading_unavailable`、`horizontal_accuracy_unavailable`、`speed_accuracy_unavailable`、`altitude_unavailable`、`measurement_monotonic_unavailable`、`synthetic`。保留 `*_rejected` 後綴給將來真的被過濾掉的值。

理由：原先混用 `invalid_*` 與 `measurement_monotonic_unavailable`。且 Android 的 `invalid_speed` 實際是 `hasSpeed() == false`（值不可得），不是值無效。「不可得」與「被過濾」對計時的意義不同，必須分開命名。

未知旗標必須原樣保留、不得丟棄、不得當成有效。欄位為 null ⟺ 對應旗標存在，由 JSON Schema 雙向強制。

### D7 iOS `receivedMonotonicUs` 改用 `mach_continuous_time()`
`DeviceBridgePlugin.swift` 原用 `ProcessInfo.processInfo.systemUptime`，屬 `mach_absolute_time` 時間域，裝置睡眠期間不前進；Android 的 `SystemClock.elapsedRealtimeNanos()` 包含深度睡眠。兩小時鎖屏採集正是睡眠最多的情境，兩平台的 received-monotonic 差值會系統性不可比，`receivedAtUtc - receivedMonotonicUs` 推出的 boot anchor 也會在 iOS 漂移。

契約明定 `receivedMonotonicUs` 必須是含睡眠的單調時鐘。iOS 改用 `mach_continuous_time()` 搭配 `mach_timebase_info` 換算微秒。

證據等級：static validation（讀 Swift／Kotlin 原始碼推論）。排實機時比對首末樣本的 `receivedAtUtc` 差與 `receivedMonotonicUs` 差，iOS 明顯短少即確認。

### D8 契約型別策略：先不生成，以 fixtures 對齊
JSON Schema 是唯一真實來源。暫不導入 schema→Dart／TypeScript 的生成器。

- `contracts/tools/` 提供 Node＋ajv 驗證器，由 `contracts` CI 對全部 fixtures 執行。
- Dart 端沿用 `packages/mobile_data` 現有手寫模型，但**必須通過同一批 fixtures**；fixtures 是雙端一致性的防線。
- 交接生效後由 Claude Code 統一 Dart 側驗證邏輯。
- 重新評估生成器的時機：契約欄位穩定後，或 `timing_core` 與後端開始共用型別時。

此決定明知與 `01-master-plan.md` §6「生成檔由生成器產生，不人工改兩份模型來湊相容」的字面規定有張力。取捨理由：P0 階段欄位仍在變動，過早鎖定生成工具的轉換成本高於現在維護兩份手寫模型，而 fixtures 提供了可自動檢查的等價保證。此例外僅限 `location-log` 契約，車隊 HTTP／WSS 契約另行評估。

### D9 舊格式不支援，`schemaVersion` 維持 1
`recordType` 自契約生效起為必填。缺少該欄位的紀錄（PR #2 的 pre-contract 輸出）為非法資料，不提供寬鬆路徑。

理由：成立前提是尚未進行任何實機採集，現有資料只有安裝 APK 後的數分鐘前景樣本，丟棄無損失。選擇不 bump 到 `schemaVersion: 2` 是因為那條 legacy 分支必須由匯入器、驗證器與 `timing_core` 永久維護，而它服務的資料量為零。

另一個理由比相容性更重要：若採「缺 `recordType` 就當 sample」的啟發式，真正損壞的行也會被放行，錯誤碼 `MISSING_RECORD_TYPE` 與 `NOT_JSON` 的診斷價值會一起消失。

`recordType` 的**值**未知（較新寫入端）仍須容忍並保留；缺少欄位與值未知是兩條不同的路徑，不得合併。

### D10 事件必須帶單調時間
事件共同欄位加入 `occurredMonotonicUs`（必填），與樣本同一時間域、同一 `deviceBootId`。

理由由 Codex 在 contracts 定案前提出的第 3 點引出：原設計只有 `occurredAtUtc`。但 `clock_adjusted` 事件裡 UTC 正是受質疑的那個值，只有 UTC 會讓校時事件本身無法在時間軸上定位，跨 boot 重播也失去對齊依據。


## 後果

- Codex 需改 `packages/device_bridge/` 的 Android 與 iOS 輸出（D4、D5、D6、D7，另含 iOS heading 旗標與值判斷不一致的小修），以及交接前的 `packages/mobile_data/` 匯入器。
- 既有 P0 診斷資料在格式變更後作廢。因為尚未進行實機採集，實際損失為零——這是刻意先定格式再採集的結果。
- `contracts/location-log/v1` 成為 `timing_core` 的輸入契約。跨 boot 的 monotonic 不連續處理寫在契約而非實作，`timing_core` 與任何重播工具都必須遵守。

## 未決

車隊 HTTP／WSS 契約仍需 `docs/engineering-rules.md` §10 的其餘項目：隊長離隊處理、單一位置發布者的取代語義、WSS token 續期、`sampleAgeMsAtSend` 語義、即時閾值。屬 P4，不阻擋本決定。
