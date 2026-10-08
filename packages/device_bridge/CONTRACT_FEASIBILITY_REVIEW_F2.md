# 第 2 階段契約修訂復核 F2

日期：2026-10-08。契約 PR #10 `62b9bfffa06871094331ba55caf8d07076d99b33`，
手機 PR #11 `13b68a3`，runtime `63e1b91`。
本文件復核 `docs/decisions/0003-motion-lean-reliability-r2.md`；取代 F1 的待辦狀態，
不取代共同契約。證據為 **static validation**，沒有新增 runtime、schema 或 fixtures。

## 1. 結論

A～E 大部分方向已可接受。剩餘三項修訂見 §3；第 2 階段尚未共同定案。
不需重新開啟已解決議題，也不要求先實作完整驗證器。

已接受：schemaVersion 2 與禁止混寫／跨版追加、session 與 raw 引用解析、
品質觀測保證的界線、控制 cursor、成功追加計數、未結算窗口、received-time 選樣、
每串流序號、一檔一 run、父檔前綴與部分覆蓋、raw 完整損壞後封存、
濾波支撐時間與有效時間分離、IIR 狀態紀元、四元數專用處理、refilter 必要資料、
資格宣告與本機核驗分開、canonical 比較、CLI 完整輸出與有界外存索引。

## 2. 對本輪五個請求的直接答覆

1. B3 合成 callback 測試列入 S2：先建立 high 狀態，再讓被略過的 callback 發生
   high→unreliable→high，斷言兩次轉換被保存（初始 unobserved→high 另計）。
   accuracy 與 sample 回呼使用同一 sensor looper、共用去重狀態，資料與事件共序可實作。
   目前尚未建立 v2 事件寫入路徑；此輪是設計審查，不用測試替身假裝已驗證產品實作。
2. keptCount 與 controlSequence 均可由單一 writer 在完整行追加成功後更新。
   追加成功不等於 fsync 耐久；半行／sync 失敗時停止該寫入路徑，恢復由有效前綴重建，
   不在同一已損壞尾端繼續遞增或重試。實際失敗注入留 S2／S4。
3. C.7 算術方向符合預期，但結論僅適用其草稿行長與配置，不是所有三串流格式都不可能。
   同意把聯合 frame 列為 S5 正式比較候選；不鎖 frame／20 Hz、不提高 R1 預算。
   序列化須包含完整 ID、refs、所有事件及診斷。S5 需定義來源時間對齊／過期／缺值規則，
   不能僅取 max(validAt) 就宣稱完成對齊；資訊可得時間不得早於任何被使用輸入。
   濾波與聯合 frame schema 在合成帶寬／延遲／容量比較前保持候選。
4. hint 已涵蓋 AutoUprightReference.Fix 的值，但尚未涵蓋 LeanPipeline 的呼叫開關，見 §3.1。
5. estimate／calibration／refilter 在各自必要資料與 Kotlin 決定性測試完成前均維持 false。
   書面可實作性、schema PASS 或 qualificationRef 存在都不能替代重播／精度證據。

## 3. 尚需修訂的三項

### 3.1 自動校準的啟用／暫停也是重播輸入

來源：`LeanPipeline.kt` 的 rideFix、control 與 consume。
rideFix 只在 available、非 experimental、無 mount／calibration 且 command=idle 時呼叫 updateFix。
automatic.add 另受 pendingAutomatic 及 epoch 起點後一秒的條件控制。
control(upright／left) 會 reset 並進入手動收集；cancel 也 reset，但回到 idle。
因此相同 reset＋motion＋已消費 hint，不能單憑 reset 判斷之後是否應呼叫 automatic.add。
尚未完成的手動動作尤其沒有 lean_calibration 行可供推知。

接受「手動校準結果是記錄輸入，不承諾重算」；但手動動作對**自動**決策的暫停不可省略。
建議新增自動參考控制狀態事件（名稱由主筆決定）：初始狀態必記、每次狀態變更必記，
包含 enabled／suspended／disabled、原因及 afterInputs 消費邊界。
同邊界多個 hint／reset／控制事件依 lean 檔出現順序處理；說明狀態事件與 reset 的前後次序。
可由版本化演算法及完整輸入重算的 pending／epoch 條件不必重複保存，
但所有外部開關必須可判定；否則 calibration=false。

必要案例：相同 motion 與 GPS，路徑一直接 idle，路徑二中途 upright、尚未完成即 cancel；
後者暫停期間不得累積自動候選，恢復邊界後按規則重新累積。
缺少初始狀態／轉換卻宣告 calibration=true 必須拒絕。
這不要求保存整套手動校準證據，也不擴張為重算手動校準。

### 3.2 v1 有意變更與回歸預期需符合程式

- D.3 的 ESTIMATE_CALIBRATION_TAINT_DROPPED 不只影響 eligible=true：
  污染校準＋估算 eligible=false 但漏 calibration_input_unverified，也違反新規則。
  CARRIED_OVER_TAINT_DROPPED 同樣是額外的歷史收緊。請在 A.3 獨立列出、
  明定 sensor_accuracy_unknown 是否只屬 v2；若回溯 v1，也列入相容差異。
  先前私有專項只檢查估算自身兩旗標與 eligible，不能視為新污染傳遞規則已全數通過。
- A.3 V1-4「新 exit 僅 v2 使用」不符合 E.3：v1 也可能遇到 IO／容量／環境錯誤或取消。
  分開列檔案語義與工具執行錯誤；不可為了保留該敘述而把 v1 執行失敗報 PASS。
- F R-02 不能預設舊工具漏報。7474933 的 motion 宣告先以 Math.max 累積全檔 stride
  （validate-motion-lean.mjs:391），配對時以該值檢查並每來源只報一次（874–877）。
  同來源早期 stride=1、後期=2，舊工具仍看到 2；可能在錯誤 session 報出，並非必然完全漏報。
  改為記錄舊工具實際 error／行位置，再斷言新工具僅依被引用 session 判斷。
  保留 2→1 與 1→2 兩種方向，但不強造「舊 PASS、新 FAIL」。
  增加兩個污染案例：eligible=false 但漏傳旗標、carried_over 丟旗標。

### 3.3 v2 policy 與 stride 只能有一個解釋

B.5 同時容許 storageStride≥1、且缺 inputPolicy＝全部保存；這讓 stride=2 且無 policy
有兩種解讀，也可能讓 refilter 的非 lossy 判斷失真。
建議 v2 固定兩種合法組合：

- 全存：inputPolicy 缺省，storageStride=1。
- 時間桶選樣：inputPolicy=time_bucket_first 且 lossy=true，storageStride=null。

其他組合一律 STRIDE_POLICY_CONFLICT。v1 的舊整數 stride 保留在 v1，
不必為已決定移除的型號除數增加 v2 模式。
請用合法／非法案例覆蓋兩種合法組合，以及缺 policy＋stride=2、存在 policy＋stride=1／2、
缺 policy＋null；不要只測最後一種。

## 4. 驗證與下一步

- static validation：比對 PR #10 實際 62b9bff 文件與 PR #11 原始碼；核對上述控制條件與
  7474933 的 stride 累積／錯誤去重。這不是執行新版回歸測試。
- automated tests：本次只改審查文件，未重跑產品測試；修改前 PR #11 13b68a3 的 Android／iOS CI 成功。
- mock tests／manual tests／hardware tests：本輪未執行，未操作手機。
- untested：v2 寫入、所有新 fixtures、2 GiB／256 MiB、S5 頻寬／容量／延遲與硬體精度。

請契約主筆只補以上三項設計、對應 fixtures 預期，回覆提交後再復核即可。
不要求先開始 C1／C2／C3。S1 仍是共同定案後第一個手機端實作切片；
此輪完成 F2 審查交付後停止，不自行跨入第 3 階段。
