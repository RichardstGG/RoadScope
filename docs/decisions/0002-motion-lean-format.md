# 0002：motion／lean 紀錄格式決定

日期：2026-10-06
狀態：契約草案，待 Codex 確認原生可實作性（未經使用者逐項拍板的選擇標為「提案」）
影響路徑：`contracts/motion-lean/`、`testdata/contracts/motion-lean/`、`contracts/tools/`、`packages/device_bridge/`（待 Codex 實作）、`packages/mobile_data/`（待匯入介面）
相關：PR #9（手機基底）、`mobile/lean-foundation`（Codex 傾角基礎，未提交）、0001（location-log）

## 背景

使用者批准傾角功能開發：量測機車相對垂直的左右傾角，手機固定在車架／車把（可能橫放、直放、斜裝）；手動靜止直立校準優先，另以左傾方向確認辨識側傾軸；未手動校準時只由行進中穩定直行區段累積建立自動參考；校準更新建立分段並保留舊資料與每段最大值；即時顯示，原始與衍生分離，可與 GPS 依測量時間對齊。Android V1.0 基礎功能／UI 真機通過前暫緩 iOS 真機。

## 決定

### D1 兩個獨立檔案，不進 location-log
原始 motion 與衍生 lean 各一個 NDJSON，recordType 各自命名（`motion_*`、`lean_*`），沒有任何一行使用 location-log 的 `sample`／`event`。location-log v1 不加任何欄位、事件或旗標。
理由：location-log 的 `sample` 要求 WGS84 座標；把非定位資料塞進去違反「不把非定位樣本混入定位 sample」。location-log §4 已規定未知 `recordType` 原樣保留，舊匯入器因此自然容忍新檔（fixtures 強制）。

### D2 原始與衍生的界線
motion 只放平台給的量測與時鐘／缺樣事件。傾角、校準、最大值全在 lean。重新計算寫新 lean 檔，不改寫舊檔。理由：工程規則 §2.7；自動參考更新不得追溯改寫。

### D3 測量時間只用單調時鐘；UTC 是映射
樣本不帶「測量 UTC」，只帶 `measurementMonotonicUs`（Android：`SensorEvent.timestamp` ns ÷ 1000 捨去）。UTC 由 `clock_map` 事件（偏移＋來源＋寫入端宣稱的不確定性）提供，映射更新不追溯。與 GPS 對齊用 `(deviceBootId, measurementMonotonicUs)` 直接比較，不經 UTC。
理由：location-log §3 已確立「接收時間不得當測量時間」，且單調時間含睡眠、不受時鐘調整影響；感測器沒有平台提供的測量 UTC，硬寫一個就是偽造精度。iOS 的 Core Motion 時間域未驗證，`measurementClock = unverified`，不宣稱。

### D4 缺樣不佔序號（與 location-log 不同）
高頻感測樣本在有界緩衝滿載時被丟棄，這些樣本從未被指派序號；缺口以 `samples_dropped` 帶測量時間範圍表達。理由：location-log 的序號缺口意味「資料遺失」，需要事件佐證；感測器丟樣是常態，若讓序號出現缺口會使 `SEQUENCE_GAP` 失去訊號。序號缺口因此只可能來自尾行截斷。

### D5 事件用 `lastSequences` 映射
motion 檔有三個感測器、各自序號空間，而檔案層事件（截斷、續錄、boot 變更）對全部來源生效，所以事件的 `lastSequences`／`resumedSequences` 是 `sourceId → 序號` 的映射，不是單一整數。

### D6 傾角定義與符號
`leanAngleDeg ∈ [-90,90]`，負＝左傾、正＝右傾。以 `upDevice`（直立向上軸）與 `leanAxisDevice`（側傾軸，⟂ up）定義 `atan2((u0×u')·a, u0·u')`，符號由「左傾確認」固定。沒有左傾確認也沒有繼承的軸時傾角為 `null`，不顯示假角度。安裝方位（橫／直／斜）完全由這兩個向量吸收，原始資料不做任何 remap。

### D7 校準＝分段；最大值為追加記錄
一個校準一個分段；每段左右最大值各自保存，舊段永不被覆蓋。最大值以 `lean_extremum` 追加（不遞減），`lean_segment_closed` 為可選的摘要，崩潰後可只靠 extremum 還原。新校準只能在已寫出的所有估算之後生效（不追溯）。校準只對產生它的 boot 有效，跨 boot 沿用是明確的 `carried_over` 並帶未驗證旗標。

### D8 最大值規則記成資料（提案）
`lean_started.extremumPolicy` 宣告 `min_abs_in_same_side_window` 與 `minWindowUs`（Codex 起始值 100 ms）。規則與數值屬演算法版本，不寫死在契約；契約只強制「峰值必須對應一筆合格估算、窗口夠長、不遞減」。該規則尚未與動態參考比較，不代表真實最大傾角準確度。

### D9 型別策略
沿用 0001 D8：JSON Schema＋fixtures，不生成模型。驗證器新增 `contracts/tools/validate-motion-lean.mjs`；lean 與 motion 的跨檔規則（來源關聯、時間、缺口）只在配對模式檢查。

## 後果

- Codex 的 Android 寫入端必須輸出可通過 `validate-motion-lean.mjs` 的檔案；iOS 暫不輸出。
- `mobile_data` 需要之後新增 motion／lean 匯入介面（Claude Code，待 P0 交接生效）。契約已把消費端規則寫在 README，匯入器依 fixtures 對齊。
- 高頻原始檔的儲存量約 180 MB／小時（50 Hz×3，全存），見契約 §11.5 與待 Codex 確認問題 3。

## 未涵蓋

任何量測準確度、動態姿態融合品質、自動校準的候選篩選門檻、iOS 時間域、真機行為。
