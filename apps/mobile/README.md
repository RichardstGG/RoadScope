# RoadScope mobile

Flutter 3.47.3 診斷 App，識別碼 `tw.idv.richardwutt.roadscope`。按「開始記錄」後，Android 前景定位服務／iOS Core Location 在原生端寫入追加式 NDJSON；Flutter 畫面每 3 秒讀取顯示。記錄不依賴網路或 Flutter 畫面存活。停止後仍可主動匯出最近一筆記錄。此版是 P0 採樣驗證工具，尚無穿線計時。

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

首次啟動須授予精確定位；iOS 測試背景採集時選擇允許持續定位。Android 會顯示常駐的記錄通知。iOS 簽署與實機安裝須在 Mac 上設定開發團隊。匯出的 NDJSON 有精確座標，請只主動提供給可信的測試協作者。

## 真機測試包

每次測試前記下 App commit、手機型號／OS、權限設定、電量與開始 UTC。選一段可安全停留的戶外路線；駕駛者不要操作畫面。兩端都要各自跑下列測試，不能以模擬器代替。

| 測試 | 操作 | 應記錄的證據 |
| --- | --- | --- |
| 30 分鐘 | 前景 5 分鐘、鎖屏 20 分鐘、返回前景 5 分鐘；再按停止及匯出 | 記錄 ID、樣本數、前後時間、鎖屏期間是否仍有樣本、最大 callback 間隔、錯誤／品質旗標、電量變化 |
| 2 小時 | 前景 10 分鐘、鎖屏 100 分鐘、返回前景 10 分鐘；停止及匯出 | 同上，另記手機溫度／系統省電模式、記錄檔大小、是否有服務或 App 重啟、序號缺口 |
| 恢復檢查 | 記錄途中正常切換其他 App、回到 RoadScope；另用獨立短測試重新啟動 App | 回來後同一記錄 ID、序號連續性、無重複樣本；若系統或使用者強制停止，寫明實際行為 |
| 權限檢查 | 獨立短測試撤銷定位／關閉 GPS，再回 App | 顯示錯誤或無樣本的實際狀態，不可把無定位當成有效速度 0 |

將匯出檔安全複製到電腦後，在 `packages/mobile_data` 執行：

```sh
dart run bin/inspect_log.dart /absolute/path/to/exported.ndjson
```

請保存命令輸出、開始／結束 UTC 與測試紀錄，並回報任何 >5 秒空窗的當時螢幕／電源狀態。`callback gaps` 是原生收到樣本的間隔，並非定位或計時精度。完成兩種時長和兩平台測試後，才能對背景穩定性提出實測結論；目前尚未取得真機證據。

工具版本、Linux／Mac 建置命令見 [`docs/mobile-toolchain.md`](../../docs/mobile-toolchain.md)。P0 真機驗證依根目錄 [`05-mac-iphone-checklist.md`](../../05-mac-iphone-checklist.md) 執行。
