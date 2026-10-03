# RoadScope mobile_data

P0 依 `contracts/location-log/v1` 匯入原生 NDJSON；手寫 Dart 模型的範圍依共同規則 §5。`LocationSampleImporter.addNdjson` 每次接收完整檔案，逐行驗證，再依 `(recordingId, sourceId, sequence)` 去重並排序。重新匯入相同檔案為冪等；單一檔案內的重複序號或內容衝突屬 error，保留首筆。截斷或非法行會回報錯誤並繼續解析後續行。`report.ok` 區分 error 與非致命 warning；不能只以有無樣本判斷檔案有效性。

所有 UTC 欄位為 RFC3339 `Z` 字串；速度為 m/s、精度為公尺、單調時間為微秒。iOS `measurementMonotonicUs=null`，附 `measurement_monotonic_unavailable`，不得用接收單調時間替代測量間隔。量測欄位的 null 與 `*_unavailable` 旗標須雙向一致。`phone_gnss` 過渡別名匯入後映射成 `phone_location`，附警告；原始紀錄檔不改寫。

未知 recordType／eventType／qualityFlags 保留並警告，缺少 recordType 為 error。`report.events` 及 `report.unknownRecords` 保留原始行；App 匯出原生原檔，維持行順序及未知欄位。既有根層 `testdata/location-sample-synthetic.ndjson` 是 pre-contract 格式，不再作為合法案例；本套件使用 `testdata/contracts/location-log/v1` 的共同 21 個 fixtures，另測試重播、未知事件、衝突與 null 旗標。

`flutter test` 執行 fixtures 與匯入測試；`dart run bin/inspect_log.dart <檔案>` 顯示契約錯誤碼、警告、樣本數及 callback 間隔，有 error 時回傳非零 exit code。所有合成案例皆非真機證據。
