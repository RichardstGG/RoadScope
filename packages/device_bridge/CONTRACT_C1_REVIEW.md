# C1 手機端可實作性與參考驗證器復核

## 修正復核：8f2a123（2026-10-08）

核對遠端 `8f2a1238febc7e8c9acd922c882aeaa7c6d25f5b`。獨立固定副本重跑成功：
21 location fixtures、242 v2 檔案一致、321 motion／lean 檢查；原本三個突變全部被拒絕。
**C1-1、C1-3 關閉；C1-2 直接路徑已修正，但恢復路徑仍有一項阻擋。**
下方原始審查保留歷史，最新狀態以本節為準。

### C1-2 恢復時不能清掉漏存的歷史（P1）

`applyAutoState` 的 `else if (!state.unavailable) auto.owed = null` 允許恢復後的 enabled
直接清掉先前中斷欠下的 reset／disabled，即使那些事件從未保存。
重現順序：initial enabled → estimator unavailable → estimator available → 新 estimator epoch
→ auto enabled(estimator_available) → hint；中間沒有 auto_reference_reset／disabled。
宣告 calibration=true 後仍回報 ok=true、零 findings。
也已以新增的非法 13c fixture 加一筆恢復 enabled 重現，並非依賴舊 fixture 的特殊格式。

請讓待補轉換只由正確的 reset＋disabled 事件完成，不能由後來 enabled、其他 reason 的
狀態或新的 lean_started 靜默清除；一旦跨過合法邊界仍未補齊，就保存不可撤銷的違規結果。
請一併以狀態表測試正常中斷／恢復、漏 disabled 後再 enabled、錯誤 reason、resume／重新
宣告與 EOF，區分「目前條件恢復」與「先前控制歷史完整」。不需要改變已接受的契約方向。
更新後的 bin/review_c1_contract.mjs 包含第四個恢復反例；對 8f2a123 為三項拒絕成功、
一項誤通過，exit 1。此缺口修正前 C1 仍不作為 S2／C2 已驗收基準。

### 對兩個手機端問題的確認

- static validation：runtime 63e1b91 的 LeanPipeline.interrupted() 明確呼叫 automatic.reset()，
  同時清除 pendingAutomatic／pendingManual。接受 unavailable 中斷前後必須保存 reset 的規則。
  這不是 v2 writer 已實作或真機已驗證；實際指令／中斷注入仍列手機端測試。
- 接受一個 qualified run 的單一配置必須匹配 motion 每個 session 的嚴格限制。
  若該 recording 改變採樣 policy 或來源可用性，不能靠另開 lean run 逃過全檔條件；
  維持 experimental，或使用者新開 recording 後再驗證資格。S2 不自動宣告 qualified，
  因此不阻擋目前寫入端設計；未來若需分段資格，須另提契約變更，不能暗中放寬。

本輪 automated tests 與 static validation 如上；manual／hardware tests 未執行。
未讀私人紀錄，未改契約與 runtime。下一步只需修補剩餘的 C1-2 恢復狀態追蹤；S1 仍獨立可做。

---

2026-10-08；審查提交 `c47e91a17a99f6c69786a38bef1df46e6b08db53`，
分支 contracts/motion-lean-v2-c1，base PR #10 `967d954`。本次核對時尚無 C1 PR。
Codex runtime 仍為 `63e1b91`；本輪不改手機程式或他方契約。

## 結論

契約方向可實作，但 **C1 暫不驗收，S2 尚不可據此開始寫入**。
既有測試全數通過；額外三個合成反例卻均回報 ok=true、零 findings，需先修正參考語義，
避免 C2 外存引擎把錯誤結果當作基準。這不阻擋獨立 S1，也不重開已完成的設計方向審查。

## 三項具體問題（皆 P1）

### C1-1：未來 anchor 可繞過時間桶檢查

`contracts/tools/validate-motion-lean.mjs` 的 applySelectionAnchor／checkSelection
（c47e91a 第 609、773 行）：只有 t>=anchorUs 才檢查桶，較早樣本直接略過而不報錯。
以合法 01b-time-bucket-minimal 為基底，將 anchorUs 改成 2000000000，
三個保存樣本放在 1000000000、1000001000、1000002000（同一 20ms 桶），仍通過。

請拒絕 anchor 之前的樣本、核對 anchor 與宣告起點／重設原因；任意重設 anchor
也不可用來規避每桶最多一筆。新增過早樣本、未來 anchor 及無合法邊界重設的案例。
錯誤碼由契約主筆定義，但不能靜默跳過。

### C1-2：先 enabled、後 unavailable 的 hint 仍通過

applyAutoState 只在寫 enabled 當下檢查 state.unavailable；applyHint（第 1155 行）
不檢查它。以合法 05a-auto-reference-never-suspended 為基底，在 initial enabled
之後、第一個 hint 前加入合法 estimator_state(unavailable)，再宣告 calibration=true，
仍通過且無 CALIBRATION_REPLAY_STATE_INCOMPLETE。

這是檔案已提供的阻擋訊息，不是「未記錄的外部指令無法辨識」之限制。
請在 hint 消費處檢查目前可用性，追蹤必需的有效狀態轉換；已知阻擋下不能因舊 enabled
而接受 hint。違規要影響 calibration replay 判定。增加兩種事件順序與恢復後案例。

### C1-3：資格配置可引用不存在的來源

applyLeanStartedV2／finishLeanV2（第 1072、940 行）未核對配置 inputs 與 inputSources
集合相等；逐 session 查不到 decl 時直接 continue。
合法配對案例 04-qualified-config-matches-declarations 中，把 qualifiedConfiguration
唯一來源改為 undeclared-sensor，重算正確指紋，保留實際 inputSources／motion 不動，仍通過。

請核對來源集合的完整性、唯一性與實際宣告；不得用略過不存在來源代替驗證。
新增缺少／額外／重複／錯誤來源的案例，應報 QUALIFIED_CONFIG_MISMATCH 或明訂的錯誤。
這不是要求查驗私有 qualificationRef，而是檔內配置綁定本身必須正確。

## 對交付差異的答覆

- 接受漏存外部 reset 由 Kotlin 注入指令歷史與錄製／重播比對驗收；單靠輸出檔確實無法
  證明每次呼叫都被保存。仍須保存每次 reset，不能拿 validator PASS 當成完整證據。
- 接受 experimental 原生模式的完整性由 writer 測試承擔；與 qualification.status 的
  experimental 不混用。已在檔內可見的 unavailable 必須由 C1-2 捕捉。
- 全存來源的 ACCURACY_CHANGE_UNRECORDED 檢查縮限可作已揭露的 validator 限制，
  不撤回 writer 對所有來源保存已觀測轉換的義務（accuracy callback 不一定伴隨 sample）。
- 接受 inputSources、lastSequences／resumedSequences、每行 leanRunId 的 v2 變更；
  不回寫 v1。接受必填 qualification、額外錯誤碼與 C1／C2／C3 範圍拆分。
- gpsRef 暫不核對可接受，但不得聲稱已做 GPS 交叉驗證；三種 replayScope 仍按原門檻維持 false。

## 驗證及重現

在固定 c47e91a 的獨立暫存副本安裝 lockfile 依賴，未切換或寫入 Claude 的 checkout。

- automated tests：npm test 成功，21 location fixtures、199 v2 檔案一致、293 motion／lean 檢查。
- automated tests（審查反例）：三個合法 baseline 全通過；三個非法突變亦全通過，表示三項拒絕斷言失敗。
- static validation：版本差異、v2 README／schema、參考驗證器與手機端呼叫條件。
- manual／hardware tests：未執行。私有 V1-4／V1-5、大檔資源、S5 量測仍 untested。

可重跑 [review_c1_contract.mjs](bin/review_c1_contract.mjs)：

```bash
node packages/device_bridge/bin/review_c1_contract.mjs /path/to/c47e91a-checkout
```

參數目錄需先安裝 contracts/tools 的 lockfile 依賴。腳本只讀公開合成 fixtures，
不改契約，不讀私人紀錄；任何非法案例誤通過即 exit 1。這不是完整契約測試替代品。

使用者不需要操作手機或自行重跑。本輪停在 C1 審查交付。
下一步：契約主筆修正三項並補 fixtures；Codex 下一個手機開發切片仍為 S1。
建議修正後以 contracts/motion-lean-v1 作 C1 Draft PR base，明示依賴 PR #10，
待 #10 合併再調整 base；不建議把這批差異繼續混入 v1 PR。本輪不代開、核准或合併 PR。
