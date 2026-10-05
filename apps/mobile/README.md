# RoadScope mobile

Flutter 3.47.3 診斷 App，版本 `0.0.2+2`，識別碼 `tw.idv.richardwutt.roadscope`。按「開始記錄」後，Android 前景定位服務／iOS Core Location 在原生端寫入符合 `contracts/location-log/v1` 的追加式 NDJSON；Flutter 畫面每 3 秒讀取顯示。記錄不依賴網路或 Flutter 畫面存活。停止後可主動匯出最近一筆記錄。此版是 P0 採樣驗證工具，尚無穿線計時。

樣本年齡超過 5 秒時，下一次畫面更新會顯示「無新定位／樣本已過期」及 `-- km/h`；不再把上一筆速度當成目前速度。Android 年齡來自原生測量單調時鐘；iOS 只能以接收時的測量 UTC 年齡加上接收後單調時間估算，仍受 UTC 校時影響。這是資料新鮮度提示，不能用來判定硬體衛星訊號強度。iOS 無測量單調時間或跨 boot 的樣本間隔改以測量 UTC 推算，並顯示品質限制。

升級時保留舊紀錄檔，但正式匯入器不支援缺少 `recordType` 的舊格式，也不會把新格式追加到舊檔。若啟動時顯示舊格式錯誤，先匯出保留，再開始新紀錄。不要用解除安裝的方式升級，以免刪掉本機資料。

畫面下半部顯示最近一筆**診斷 telemetry**：電量與充電狀態、App 前後台、可觀測的螢幕／keyguard 狀態、定位服務狀態、telemetry 時間，以及 telemetry 檔是否可匯出。不可得的值一律顯示「無法取得（not available）」，平台回報為未知的列舉顯示「未知（unknown）」，不會把未知當成正常或 `false`。Android 的螢幕欄位來自 `PowerManager.isInteractive()` 與 `KeyguardManager.isKeyguardLocked()`；iOS 沒有公開可靠的鎖屏 API，那兩個欄位恆為空值，只保留 `protectedDataAvailable` 這個弱訊號。telemetry 是事後判讀用的診斷資訊，**不證明背景採集穩定**，程序被系統暫停期間也不會有紀錄。

若上一段記錄沒有自己收尾（程序被終止、崩潰、斷電），下次停止記錄時會補寫一列 `recording_interrupted`，畫面也會紅字標明「上一段記錄沒有自己收尾」並指出定位紀錄寫到哪一個序號。該列的時間是**發現**中斷的時間，不是中斷發生的時間，裝置狀態欄位刻意留成不可得。反之，**沒有這個標記不代表正常結束**——若從此沒再打開 App 就沒人補寫，所以判讀時仍要比對最後一筆的時間與你預期的結束時間。

telemetry 寫在獨立檔案（Android `<filesDir>/diagnostics/<recordingId>.telemetry.ndjson`、iOS `Documents/diagnostics/<recordingId>.telemetry.ndjson`），有自己的 `telemetryVersion` 與序號空間，不含位置資料，也沒有動到 `location-log` v1 的任何欄位、`recordType`、`eventType` 或序號規則。欄位表、平台限制、判讀方式與真機驗證現況見 [`docs/diagnostics-telemetry.md`](../../docs/diagnostics-telemetry.md)。要把 telemetry 欄位放進正式定位紀錄，仍須先與契約擁有者協調。

匯出分成兩個按鈕，都需先停止記錄：「匯出 location-log v1」（含精確座標）與「匯出 diagnostics telemetry」（只含裝置與 App 狀態）。兩者分享文字各自標明格式，不混在同一個檔案或同一次分享裡。

## 開發與建置

在 `apps/mobile` 執行：

```sh
flutter pub get
flutter analyze
flutter test
flutter build apk --debug
flutter build ios --no-codesign  # macOS + Xcode
flutter run -d <device-id>
```

首次按「開始記錄」須授予精確定位；Android 13+ 會在同一流程請求通知權限。拒絕通知不會阻止記錄，但常駐通知會被系統擋掉，診斷畫面會明確標示。iOS 測試背景採集時選擇允許持續定位。

**小米／MIUI 必讀**：實測在 MIUI 14（Android 14）上，若未開啟「自啟動」並把省電策略設為無限制，程序被終止後前景服務**不會被系統重建**，採集就此結束（實測 154 秒內零重建）。三項都開啟後，SIGKILL 後 5 秒內服務被重建並正確續錄。App 的「Android 背景執行準備」區塊會顯示通知與 Android 公開的電池最佳化狀態，並提供系統設定入口；MIUI 自啟動是私有設定，仍需人工確認。重裝請用 `adb install -r`，**解除安裝會清掉這些設定與手機上的紀錄檔**。iOS 簽署與實機安裝須在 Mac 上設定開發團隊。匯出的 NDJSON 有精確座標，請只主動提供給可信的測試協作者。

## 真機測試包

長時間採集前先跑 3–5 分鐘短測：開始 → 取得戶外定位 → 鎖屏 → 返回前景 → 停止 → 匯出。確認版本 `0.0.2+2`、首行為 `recording_started`、樣本有 `recordType: sample`，且以下驗證命令通過。另在安全靜止狀態檢查定位中斷後會隱藏舊速度，以及新定位恢復後會重新顯示。短測不構成 30 分鐘／2 小時驗收。

```sh
# 專案根目錄；只在本機檢查私有匯出檔，不提交座標
npm ci --prefix contracts/tools
node contracts/tools/validate-location-log.mjs /absolute/path/to/exported.ndjson
```

每次測試前記下 App commit、手機型號／OS、權限設定、電量與開始 UTC。選一段可安全停留的戶外路線；駕駛者不要操作畫面。兩端都要各自跑下列測試，不能以模擬器代替。

| 測試 | 操作 | 應記錄的證據 |
| --- | --- | --- |
| 30 分鐘 | 前景 5 分鐘、鎖屏 20 分鐘、返回前景 5 分鐘；再按停止及匯出 | 記錄 ID、樣本數、前後時間、鎖屏期間是否仍有樣本、最大 callback 間隔、錯誤／品質旗標、電量變化；另附 telemetry 匯出檔與其中的螢幕／前後台轉換 |
| 2 小時 | 前景 10 分鐘、鎖屏 100 分鐘、返回前景 10 分鐘；停止及匯出 | 同上，另記手機溫度／系統省電模式、記錄檔大小、是否有服務或 App 重啟、序號缺口；telemetry 的 `processRestartCount`、`resumeReason` 與 telemetry 時間缺口 |
| 恢復檢查 | 記錄途中正常切換其他 App、回到 RoadScope；另用獨立短測試重新啟動 App | 回來後同一記錄 ID、序號連續性、無重複樣本；若系統或使用者強制停止，寫明實際行為 |
| 權限檢查 | 獨立短測試撤銷定位／關閉 GPS，再回 App | 顯示錯誤或無樣本的實際狀態，不可把無定位當成有效速度 0 |

將匯出檔安全複製到電腦後，在 `packages/mobile_data` 檢查定位紀錄：

```sh
dart run bin/inspect_log.dart /absolute/path/to/exported.ndjson
```

在 `packages/device_bridge` 檢查 telemetry：

```sh
dart run bin/inspect_telemetry.dart /absolute/path/to/exported.telemetry.ndjson
```

請保存命令輸出、開始／結束 UTC 與測試紀錄，並回報任何 >5 秒空窗的當時螢幕／電源狀態。`callback gaps` 是原生收到樣本的間隔，並非定位或計時精度。完成兩種時長和兩平台測試後，才能對背景穩定性提出實測結論；目前尚未取得真機證據。

完整的 Android 真機流程、adb 命令、分析命令、判讀陷阱與證據索引見 [`docs/android-field-test.md`](../../docs/android-field-test.md)。工具版本、Linux／Mac 建置命令見 [`docs/mobile-toolchain.md`](../../docs/mobile-toolchain.md)。P0 真機驗證依根目錄 [`05-mac-iphone-checklist.md`](../../05-mac-iphone-checklist.md) 執行。
