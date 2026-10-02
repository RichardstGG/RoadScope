# RoadScope 共同工程規則

本文件是 Codex 與 Claude Code 的**唯一共同規則來源**。`AGENTS.md` 與 `CLAUDE.md` 只做入口指向，不重複維護內容。

規則有衝突時，優先順序：**使用者最新明確指示 > 本文件 > 角色說明（03／04）> 規劃文件（01／02）**。實際專案狀態（原始碼、測試、git history、遠端）優先於任何舊交接敘述。

## 1. 閱讀順序

| 順序 | 文件 | 對象 |
|---|---|---|
| 1 | `01-master-plan.md` | 雙方 |
| 2 | `02-contract-draft.md` | 雙方 |
| 3 | 本文件 | 雙方 |
| 4 | `03-codex-brief.md` | Codex |
| 4 | `04-claude-code-brief.md` | Claude Code |
| 5 | `USER_AGENT_PREFERENCES.md` | 雙方 |
| — | `05-mac-iphone-checklist.md` | 協助測試的朋友 |

## 2. 產品紅線

以下為跨文件反覆聲明的硬性約束，任何 PR 不得違反：

1. **計時在裝置本機完成**。禁止以伺服器收包時間、網路時間或 UI timer 作為穿線／圈速依據。
2. **第一版不依賴登入或網路**。帳號或後端失效不得阻止本機記錄與計時。
3. **正式計時演算法單一維護者為 Claude Code**，以純 Dart 在裝置本機執行。Codex 負責 UI、原生整合與客戶端，不維護第二套計時演算法；參考核算工具只核對明確案例。
4. **不先建置**：軌跡雲端同步、聊天、排行榜、微服務拆分、Redis／多實例。
5. **採樣／儲存／傳輸三種頻率分開設定**。重送舊樣本不得冒充新定位。
6. **記錄狀態與分享狀態獨立**。加入車隊不等於同意上傳；App 重啟預設不自動恢復分享。
7. **無效值用 null＋品質旗標**，不用 0 冒充；原始資料與過濾結果分開保存。
8. **不宣稱未驗證的精度**。沒有參考設備比較前，只能宣稱重播一致性與邏輯正確。

## 3. 檔案擁有權

修改他方擁有的路徑前，必須先提出明確協作請求並取得同意；不得為了讓自己的測試通過而直接改對方的假設。

| 路徑 | 擁有者 |
|---|---|
| `apps/mobile/` | Codex：UI、App 組裝與平台入口；不在此重複實作計時／資料核心 |
| `packages/timing_core/` | Claude Code：純 Dart 計時與決定性重播 |
| `packages/device_bridge/` | Codex：Android／iOS 原生採集、單一寫入者與平台通道 |
| `packages/mobile_data/` | Claude Code：原生紀錄匯入、行程資料、恢復與匯出；P0 既有實作由 Codex 完成真機驗證後交接 |
| `.github/workflows/mobile.yml` | Codex：只驗證 `apps/mobile/` 與 `packages/device_bridge/`；PR #2 需在交接前移除 `mobile_data` 測試步驟 |
| `.github/workflows/dart-core.yml` | Claude Code：在 contracts v1 PR 建立，驗證 `packages/timing_core/` 與 `packages/mobile_data/` 的 `pub get`、`analyze`、`test` |
| `AGENTS.md` | Codex |
| `services/api/` | Claude Code |
| `infra/` | Claude Code |
| `supabase/migrations/` | Claude Code |
| `.github/workflows/backend.yml` | Claude Code |
| `.github/workflows/contracts.yml` | Claude Code |
| `CLAUDE.md` | Claude Code |
| `contracts/` | Claude Code 主筆，Codex 驗證（見 §5） |
| `testdata/contracts/**` | Claude Code：與 `contracts/` 同版本的契約 fixture；既有根層 `location-sample-synthetic.ndjson` 由 contracts v1 PR 搬入 |
| `testdata/device/**` | Codex：原生採集樣本 |
| `testdata/` 其他既有檔案 | 雙方不互改；新增測資依上述子目錄歸屬 |
| `docs/` | 雙方可新增；本文件變更需雙方確認 |
| 根目錄 `01`–`05` 規劃文件、`USER_AGENT_PREFERENCES.md` | 使用者 |

P0 過渡：PR #2 的原生採集、NDJSON、診斷畫面與既有 `mobile_data` 程式由 Codex 維護至交接生效；之後 Claude Code 接手 `mobile_data` 的新變更。跨層問題由兩方共同重現，依路徑擁有權分別修正。`LocationSample`、記錄狀態及原生紀錄格式的變更先在共同契約確認相容性，不得各自改出兩種格式。正式計時引擎只有 `timing_core` 一份，且不依賴伺服器或 UI timer。

交接完成需同時滿足：

1. Android 真機 30 分鐘與 2 小時各一次完整採集，含鎖屏區段。
2. iPhone 真機 30 分鐘與 2 小時各一次完整採集，含鎖屏區段。
3. 依 `05-mac-iphone-checklist.md` 的格式提交報告，附樣本數、間隔分布、序號缺口與耗電。
4. 匯出的 NDJSON 通過當時版本的契約驗證器。
5. 使用者在 PR #2 宣告交接生效。

安裝成功、App 可啟動、CI 綠燈或 `flutter analyze` 通過均不構成交接條件。原生紀錄格式變更待 contracts v1 合併後才由各路徑擁有者實作；目前暫停真機採集。

## 4. 分支與工作目錄

- 預設分支 `main`。禁止直接推送到 `main`。
- 一個 Git repository、**兩套獨立 worktree**。兩個 AI 不得在同一份可寫 checkout 修改檔案。
- 分支命名：`mobile/<主題>`（Codex）、`server/<主題>`、`contracts/<主題>`（Claude Code）、`docs/<主題>`（雙方）。
- 保持小型 PR。不為暫時 checkpoint 建 PR，不製造不必要的未合併分支依賴。
- 不得 reset、stash、覆寫或提交對方的未完成工作。
- 不自我 approve／merge，不繞過保護規則。

## 5. 契約變更流程

`contracts/` 由 Claude Code 主筆、Codex 驗證手機端可實作。

1. **單一 PR 修改共同規格**，不得雙方各改一份再對齊。
2. HTTP 用 OpenAPI、WebSocket 用 JSON Schema。Dart／TypeScript 模型或驗證器**由同一份 schema 產生**，生成工具在契約 PR 選定並鎖版；不人工維護兩份模型湊相容。本機 `location-log` v1 暫採手寫 Dart 模型，以同一批合法／非法 fixtures 驗證；此例外不延伸至 HTTP／WebSocket 契約，待欄位穩定後重新評估生成器。
3. 每次契約變更必須附：
   - 合法與非法 JSON 案例
   - 重連／下線／撤銷案例
   - 版本相容說明與遷移步驟
4. 新增欄位盡量可選；破壞性變更使用新版本號，或協調雙端過渡期。測試者手機上的舊版 App 仍須被已承諾支援的版本容忍。
5. 型別生成不能取代文字規格：狀態機、權限語義、時間基準必須有文字定義與測試。
6. Codex 測試 client、Claude Code 測試 server，另有整合測試驗證雙端。

## 6. 測試與證據分類

所有驗證結論必須標明類型，不得混用：

`automated tests`｜`mock tests`｜`static validation`｜`manual tests`｜`hardware tests`｜`untested`

- 沒有真機執行就不得宣稱實機支援；模擬器結果不等於背景定位實測。
- 可重複的 baseline 優先於單次印象：記錄版本、輸入、參數、耗時與輸出。
- 測試未過或未執行時，說明原因、已確認範圍與剩餘風險；不得把部分驗證寫成全面通過。
- 缺硬體或依賴時，先做可行的靜態分析與小型測試，並提供使用者可在本機執行的**具體命令**。

## 7. 合併門檻

- 相關測試通過、契約相容、Android／iOS 建置成功。
- 修改原生行為者另附真機證據。
- 明列本次未涵蓋的硬體／系統版本。
- 一個 PR 一個清楚目的；不夾帶無關整理、格式調整、生成檔或實驗產物。
- 公開介面（CLI、API、設定、檔案格式、狀態／生命週期）變更須說明前後差異、相容性影響並加測試。

## 8. 秘密與資料處理

- 不提交真實憑證、service key、簽署私鑰、token、個人資料、logs、cache、生成輸出或 machine-specific 路徑。
- 環境設定只提交 `.example` 範本。
- 服務端日誌預設不記完整座標、token 或原始 OBD payload。測試位置資料不寫入長期日誌。
- 診斷軌跡由使用者主動匯出提供；精確位置不送到廣告分析。
- 管理金鑰／service key 不下發手機端。

## 9. 交付回報格式

每次交付依序回報：

1. 完成內容與實際行為變化
2. PR URL、branch、commit SHA（不適用時明確註明）
3. 測試與驗證結果，按 §6 分類
4. 使用者需在本機執行的具體指令（不需要也要明說）
5. 下一個開發目標，緊接在指令之後

補充交接差異：目前工作樹與無關修改、公開介面／相容性影響、已知限制、待 review／合併／驗證事項。另註明需要對方 AI 配合的事項。

沒有使用者要求時，不自行衍生對方 AI 的任務。

## 10. 待定決策

以下事項需由使用者或雙方確認；已完成事項保留在清單中供追蹤：

1. 隊長離隊：強制移交 vs 解散車隊
2. 每帳號單一位置發布者時，新分享工作階段如何取代舊工作階段（舊 socket 收到的訊息、是否有 grace period）
3. WSS token 過期處理：過期前重新認證 vs 關閉並重連
4. schema → Dart／TypeScript 的生成工具選型與鎖版
5. `sampleAgeMsAtSend` 的推算來源與跨裝置不可比性，須寫入文字規格
6. 閾值（3s stale／15s offline／1 Hz 上傳／1 Hz 快照／4 KiB publish／64 KiB snapshot）確認為集中設定的起始值，非契約常數
7. 已完成：repo 已在 GitHub，採 PR review／合併流程，禁止直接推送 `main`。
8. `sourceType` 允許值及舊值遷移方式。
9. `qualityFlags` 枚舉、未知旗標保留與消費端行為。
10. `measurementMonotonicUs` 為 null 時的時間語義與品質標記。
11. NDJSON 的 `recordType` 判別欄位及事件格式。
12. 跨 boot 的序號恢復與 monotonic 時間域切換規則。
