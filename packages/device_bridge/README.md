# RoadScope device_bridge

本 plugin 提供 `start`、`stop`、`status`、`readLog` 四個 Flutter MethodChannel 操作。Android 採前景定位服務和 GPS provider，iOS 採 Core Location 背景更新。兩端的原生寫入器在 App 畫面離開後持續記錄，逐筆追加 NDJSON 並同步至儲存裝置；目前僅保留最近一次記錄的匯出路徑。原生端重新啟動時，會修復不完整檔尾並由檔案恢復下一個序號。

Android 依賴精確定位授權；服務從前景畫面啟動並顯示常駐通知。iOS 需要 App 的 `location` background mode 及持續定位授權；若系統終止或使用者強制結束 App，能否自動恢復採集須在真機實測，本版不宣稱保證。Flutter 畫面和測試步驟見 `apps/mobile/README.md`。
