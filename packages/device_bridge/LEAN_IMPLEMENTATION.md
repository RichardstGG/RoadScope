# 傾角實作狀態

## 契約與原始紀錄

開發基準為尚未合併的 [PR #10](https://github.com/RichardstGG/RoadScope/pull/10)
`747493332c2dd59044a425508387b3b4d31ab24e`。不修改 location-log v1。
新增 motionCapabilities／motionStatus／leanCalibration 方法及 device_bridge/motion
EventChannel；舊 plugin 方法不存在時顯示不可用。
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
新增 clock_map。保留最多 4 筆映射，晚到來源只用測量時刻已生效的映射，
無可用映射時 clockMapId=null＋clock_map_unavailable，不套未來映射。
每秒檢查空間，少於 256 MiB 停止 motion 並回報錯誤，
GPS 不因此停止。約 180 MB/h 只是契約 fixture 粗估，待真機量測。
缺口、非法輸入、buffer overflow 有事件；raw IO 失敗停止，不盲目重試。
定位 boot authority 改變時停止 motion，要求重新開始，不默默串接時域。

UI 顯示能力、樣本數、時鐘狀態、錯誤與車把轉向誤差提示。
motionStatus／EventChannel 新增可選診斷欄位 `leanBlockReason`、
`leanBlockedSourceIds`、`sensorAccuracy`（每來源最近成功寫入樣本的原始品質，非即時保證）。
以所有來源彙整時鐘與 accuracy 阻擋，健康來源不會掩蓋另一來源不可靠。
舊 plugin 未提供時顯示尚未取得診斷，iOS 不因缺欄位失敗。
同為 unavailable 但原因改變時追加既有契約 estimator_state；相同原因不重複寫入。
accuracy 阻擋以契約已有的 input_interrupted 記錄，具體來源與品質看原始 motion／UI，
不新增契約欄位或原因列舉，也不改寫舊紀錄。品質恢复需完整新輸入與新 epoch。
狀態取自記憶體小快照，不讀完整高頻檔案。正常停止後可主動分開分享 motion／lean。
EventChannel 最多 10 Hz 發布已寫出的估算，main looper 只留一個待送快照。
超過 500 ms 的舊角度隱藏；IO watchdog 每 250 ms 檢查靜默中斷並記 unavailable。

## 實驗性傾角與校準

純 Kotlin 幾何核心包含 3 秒靜止直立窗口、額外左傾方向確認、任意安裝
座標左右傾角投影。必須輸入 world-up 在 device axes 中的向量，
不能直接把過彎 accelerometer 當直立方向。已接入 service：按直立收集 3 秒，
再安全左傾 5–25 度確認並靜止 3 秒。僅停車安全支撐、前輪朝前時操作。
窗口不合格會重算；取消流程不刪除既有有效校準。
校準保存 sourceRange、實際窗口 spread 及左傾證據；等下一筆真實測量才生效，
生效時間晚於所有證據與舊估算，不捏造未來 writtenMonotonicUs。

lean writer 分段最大值以連續至少 100 ms 同側窗口的最小絕對角度作保守峰值，
保存來源時間；重校準保存前段，無效值、跨 boot、逆序或 >100 ms 缺口
清除窗口。規則尚需動態參考比較，不代表真實最大傾角準確度。

本版演算法標識為 gyro-rest-up-auto-experimental-v2（前版為 gyro-rest-up-experimental-v1）：
融合仍為平台 quaternion 初始化 world-up，
gyro Rodrigues 積分；只有 rest-like 輸入才以每筆 1% 慢速修正至平台姿態。
rest-like 是 gyro ≤0.035 rad/s、比力量值距 g ≤0.4 m/s² 的工程判斷，
不證明車輛停住；長緩彎可能誤判、gyro 會漂移、平台姿態可能被動態污染。
尚不具有道路準確度保證。比力量值距 g >2 m/s² 時帶 dynamic_acceleration_high，
缺口後 1 秒帶 after_input_gap，兩者都不計最大值。
來源 accuracy 為 unreliable 或不可得時停估算；平台若不報有效 accuracy，
本版可能保持 unavailable，須真機確認，不為讓畫面出值而放寬。

只有成功寫出 raw 的輸入才能進融合；最多 20 Hz 写估算，measurement 時刻為
最新引用輸入的測量時間，不是 UI／接收時間。null 時鐘完全不寫估算。
缺樣／時鐘狀態／中斷清除輸入與濾波，恢復用新 filterEpoch；缺口後重新收斂。
raw 寫入失敗停止整個 motion，未寫出的輸入根本未消費；續錄開 recovery epoch。

lean fsync 前先做 raw fsync；正常停止亦同。不宣稱跨檔原子性或斷電零遺失。
lean 恢復以串流掃描做序號與 raw 引用上界檢查；發現缺少 raw 引用時保留原檔、
拒絕續錄，連部分尾行也不修掉。這不是取代完整配對驗證器。
恢復結案前段保留最大值。同 boot 的程序續錄也採保守重新校準，跨 boot 不沿用；
重校準與新 boot 的分段最大值從 null 開始。
精準 GPS 對時仍須兩邊來源該時段都已驗證，不代表角度準確度。

## 自動直立參考

`AutoUprightReference` 為純 Kotlin、有界、時間加權候選篩選器。
只接受同 boot、已驗證測量時間的 GPS：速度 5–100 m/s、水平誤差 ≤10 m、
速度誤差 ≤1.5 m/s、航向誤差 ≤5°，缺欄位／非有限值拒絕。
兩筆 GPS 測量需相距 0.1–2 秒、最短航向差速率 ≤1°/s；最新 fix
不可超前 motion，且最多使用 1.5 秒。這些只是未經真機確認的起始門檻。

motion 條件為 gyro norm ≤1°/s、比力量值距 g ≤0.4 m/s²、方向 spread ≤1.5°，
以完整、非重疊 3 秒窗口累積原生測量時間；缺口 >100 ms、逆序／重複、
GPS 不合格均切斷未完成窗口，不補時間。gyro norm 是未知車軸時的保守轉向上界，
不是由 GPS 差分推得的實際車身 yaw。候選向量也依時間而非 callback 數加權；
回報的 spread 是相對最終參考的保守上界，不因群中心移動而低報。

最多 8 個方向群；累積最多者需 ≥30 秒，較次名多 ≥6 秒且 ≥1.5 倍才提出一次參考。
第九群使自動選取保持不可用，不淘汰舊證據來製造勝者。reset 清除全部候選與 GPS。
自動參考只提出 upDevice 與證據，不推斷側傾軸、不取代手動校準。
道路坡度、緩彎誤分類與融合漂移仍可能污染候選，不能宣稱真實直立或道路準確度。

定位服務只有成功追加 GPS 後才交出品質 hint，單一 AtomicReference 合併最新 hint，
不加入無界 GPS callback 佇列；motion writer 消費 hint、篩選及追加校準。
已驗證 GPS 域依 Android location-log 的 measurementMonotonic 能力，另檢查
測量時間不晚於接收，且必須同 boot；時間可比不等於感測器或道路角度準確。
GPS 航向 accuracy 為即時品質 gate，既有 location-log 沒有此欄位，也不新增欄位。

完成候選後於下一筆真實測量寫 origin=auto_straight_ride 校準，保留證據。
leanAxisSource=unknown，正交單位向量只是 schema 所需的占位值，絕不參與角度計算；
估算為 null＋lean_axis_unknown＋lean_unavailable，左右最大值亦 null。
UI 顯示有效時間與方向未知原因，請停車完成手動校準，不要求行進中操作或刻意加速。
手動流程中暫停候選；手動完成後自動參考不覆蓋。取消／輸入中斷清除候選及未生效校準，
保留已生效的同 boot 校準；程序續錄與 boot 改變都不恢復有效校準。

完整融合重播測試從 persisted raw epoch 起點讀到 estimate 的每個 sourceRef 終點，
使用生產 LeanFusion 與已存校準，比較每筆非 null 角度（容差 1e-9 度），
涵蓋動態力品質 gate、缺樣與時鐘失敗後新 epoch。這是合成重播一致性，
不是獨立準確度驗證；自動候選選取沒有宣稱可由 GPS 檔重播（航向 accuracy 未存）。

## 驗證界線

- automated：writer 時鐘狀態、序號、尾行修復、跨 boot、IO 失敗、
  缺樣、有界 buffer、合成幾何、手動校準、估算與峰值來源、品質閘門、
  重校準、lean 尾行修復、跨 boot、dangling raw 拒絕及 fsync barrier 呼叫。
  原生 motion／lean 合成輸出交 PR #10 同版驗證器逐檔及配對檢查，CI 固定契約 SHA。
  原生共 69 項，其中自動候選核心 11 項；涵蓋不同 callback 密度、品質缺失、
  GPS freshness／逆序、方向群優勢、spread 上界及候選容量超限。
- static：Dart UI 分析、原生採集生命週期整合及 Android 建置。
  服務銷毀在 GPS owner 排入 motion 清理，另檢查啟動途中 destroyed，避免主執行緒
  清理與 session 建立競態；真實 Android 銷毀／重建流程仍待 hardware 驗證。
- manual / hardware：前版 ba460d0 在 Xiaomi 21081111RG／Android 14 正常開始與停止。
  約 562.66 秒、87,721 筆 motion，每來源約 51.91 Hz，無序號缺口或 >100 ms 間隔，
  三來源時鐘均驗證通過；加速度全程 unreliable、gyro／attitude high，零 lean 估算。
  三檔契約與配對零錯誤／警告。這是品質阻擋案例，不是校準或傾角精度驗收。
  USB 全程連接，非電池／背景耐久測試。修正後版本尚需實測；background、
  低儲存量、耗電待測。之前 GPS 長測不是本版證據。
- untested：實際動態融合準確度／漂移、停車校準操作、EventChannel 背景生命週期、
  真正程序死亡／斷電的双檔耐久性、Android OEM accuracy、iOS runtime。
  自動參考已做原生管線合成整合／UI mock，真實 GPS 至服務交接仍未實測；
  完整融合重播比對僅涵蓋合成案例，不涵蓋真機或重選自動校準。

Android V1.0 基礎功能與 UI 真機通過前，不安排 iOS 真機測試。
