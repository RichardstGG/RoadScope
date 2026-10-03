# RoadScope device_bridge

本 plugin 提供 `start`、`stop`、`status`、`readLog`、`readTelemetry` 五個 Flutter MethodChannel 操作。Android 採前景定位服務和 GPS provider，iOS 採 Core Location 背景更新。兩端的原生寫入器在 App 畫面離開後持續記錄，逐筆追加 NDJSON 並同步至儲存裝置；目前僅保留最近一次記錄的匯出路徑。原生端重新啟動時，會修復不完整檔尾並由檔案恢復下一個序號。

Android 依賴精確定位授權；服務從前景畫面啟動並顯示常駐通知。iOS 需要 App 的 `location` background mode 及持續定位授權；若系統終止或使用者強制結束 App，能否自動恢復採集須在真機實測，本版不宣稱保證。Flutter 畫面和測試步驟見 `apps/mobile/README.md`。

寫入格式為 `contracts/location-log/v1`：Android 的 worker looper、iOS 的主執行緒各自序列化事件與樣本；開始／续錄先寫 `recording_started` 再啟動定位 callback。事件不消耗樣本序號。恢復以原檔最後序號、boot ID 與 anchor 為準，記錄 `log_truncated`／`recording_resumed`；完整但無法解析的行及舊格式會拒絕追加，保留原檔。anchor 位移達 60 秒時先寫 `clock_adjusted`，保存前後 anchor 和 boot ID。

iOS 接收時間與 anchor 使用 `mach_continuous_time()`，測量單調時間仍為 null。`status.sampleAgeMs` 為可空的診斷值，Android 由測量單調時間推算，iOS 由測量 UTC 與接收後單調經過時間估算；它不進入原生紀錄契約，不可用作計時依據。

除定位紀錄外，本 plugin 另寫一份**診斷 telemetry**：電量、充電、可觀測的螢幕／keyguard 狀態、App 前後台、定位服務啟停與恢復。它是獨立檔案（`<filesDir>`／`Documents` 下的 `diagnostics/<recordingId>.telemetry.ndjson`）、獨立的 `telemetryVersion` 與獨立的 `telemetrySequence`，不含位置資料，也不改動 `location-log` v1 的欄位、`recordType`、`eventType` 或序號規則；只以唯讀的 `locationLogLastSequence` 對齊兩份檔案。寫入時機是狀態改變加上 300 秒 heartbeat，狀態沒變不寫檔。`status` 回傳 `telemetryPath`，`readTelemetry` 讀取該檔，Dart 端以 `parseDiagnosticsTelemetry` 解析。欄位表與平台限制見 [`docs/diagnostics-telemetry.md`](../../docs/diagnostics-telemetry.md)。telemetry 是診斷資訊，不構成背景採集穩定的證明。

iOS 沒有公開可靠的鎖屏 API，因此 `screenInteractive` 與 `keyguardLocked` 在 iOS 恆為 null 並帶旗標，背景狀態絕不改名為 locked；Android 則明寫兩個來源 API 的名稱。兩端的 telemetry 時間與定位紀錄共用同一個含睡眠的單調時間域（Android `elapsedRealtimeNanos`、iOS `mach_continuous_time`）。

Android 原生測試命令：在 `apps/mobile/android` 執行 `./gradlew :device_bridge:testDebugUnitTest`。測試會產生合成 NDJSON 到 `apps/mobile/build/device_bridge/native-log-fixtures/`（定位紀錄，以共同 Node 驗證器檢查）與 `native-telemetry-fixtures/`（telemetry，以 `dart run bin/inspect_telemetry.dart --strict` 檢查）。iOS 無法在 Linux 執行，改以 `test/native_telemetry_alignment_test.dart` 做 static validation：Kotlin、Swift 與 Dart 三端的 telemetry 欄位集合必須一致，且不得出現座標欄位或 location-log 的記錄識別欄位。這些只驗證檔案寫入、恢復與格式一致性，未覆蓋作業系統的背景排程、耗電及實際定位品質。
