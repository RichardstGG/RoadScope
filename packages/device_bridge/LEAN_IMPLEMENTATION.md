# 傾角實作狀態

## 契約與原始紀錄

開發基準為尚未合併的 [PR #10](https://github.com/RichardstGG/RoadScope/pull/10)
`747493332c2dd59044a425508387b3b4d31ab24e`。不修改 location-log v1。
新增 motionCapabilities／motionStatus 方法；舊 plugin 方法不存在時顯示不可用。
iOS 僅能力與 unavailable 回報，未實作採集。

Android 定位服務管理獨立 motion session：加速度、角速度、姿態要求各 50 Hz，
實際頻率由裝置決定；game_rotation_vector 優先，rotation_vector 後備。
callback 複製固定大小输入，1024 格有界佇列滿載丟新，單一 writer 成功
append 後才遞增每來源序號。與 GPS 共用 recordingId、boot ID 與 anchor。
恢復串流讀檔，只修復不完整尾行；完整壞行保留並拒絕續寫。

每來源驗證需 32 筆且跨至少 0.5 秒：時間遞增、不超前、接收延遲 ≤250 ms，
elapsed 與 uptime 差 ≥2 秒。無法區分時域保持 unverified，測量時間寫 null，
不得用接收時間替代。運行中失敗／恢復先寫 source_clock_state，不追溯。
此為保守工程起始門檻，尚無真機證據，不等於證明來源時鐘正確。

stride=1，未降頻；每 0.5 秒與正常停止時 fsync。UTC offset 差 >2 ms
新增 clock_map。每秒檢查空間，少於 256 MiB 停止 motion 並回報錯誤，
GPS 不因此停止。約 180 MB/h 只是契約 fixture 粗估，待真機量測。
缺口、非法輸入、buffer overflow 有事件；raw IO 失敗停止，不盲目重試。
定位 boot authority 改變時停止 motion，要求重新開始，不默默串接時域。

UI 顯示能力、樣本數、時鐘狀態、錯誤與車把轉向誤差提示。
狀態取自記憶體小快照，不讀完整高頻檔案。正常停止後可主動分享 motion。
傾角仍顯示尚未啟用，沒有假角度。

## 傾角核心與下一步

純 Kotlin 幾何核心包含 3 秒靜止直立窗口、額外左傾方向確認、任意安裝
座標左右傾角投影。必須輸入 world-up 在 device axes 中的向量，
不能直接把過彎 accelerometer 當直立方向。尚未接入 service。

純記憶體分段最大值以連續至少 100 ms 同側窗口的最小絕對角度作保守峰值，
保存來源時間；重校準保存前段，無效值、跨 boot、逆序或 >100 ms 缺口
清除窗口。規則尚需動態參考比較，不代表真實最大傾角準確度。

下一步接估算／校準狀態機：不可用停估算，恢復建立新 filterEpoch；
raw 成功落盤後才准引用，raw 寫入失敗重設 epoch；重校準與跨 boot
最大值從 null 開始。精準 GPS 對時須兩邊來源該時段都已驗證。

## 驗證界線

- automated：writer 時鐘狀態、序號、尾行修復、跨 boot、IO 失敗、
  缺樣、有界 buffer，以及合成向量幾何與最大值窗口。
  原生合成輸出交 PR #10 同版驗證器檢查，CI 固定契約 SHA。
- static：Dart UI 分析、原生採集生命週期整合及 Android 建置。
- manual / hardware：本版未測；background、頻率、時鐘驗證比例、
  低儲存量、實際 MB/h 與耗電待測。之前 GPS 長測不是本版證據。
- untested：動態融合、校準 UI／持久化、自動參考、lean 檔、
  raw→lean 寫入順序、跨檔崩潰恢復／配對驗證、傾角 EventChannel、iOS runtime。

Android V1.0 基礎功能與 UI 真機通過前，不安排 iOS 真機測試。
