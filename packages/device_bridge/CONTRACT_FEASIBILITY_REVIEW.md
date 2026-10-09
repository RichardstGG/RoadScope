# 第 2 階段契約回覆：手機端可實作性審查 F1

後續狀態：PR #10 `62b9bff` 的修訂復核見 [F2](CONTRACT_FEASIBILITY_REVIEW_F2.md)。
以下保留原始審查脈絡；待辦以 F2 為準。

日期：2026-10-08。審查使用者轉交的 Claude Code 設計回覆。
手機端基準 PR #11 `b5aa256`（runtime `63e1b91`）；契約 PR #10 `7474933`。
本文件是 Codex 的設計回覆，不修改共同契約、不視為新格式已獲批准。
對應 [D1](RECORDING_RELIABILITY_DESIGN.md) 與 [R1](ACCEPTANCE_BASELINE.md)。

## 1. 結論與可先定案的部分

接受以下方向：兩個品質旗標阻擋正式最大值；run 資格與平台 accuracy 分離；
通用時間選樣及品質事件；三種重播範圍；raw-before-lean 屏障；完整損壞檔保留；
有界 reader 加磁碟索引；location-log v1 不變；C1／C2／C3 分開交付。

仍有下列介面缺口，不能直接開始 C1 新格式或 S5。C2 的索引架構可以定案，
但必須修正比較語義／CLI 遷移。S1 手機端停止與即時摘要不依賴這些新格式。
本次只交付審查，不自行跨入第 3 階段。

## 2. 六項手機端問題的直接答覆

| 問題 | 答覆與限制 |
|---|---|
| accuracy callback／sample 都觸發事件 | 可實作，兩者走同一 sensor looper；目前 onAccuracyChanged 是空方法，需要新增。以收到的 callback 順序、每來源去重；callback 沒有測量時間時填 null，不能套用上一樣本時間。OS 未提供的品質變化無法保證偵測。控制事件與資料需共用次序，writer 先處理事件；保留獨立容量但不可讓兩條佇列重新排序。滿載若不能保存轉換，停止 motion。 |
| anchor 重設與 keptCount | 可實作。anchor 屬每來源 clock epoch；gap／resume 後先保存重設事件再接受新桶。keptCount 由 writer 成功追加數計算，不能用 producer offer 成功當落盤成功。空窗口、null measurement 與統計終止點需補規則，見 §4。 |
| 三來源 derived 20 Hz／稀疏 raw | 不接受直接鎖定 20 Hz。估算輸出 20 Hz 不代表 gyro 融合輸入只需 20 Hz；先保留 D1 約 50 Hz 候選，以帶寬／延遲掃描定案。raw 10 Hz 可作診斷候選，refilter=false；它是變更配置，不能偷偷套用到現有模式。容量需序列化完整 schema 後量測，不採 300 B 假設。 |
| parent prefix hash | 能用 64 KiB buffer 串流計算、記憶體有界；未量測耗時，不能宣稱可在啟動期限內完成。先封存父檔、固定長度，在背景 job 計算；GPS 不等待 hash。需進度／取消、檔案變更偵測、IO 錯誤；hash 完成前不宣告新 run 已建立。 |
| Kotlin replay 共用 fixtures | 可實作。現有 LeanReplayAssertions 已使用生產融合核心，但只涵蓋小型 synthetic raw＋既定校準，不是完整 C3 重播器。擴充需保存控制事件消費點、filter spec 與 hint 的完整因果資料；不足前 estimate/calibration/refilter 均不得擅自改 true。 |
| 私有旗標檢查 | 已在本機對現存 lean 檔做逐行專項審查；結果僅回報通過／失敗，詳細檔案與結果留 Git 忽略目錄。新驗證器尚未存在，不能聲稱跑過新契約。待新版本實作再補正式驗證。 |

## 3. 阻擋 A：版本與相容性

「rev2 可加性」不能解讀為舊驗證器可讀：已知記錄使用 additionalProperties／
unevaluatedProperties=false。最小合成檢查只加 lean_started.revision=2，
既有合法 fixture 即出現 SCHEMA_INVALID／MISSING_LEAN_STARTED。
storageStride=null 不是唯一不相容項；run 識別、序號空間、資格與 CLI 也有語義變更。

建議：motion／lean 新語義明確使用 schemaVersion=2，新工具同時讀既有 v1；
location-log 維持 v1。兩個品質旗標可在 v1 修正，列出歷史有意變更。
若主筆仍選 schemaVersion=1＋revision=2，必須明文定義這是未發布格式的協調遷移，
附「舊工具拒絕新檔、新工具可讀舊檔」矩陣、最低工具版與禁止混寫，不能宣稱完全向前相容。
未知未來 revision 不得直接用 revision>=2 套當前規則而回報完整 PASS。
一個實體檔固定格式；不能續錄時向既有 v1 檔追加新語義，新檔／新 recording 的切換要明確。

另外，「v1 新增 error 只有兩旗標」與 session 修正可改變判定互相矛盾；
請以完整有意變更清單及雙向回歸案例為準。

## 4. 阻擋 B：時間選樣、狀態順序與統計

1. session 邊界不能只把一般 clock_adjusted 當作許可改 policy；UTC 校時本身不應重設
   同 boot 的測量時間桶或容許換策略。明定 recording_resumed／新來源 session 與
   source_clock_state 的關係。參數變更只在新 session 生效。
2. 跨檔引用依所引用 **raw 樣本在 motion 檔的行位置**解析 session，不比較 lean 行號
   與 motion 行號。若 first／last 跨 session，需拒絕或明確分段，不能只選其中一個宣告。
3. high→unreliable→high 全在被略過 callback 中發生時，相鄰已存樣本仍同為 high。
   ACCURACY_CHANGE_UNRECORDED 的端點檢查無法證明沒有漏事件；必須有合成 callback 測試。
   每來源初始品質 null／unobserved 的意義、兩種 callback 去重、received 順序需明定。
4. motion 控制事件雖不佔 sample sequence，仍須可被 lean 指出「消費到哪裡」：
   提議穩定 controlSequence／control cursor，epoch 起點及 estimate 保存消費上界。
   否則相同 raw refs 對應不同品質歷史，stored_only 仍不足以重播。欄位名稱交主筆。
5. selection_stats 以不重疊窗口、明確起訖 cursor 結算。沒有保存樣本的窗口，
   first／lastSequence 應允許 null（或明訂空區間）；kept=0 不可發明序號。
   received 的定義需拆出 kept、intentional skipped、invalid、buffer dropped、尚未完成追加。
   只有同一觀測窗口完整結算才可使用加總等式；raw 已寫、stats 尚未寫就崩潰屬未結算，
   不把有效 raw 判成損壞。每次 sync 的 stats 本身也會增加容量。
6. clock 未驗證時 D1 的 received-time 診斷選樣與 first_verified_measurement 不同，
   需定義 initial unverified 分支／政策，measurement 保持 null；不可用假 anchor 混過。

## 5. 阻擋 C：lean_input 與衍生 run 的識別／時間

衍生輸入放 lean 檔可實作，但既有 lean 全部非事件共用單一序號空間與事件 lastSequence。
加入 per-source lean_input 後，需同步定義：

- 每種 recordType 的 sourceId／序號；事件 lastSequence 指哪個串流，或改成 lastSequences；
  log_truncated／recording_resumed／estimator_reset.initialInputs 的跨 stream 表示。
- 一檔一 leanRunId；新 run 必須是另一檔，明示路徑命名／manifest，不能與舊 run 混寫。
  runId 必須進所有可跨 run 的引用／索引鍵，或由不可變檔案 header 綁定並禁止單行脫離上下文。
  lean_input 與估算同檔時，先追加輸入再估算；查驗禁止 forward refs、跨 boot／run refs。
- derived input 的宣告／filterSpecId 需先存在；原 raw inputSourceIds 不能再假定全都在 motion。
  任一品質 null 對 worstAccuracy 的規則要明確；未知不可被 high 蓋掉。
- 因果濾波 supportTo 是最新支撐時間，不一定等於訊號有效時刻。若選它當 measurement，
  必須保存／解釋群延遲並以相同時間慣例比較；不同源不同延遲不能直接融合。
  IIR 的無限歷史不能用短 support range 假裝完整；需 filter epoch／reset 狀態。
- quaternion 需 q／-q 等價與重新正規化規則，不能逐分量套 scalar filter 而宣稱姿態有效。
- coefficients SHA 只辨識內容，不提供重算內容。要 refilter=true，必須有可解析的不可變
  filter spec／係數、初始狀態、版本與完整 raw；離線拿不到係數只能 false。

容量：暫不接受把融合輸入降成 20 Hz 以配合上限。先以完整字段序列化，計入三來源、
runId、refs、控制／stats／filter events、lean 與診斷；比較 raw 10／50 Hz 與 derived
候選 20／50 Hz。數值合格也不等於頻寬合格。若都不符 R1，先修改設計，不壓縮欄位語義。

父 run hash 可接受，但 parentLastSequence 在完整損壞或 per-source 情況下可能不可判定；
允許 unknown 或定義 verified-prefix 的每來源上界。parentByteLength／hash 明確指封存父檔
的哪個不可變 byte prefix，不能藉排除壞行令 failed 父檔看似 passed。
「最新驗證通過 run」需另辨識資料涵蓋時段與未完成狀態，不能把部分重算誤當全行程結果。
raw 完整損壞後停止 motion、GPS 繼續可在本階段定案，不必先新增 C4。

## 6. 阻擋 D：重播／資格的資料完整性

lean_hint 目前提議的欄位不夠。AutoUprightReference.updateFix 使用 boot、measurement time、
clockVerified、speed、horizontalAccuracy、speedAccuracy、heading、headingAccuracy；
還受 hint 消費時機與 motion 輸入順序影響。要 calibration=true：

- 全部已消費且影響決策的值／拒絕與重設都可重現，包含無效 hint；不能只保存成功候選。
- gpsRef 需 recording／boot／source／sequence 的足夠身份；可引用 location 的已有欄位，
  但要定義引用所需的 --location 輸入及缺失時「未驗證」結果。
- 保存 hint 與 motion／derived input 消費順序的邊界；不是只保證 hint 排在 calibration 前。
- 人工命令窗口、演算法參數與 motion 證據也屬校準重選輸入。未保存前 calibration=false。

現有未驗證 manual calibration 帶 sensor_accuracy_unreliable，估算另帶
calibration_input_unverified。若只檢查「校準本身有 calibration_input_unverified」會漏掉舊格式，
需將兩旗標的校準污染傳遞規則明訂；來源恢復 high 不能自動洗白舊校準。

qualification 的 coveredInputPolicies 只有 kind＋policyVersion 不足：相同 kind/version 可有
不同 period、filter spec、來源與安裝條件。請用不可變 configuration fingerprint 或完整配置，
綁 algorithmVersion、filter spec、rate、sensor／mount 適用條件。qualificationRef 可用不含個資的
本機證據 UUID；檔案宣告 qualified 只是宣稱，驗證器不查私有證據便不能證明資格真實。
UI／結果層須區分宣告資格與本機已核驗資格。未核驗保持實驗顯示，不輸出正式最大值。

## 7. 阻擋 E：驗證器語義與 CLI 遷移

SQLite 同一邏輯、固定 page cache 與完整 findings 串流方向可接受，尚未驗證 driver／效能。
以下需修正後才能當作 S3 規格：

- duplicate／conflict 保留現有 canonical JSON 比較，不是 raw bytes 相等。合成檢查已證明
  同值不同 key order 判 SEQUENCE_DUPLICATE。索引可存 canonical hash＋offset，命中回讀並
  canonical 比較；byte comparison 只能快速路徑，不能改成欄位順序不同就 conflict。
- 序號鍵需包含 leanRunId／stream 的新作用域；hash 碰撞不可影響正確性。
- --tmp-dir 從無要求變成必填會破壞現有 CI／使用者命令；保留安全預設 mkdtemp，
  允許顯式私有目錄覆寫。若堅持強制，需同版更新所有呼叫者，明列 CLI breaking change。
- --json 截斷是行為變更。建議小檔保持完整既有格式，新增 opt-in summary/report mode；
  完整模式也可串流 JSON findings 以維持有界記憶體。若採新格式，提供版本／呼叫者遷移，
  無 findings-out 時不可讓第 101 筆以後診斷無處可查。
- 224 MiB watchdog 中止只代表 capacity failure，不代表通過 256 MiB 目標。2 GiB 合法與
  最壞案例須完整完成，精確分類，不以提早失敗達成峰值限制。
- <32 MiB 用 :memory: 也要量測索引膨脹；跨多檔總量與全流程 RSS 才是 budget。
- statfs 容量預估不是保證；SQLite ENOSPC、findings IO 失敗、取消、cleanup 失敗要回報。
  SIGKILL 不能保證清理，重啟僅清理能確認屬自己的過期暫存；保留輸入與已指定 findings。
- nightly／dispatch 可承擔常態大測，但首次 S3 宣告完成前必須實際跑完大檔案例；
  PR 快速 job 至少涵蓋同一磁碟索引 code path 與小檔差異測試。

## 8. 檢查範圍與下一步

- static validation：原始碼與 schema 查核；兩個最小合成檢查確認舊工具拒絕 revision
  及 canonical duplicate 語義；不是新格式的驗證。
- static validation（私有）：兩個阻擋旗標與 extremumEligible 的逐行專項；只回報 pass/fail。
  新版完整驗證器不存在，不能替代新 schema／跨檔驗證。
- automated / mock / hardware tests：本輪未改 runtime，未重跑產品測試、未操作手機。

請契約擁有者先修訂 A～E 的設計，提供相容矩陣與 fixtures 預期；不需要先實作大規模
schema／驗證器。Codex 完成手機端可實作性復核後才把第 2 階段標為共同定案。
