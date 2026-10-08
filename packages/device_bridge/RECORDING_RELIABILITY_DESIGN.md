# 採集與傾角可靠性設計 D1

2026-10-07；第 2 階段 Codex 設計交付。對應 [驗收基準 R1](ACCEPTANCE_BASELINE.md)。
實作基準為 PR #11 runtime `63e1b91`、文件 `4dd6c73`；契約基準為 PR #10 `7474933`。
這是待共同契約確認的設計，不是新 schema、不代表已實作，也不代表第 2 階段已共同定案。
個別真機資料與統計不在此文件。

2026-10-08：收到契約主筆設計回覆，手機端可實作性核對與待修正事項見
[審查 F1](CONTRACT_FEASIBILITY_REVIEW.md)；D1 不因此自動變成已生效契約。

2026-10-08 最終復核：契約設計 8832561 已完成 Codex 可實作性審查；
接受方向與 C1 必須落實的條件見 [F2 最終復核](CONTRACT_FEASIBILITY_REVIEW_F2.md)。
本次完成設計審查階段，不代表 schema 生效或 PR #2／真機驗收完成。

## 1. 靜態查核與設計決定

| 現況（原始碼可查） | 決定 |
|---|---|
| MotionSession 在 probe／accuracy 處理前按機型 callback 次數略過輸入；略過者不進融合 | 改為通用測量時間選樣；品質／時鐘轉換不得被略過；保留有損性宣告 |
| LeanFusion 的標準模式只在 rest-like 時每次修正 1%，受限模式每筆 attitude 重新 seed | 不把 v4 當正式道路解法；修正時間常數須以 dt 定義；正式演算法需要獨立參考與可觀測性判斷 |
| LeanLogWriter.sync 已先 rawSync，再 lean fsync | 保留屏障，不重造跨檔交易；補停止完成協定與故障注入 |
| raw／lean 恢復已逐行掃描；lean 僅用 raw 最終 counts 檢查引用上界 | 補 boot／來源／範圍／epoch 檢查；有完整損壞行時保留原檔並拒絕追加 |
| MotionSession.stop 非同步；service 排入 stop 後先寫 idle；MethodChannel stop 立即回成功 | 統一停止協調器，所有 writer 結束前不得宣稱 stopped 或開放匯出 |
| App 每次 refresh 呼叫 readLog；Android readLog 在 GPS writer 路徑下整檔 readText | 即時統計改小快照；歷史／匯出走檔案串流，不能用整檔文字更新儀表 |
| motion 分享已使用 XFile(path)，不是把 motion 文字塞進 MethodChannel | 保留路徑分享；加檔案關閉檢查，不引入多餘複製 |
| 正式驗證器 readFileSync＋split；seen、raw model、estimates、breaks 隨輸入增長 | 逐行 reader 之外，所有歷史索引與 findings 都需有界或外存 |
| 自動參考使用未存入 location-log 的 heading accuracy，GPS hint 會合併 | 不宣稱可重選自動校準；估算重播與校準決策重播分開定義 |

程式位置：`MotionSession.kt`、`MotionLogWriter.kt`、`LeanLogWriter.kt`、`LeanPipeline.kt`、
`LeanFusion.kt`、`LocationRecorderService.kt` 位於本套件 Android 主來源目錄；
App 為 `apps/mobile/lib/main.dart`；正式驗證器屬契約擁有者。

## 2. 資料與責任邊界

原生採集 → 有界處理 → 成功保存的輸入 → 估算 → lean 保存 → UI 小快照。
GPS writer 與 motion writer 繼續分離；recordingId／boot authority 只有 GPS 那一份。
任何來源測量時間不可用時，不以 callback 時間代替。序號只在完整追加成功後前進。

平台品質、演算法品質與產品驗證資格分成三層：

- `accuracyLevel` 原樣保存；unknown／unreliable 不升級成 high。
- 演算法另表示來源新鮮度、缺口、動態污染、校準有效性、模式；原因不靠單一 bool 丟失。
- 正式最大值還需要已通過的演算法／配置資格。平台 high 或旗標空集合本身不足以取得資格。

新增資格旗標／狀態只能由共同契約核定。現有兩個旗標
`sensor_accuracy_unreliable`、`calibration_input_unverified` 應列為已知且阻擋 extrema。
另請契約主筆決定「演算法／降採樣尚未驗證」的正式表示，不能套用不相干旗標。
診斷資料保存 sensor type／vendor／version／resolution／range／minDelay、事件 accuracy
與 accuracy callback 的變化；它們用來重現 OEM 差異，不證明物理精度。

## 3. 四種頻率與有損模式

| 層級 | D1 起始策略 |
|---|---|
| 平台回呼 | 請求 20,000 us；量測實際 cadence，不假定等於 50 Hz |
| 保存輸入 | 每來源每 20,000 us 測量時間桶最多保留一筆真實事件；不改原值／時間 |
| 估算 | 只消費已保存輸入，最多 20 Hz 產生 lean；以測量 dt 更新 |
| UI | 最多 10 Hz、只保留最新待送快照；500 ms 舊角度隱藏 |

### 3.1 通用選樣規則（取代型號除四）

每來源第一筆通過時鐘驗證的測量時間設 anchor。`bucket = floor((t-anchor)/20,000)`；
保留每個新桶第一筆，其餘只計 intentional skip。不補點、不內插、不改時間為桶中心。
低於目標頻率時保留每筆；批次 callback 仍用測量時間而非到達時間分桶。
clock unverified 時可用 received 時間限制診斷保存量，但 measurement 維持 null、不得估算；
驗證通過／失敗時清除桶狀態並開新 epoch，相關狀態須落盤。
重複／逆序測量不可冒充主動略過；回報來源中斷，丟棄數量已知才填數字。

品質／時鐘先檢查，然後選樣。桶內品質變壞／恢復需保存有序控制事件，不能等下一筆
保留樣本才發現。估算只受已存樣本與已存控制事件影響；若控制事件無法保存，停止 motion。
這些事件名稱／內容及 policy 欄位由契約主筆定案。不能用 storageStride=1 假裝全存，
也不能用不存在的固定 stride 表示時間選樣。
一次 session 固定 period，不在中途偷偷自適應；變更策略需停止／新 session 與新的宣告。

### 3.2 抗混疊與重播的完整解法邊界

上述選樣是**有損診斷模式**，延續使用者選擇；它解決頻率不可預測與容量問題，
不等於抗混疊濾波。未證實感測帶寬前，不將降採樣 gyro 的積分升為正式道路估算。
所有有損模式先保持 replayable=false；不因選樣後「看起來能重播」就改契約宣告。

正式融合若需要降低高頻輸入，D1 選擇「全回呼進有界前置濾波 → 保存濾波後的必要輸入 →
估算只消費這些已存輸入」。濾波結果屬衍生輸入，**不能寫成 raw motion_sample**。
請契約主筆確認獨立 derived-input 型別／來源、時間支撐區間、延遲、品質、策略版本及引用。
原始稀疏診斷資料與衍生完整估算輸入必須可區分；缺少未保存 raw 時，不能宣稱能重新設計
前置濾波器。可重播的宣告只涵蓋「已存衍生輸入 → 估算」，不涵蓋 raw 重建。
濾波器 warm-up／缺口需 unavailable、新 epoch；不得在缺口兩邊接續內部狀態。

不在未量測帶寬／通過合成頻率掃描前預選濾波係數。第 3 階段先比較 25／50／100／200 Hz、
抖動、批次及 Nyquist 上下的合成振動，固定通帶、阻帶衰減與延遲預算再提交係數。
若 50 Hz 與 R1 延遲／精度無法同時達標，提出提高頻率／容量的 R2，不能暗中放寬目標。
此正式路徑涉及新資料語義，契約同意前不可實作輸出；有損診斷模式不可冒充它的完成品。

重播分三個範圍：已保存校準下的估算、從證據重新選校準、從原始全頻資料重新濾波。
各自保存足夠輸入才可宣告。需要重選自動校準時，須額外保存已消費 GPS hint、
heading accuracy 與消費順序／引用，先走契約；不修改 location-log 以偷偷補欄位。

## 4. 保存資源與停止協定

以下是第 3 階段需測試的固定起始預算，不是硬體性能保證：

| 項目 | D1 決定 |
|---|---|
| motion 資料佇列 | 最多 1,024 entries 且估計 payload ≤1 MiB；兩者先到者生效；滿則丟新 |
| 控制事件 | 獨立最多 64 entries／64 KiB；同來源丟樣聚合計數；不能保存關鍵狀態轉換就停止 motion |
| 排程公平性 | drain 每次最多 64 entries 或 5 ms 後讓出，避免 timer／stop 永久排不到 |
| stale queue | 最舊輸入落後接收超過 500 ms 時，丟棄過期區間並記 samples_dropped／重設；不輸出追趕舊角度 |
| 同步 | 最多每 500 ms 檢查同步；明確 raw sync 成功才 lean sync；正常排程下同步年齡 >1 秒標記保存降級 |
| 空間 | 啟動與運行每秒檢查；可用 <256 MiB 拒絕／停止 motion；GPS 可繼續並清楚提示部分失敗 |
| GPS 空間下限 | <64 MiB 停止所有採集並回報 storage error；不能承諾其他 App 不會先占滿空間 |
| 停止 | 正常健康 IO 目標 2 秒內完成；5 秒未完成回報 stopping timeout，保留停止中、禁止匯出／新 writer |
| 高頻資料容量 | R1 合計 ≤300 MB/h，包含 derived inputs、raw、lean、事件、診斷；正式方案也必須計入全部 |

固定佇列上限之外，所有 Map／錯誤訊息／UI 事件也需有界。不得把 GC heap 當緩衝。
500 ms／1 秒是健康排程預算；fsync 卡住時不能保證硬期限，watchdog 在獨立執行路徑
更新 UI，不同執行緒不可強制 close 仍在 IO 的 fd 或釋放 writer ownership。
同步失敗立刻停止該 writer，不盲目重試同一損壞尾端。

### 停止完成順序

1. coordinator 標記 stopping，拒絕 start／校準／匯出；重複 stop 冪等。
2. 在來源所屬 looper 停止接收 GPS／motion；記錄 cutoff，停止後排隊 callback 不再新增輸入。
3. 依有界政策處理已接收佇列與丟樣事件，關閉 lean 分段。
4. raw sync → lean sync → close；GPS／diagnostics 各自完成同步與關閉，回傳每個元件結果。
5. 全部 writer 確認已關閉後，coordinator 才宣告完成、移除錄製通知、允許匯出。
   部分失敗保留 error 與可匯出的已關閉檔案；不能顯示全部保存成功。

stop 方法完成回覆應代表上述結束，不再只是 service 已收到請求；新增 stopping 狀態與
completion/error 是平台通道公開行為，需 Dart／Kotlin／Swift 相容修改及測試。
iOS 尚無 motion 時不假造 writer；未知可選欄位安全降級。state 遷移不直接改 location-log 格式。

## 5. 恢復與匯出

保留現在 raw-before-lean durability barrier。它不是跨檔原子交易；系統仍可能在不同追加點終止。
恢復先只讀掃描所有相關檔案，再決定是否可追加，不邊掃邊修到一半才發現另一檔損壞。

- 完整前綴無誤、只有未完整尾行：按契約截斷未完整尾行、記 log_truncated、續接序號。
- 完整行 JSON／身份／序號異常：原檔保留，禁止該串流追加；不跳過壞行假裝修復成功。
- lean 引用校驗包含 recordingId、sourceId、boot、first／last 存在、時間、epoch 與缺口。
  不只用最後 counts 判定。歷史引用索引在磁碟上建立，讀寫過程記憶體有界。
- 完整 lean 行引用失效：保留 raw／lean，標記 motion 恢復失敗，GPS 可獨立恢復；
  要重算則寫新衍生檔，不能刪掉完整壞行再稱原始資料合法。新衍生檔識別／關聯先由契約定義。
- 同 boot 程序恢復仍重新校準；跨 boot 不沿用校準與最大值；boot 判定不另建第二套。
- 尚未知的完整 recordType 消費端須保留；writer 若不能安全續接可拒絕追加，不能破壞前向相容資料。

UI 更新改用 memory summary（最後樣本、數量、age、來源狀態）；不再輪詢整檔 readLog。
匯出已關閉檔案以路徑／串流，既有 motion XFile 分享保留；如需外部暫存副本，預檢空間、
使用 64 KiB buffer、暫存檔完成後再交付，取消只刪本次暫存副本。
歷史讀取／驗證在背景工作執行，不占 GPS writer 或 UI thread；不宣稱接收端已成功保存檔案。
舊 readLog 通道先保留相容，但 App 不再用它讀大檔；提供有界 reader／摘要再另訂淘汰時間。

## 6. 正式驗證器的有界設計（交契約主筆）

要求保留既有錯誤／警告語義與 CLI 可判斷的非零失敗碼，不能只驗 schema。
建議用磁碟 B-tree／SQLite 索引；Node 22 的實際 minor／driver 需由擁有者鎖版，
不可默認所有 Node >=22 均提供相同 sqlite API。若選 external sort 也須滿足同一語義。

1. byte stream 解碼逐行讀取、保留 byte offset／行號。對超長單行設明確資源限制，
   超限回報 capacity failure（非成功／非隱藏略過），不私自宣稱契約最大行長。
2. 依 `(recordingId, sourceId, sequence)` 保存原始 offset 與 canonical comparison 資訊；
   duplicate／conflict 必須可辨識，hash 只當索引候選，必要時回讀比較，不以 hash 相同就視為相同。
3. 來源宣告、clock map、boot、break、epoch、calibration、estimate、extremum 皆帶行位置索引。
   配對查驗使用**引用所在 session 的宣告**，不可用整檔最後一個 storageStride 覆蓋早期 session。
4. 兩階段：motion 完整建索引並驗證，再逐行 lean 配對；區間查詢檢查來源缺口及 epoch，
   extrema 回查指定 estimate；多 recording／boot 不混用。
5. findings 即時串流完整報告到檔案；記憶體只留前 100 筆與精確總數。
   既有 --json 輸出結構的相容策略由主筆定義；不得悄悄截斷 findings。
6. 暫存放使用者指定的私有目錄；磁碟滿／取消／無權限有明確 error，清理本次暫存，保留輸入。
   索引可能含敏感資料，不上傳、不進 Git；預檢可用空間且運行中持續檢查。
7. 小檔同一 fixtures 比對舊／新結果；大檔用 2 GiB 合成輸入，含合法、尾行損壞、
   長距離重複／衝突、跨 session 策略變更、dangling refs、反覆校時、極多 findings。
   驗證 R1 的 256 MiB RSS 目標；記錄暫存占用與耗時，不以提高 heap 上限解決。

## 7. 傾角與校準的實作入口

保留受限實驗顯示，但正式模式必須另走 R1 L03～L06。D1 不承諾某種濾波器能解決
所有道路動態；加速度比力不能直接當動態世界向上，平台姿態也不是獨立參考。

優先修正可確定的結構問題：

- 修正 gain 用 `1-exp(-dt/tau)` 的時間權重，版本化 tau，而非每 callback 固定 1%。
- 只有已知可信的停車窗口估計 gyro bias；單靠 norm 接近 g 不足以認定車輛靜止。
  bias 數值／來源／有效時域必須可重播，不能只留記憶體。
- 連續無可信修正超過設計容許時間即停止正式輸出；此時間從 bias 不確定性與誤差預算推導，
  第 3 階段先用合成 bias sweep 固定數值，不任意宣稱 v4 已消除漂移。
- 對傾角突變、支架移動與高動態保留失效路徑；限幅／平滑只能改善顯示，不能把錯值變成有效值。
- 平台姿態、gyro、accel 跨來源事件順序需決定性；重播使用保存順序及控制事件，不按 UTC 重新排序。
- 自動直立與手動校準分別驗證；校準證據不完整時不能開啟正式 extrema。

參考方案先用獨立傾角治具驗證靜態，再以經確認精度與同步方式的外部參考量道路；
未選定／取得參考設備前，L03～L05 保持 blocked。這不阻止資料管線的合成測試與降級 UI 修正。
不在本階段要求購買設備或安排騎乘。

## 8. 第 3 階段切片與共同定案條件

| 切片 | 交付／必要驗證 | 依賴 |
|---|---|---|
| S1 | 停止 coordinator、關閉後匯出、即時小摘要；測試慢 IO、部分失敗、重複 stop、UI 重開 | Codex 範圍；平台通道相容設計 |
| S2 | 通用選樣、品質轉換不遺失、四種頻率統計、移除型號除數 | 新 policy／控制事件由契約定案 |
| S3 | 正式逐行＋外存索引驗證器、fixtures 與 2 GiB 合成驗證 | Claude Code 的 contracts/tools |
| S4 | 完整跨檔恢復、容量限制、raw-before-lean 失敗注入矩陣 | S3 與契約對恢復／衍生新檔的決定 |
| S5 | derived-input 抗混疊／決定性重播、校準證據、bias／可信度失效 | 契約新型別與合成帶寬／bias sweep；實機精度另驗 |

失敗注入至少覆蓋 raw append 前／中／後、raw sync、lean append 前／中／後、lean sync、
close、容量檢查、producer 停止與 drain 邊界。每個案例斷言序號、引用、檔案保留及 UI 狀態，
不是只斷言方法被呼叫。

本階段 Codex 設計及對契約擁有者 8832561 回覆的復核已完成；
品質旗標、時間選樣 policy、derived-input／重播範圍、控制／校準證據、恢復識別與驗證器方向
依 F2 最終復核接受，C1 必須落實其驗收條件；未量測的 S5 格式／係數保持候選。
完整協作 prompt 見 [CONTRACT_RELIABILITY_REQUEST.md](CONTRACT_RELIABILITY_REQUEST.md)。
本輪不寫新格式、不自動留言或替對方修改；下一階段先 S1，本輪停在設計審查交付邊界。

## 9. 參考

- [Android SensorManager](https://developer.android.com/reference/android/hardware/SensorManager)：請求頻率為提示，回呼可快可慢。
- [AOSP sensor types](https://source.android.com/docs/core/interaction/sensors/sensor-types)：比力、平台融合及感測器來源定義。
- [FileDescriptor.sync](https://developer.android.com/reference/java/io/FileDescriptor)：同步影響該 descriptor 下游 buffer；不等於多檔原子交易。
