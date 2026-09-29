# RoadScope mobile_data

P0 本機 `LocationSample` 格式依根目錄 `02-contract-draft.md` 的最小欄位製作，目前仍待 Claude Code 校對並定版。原生 Android／iOS 追加寫入每行一筆 JSON（NDJSON）；`LocationSampleImporter` 依 `(recordingId, sourceId, sequence)` 去重並排序。重新讀取完整檔案可還原相同樣本集合；同鍵而內容不同會回報衝突，保留首筆。檔尾不完整 JSON 會列為無效行，原生端重啟時會截去不完整檔尾。

所有 UTC 欄位為 RFC3339 `Z` 字串；速度為 m/s、精度為公尺、單調時間為微秒。Android `measurementMonotonicUs` 使用 `Location.elapsedRealtimeNanos`；iOS 的 `CLLocation.timestamp` 只有 UTC，故 `measurementMonotonicUs=null` 並加 `measurement_monotonic_unavailable`。兩端收到時間的 monotonic 值只用於同一 `deviceBootId` 的 callback 間隔，不假裝成測量時間。來源為 `phone_gnss`，iOS `sourceId=ios-corelocation`，Android `sourceId=android-gps`。無效或缺失數值為 `null`，品質旗標目前為 `invalid_speed`、`invalid_heading`、`invalid_horizontal_accuracy`、`invalid_speed_accuracy`、`invalid_altitude`。

`testdata/location-sample-synthetic.ndjson` 為合成資料，不能當真機證據。本版格式尚未對外發布；若共同契約改動欄名、時間來源或旗標，需同時更新兩端寫入器、匯入器、合成案例與回放測試。請 Claude Code 先確認：`sourceType` 枚舉、旗標名稱、iOS 無測量 monotonic 的表示、UTC 校時事件如何與樣本關聯，以及序號在同一 recording/source 的重啟語義。共同 schema 應在 `contracts/` 的契約 PR 定義，這裡不建立第二份網路 API 模型。
