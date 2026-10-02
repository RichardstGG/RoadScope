# 汽機車計時 App：雙平台架構與 Codex／Claude Code 協作計畫

版本：規劃草案 v1，2026-09-29。這份交付包含規劃與工作說明；尚未建立 App、雲端服務或外部帳號。技術與費用會隨供應商變更，開工時鎖定相容版本。

## 1. 產品目標與範圍

已確認：iOS／Android、台灣優先；第一版專注山路路段及賽道計時，接著日常紀錄、車隊出遊。提供即時／最高速度、整次紀錄經過時間、分段與單圈時間；鎖屏仍要記錄。GPX 匯出先做，完整車輛資料 Log 後做。車隊最多 16 人、直線距離、手動上線後分享，1 Hz 起步，20 Hz 為後續探索目標。Alpha 不超過 20 人，Beta 不超過 300 人；功能保持免費，正式版加入簡單廣告，日後會員去廣告。OBD 先讀轉速，再評估水溫。

開發資源：使用者以 Linux 開發；朋友有 M5 MacBook Pro 與 iPhone，可協助 iOS。朋友的可支援時數、iPhone 型號與 iOS 版本尚未確認。需另確保有 Android 真機。Mac 的硬體充足，實際建置仍需匹配 Xcode、macOS、Flutter 與 iPhone 系統版本。[Flutter iOS 環境](https://docs.flutter.dev/platform-integration/ios/setup)

第一版不依賴登入或網路即可記錄／計時；地圖只用於設定與顯示，已保存的計時線可以離線使用。先不做公開排行榜、聊天、導航、軌跡雲端同步與通用 OBD 相容。這是目前建議的版本範圍，可依測試結果調整。

## 2. 工作責任：以手機端與伺服器端分界

| 項目 | 主要負責者 | 交付與邊界 |
|---|---|---|
| 產品範圍、優先順序、版本發布 | 使用者 | 維護待辦與驗收結果；擁有程式庫、商店及雲端帳號 |
| Flutter 畫面、互動、狀態管理 | Codex | 計時儀表、路線設定、結果、歷史、車隊與設定頁；透過單一資料／計時介面顯示狀態 |
| 手機上的計時核心與資料 | Claude Code | 純 Dart 穿線、分段、圈數、品質檢查、資料匯入／恢復、SQLite、GPX、重播測試；在裝置本機執行 |
| Android／iOS 裝置整合 | Codex | Kotlin／Swift、背景採集與原生追加紀錄、權限、分享傳輸、未來 BLE；P0 真機驗證由 Codex 持續負責 |
| App 登入、API 與 WebSocket 客戶端 | Codex | 使用共同契約，處理網路與登入狀態 |
| 伺服器 API、車隊規則與權限 | Claude Code | 登入 token 驗證、成員／邀請／分享工作階段 |
| 車隊即時轉送、資料庫及部署 | Claude Code | WebSocket、遷移、限流、監控、備份／恢復與壓力測試 |
| 共同通訊契約 | Claude Code 主筆，Codex 驗證 | 以 App 需求起草，修改時提供雙端相容方案 |
| 計時案例與獨立核算 | Claude Code 定義正式引擎的預期結果，Codex 協助跨平台整合驗證 | 保持一套正式計時演算法；獨立案例核算不演化成第二套產品引擎 |
| iOS 建置及實機操作 | 朋友 | 依檢查表執行、回傳日誌與重現條件；不預設朋友負責寫 Swift |
| 整合與合併 | 使用者主持，AI 協助 | 以可重現測試、實機證據與 PR 判斷，而非只看 AI 自述 |

「前端」在此是整個手機 App。GPS、計時、背景採集雖然不是畫面，仍屬手機端，必須在裝置本機完成。Claude Code 維護的純 Dart 計時核心不得依賴伺服器到達時間。原生採集與追加紀錄由 Codex 負責；Claude Code 的資料層以序號冪等匯入，雙方依共同契約銜接。

## 3. 技術架構

| 層級 | 選型 |
|---|---|
| 手機 App | Flutter／Dart，狀態管理集中於單一方案（建議 Riverpod，開工時驗證版本） |
| 原生整合 | Swift＋Kotlin，封裝成專案內 Flutter plugin；使用 Pigeon／平台通道 |
| 本機保存 | SQLite＋Drift；原生採集先寫可恢復的追加紀錄，Dart 匯入及建立查詢索引 |
| 地圖 | Google Maps for Flutter；只負責視覺呈現與計時線設定 |
| API 與即時服務 | Node.js LTS＋TypeScript＋Fastify＋WebSocket，先單一部署單元 |
| 帳號及持久資料 | Supabase Auth＋PostgreSQL，車隊階段才成為產品依賴 |
| 即時車隊狀態 | 伺服器記憶體＋逾時清理；多實例需求出現後再引入 Redis |
| 自動化 | Linux 執行一般測試及 Android 建置；macOS 執行 iOS 建置 |

Flutter 支援以平台通道或 Pigeon 串接 Swift／Kotlin；共用的是畫面及業務邏輯，作業系統的背景規則仍各自處理。[Flutter 平台整合](https://docs.flutter.dev/platform-integration/platform-channels)

Fastify 作為單一 HTTP／WebSocket 服務的基礎；不需要在初期拆微服務。Supabase JWT 由服務端驗證簽章、有效期、issuer／audience 等條件，不能只解碼後就信任。[Fastify](https://fastify.dev/docs/latest/)、[Supabase JWT](https://supabase.com/docs/guides/auth/jwts)

資料流：裝置定位／未來硬體 → 原生採集及耐久暫存 → 統一資料模型 → 本機計時／儲存／介面。只有使用者打開分享時，位置支線才送往車隊服務。帳號或後端出問題，不得阻止本機紀錄。

### 背景執行責任

原生採集生命週期與 UI 分離；原生紀錄使用單一寫入者，Dart 以序號冪等匯入，避免原生與 Dart 同時修改同一資料庫結構。P0 驗證 iOS 鎖屏期間 Dart engine 的實際行為；採集端必須能在 UI 不運作時保存資料。計時核心可在執行環境可用時處理即時事件，亦可由樣本重播恢復；定位本身沒有取得的資料不可憑空補回。

車隊階段的背景上傳同樣不綁在畫面 Widget。P0 先驗證背景網路傳送能力；若 Dart 傳輸無法通過實測，Codex 將必要傳輸下沉到原生，維持單一上傳者與相同協定。作業系統暫停時，允許顯示過期狀態，不承諾精準每秒抵達。iOS 背景定位與 Android 定位前景服務均需正確設定。[Apple](https://developer.apple.com/documentation/corelocation/handling-location-updates-in-the-background)、[Android](https://developer.android.com/develop/background-work/services/fgs/service-types)

### 三種頻率分開

採樣、儲存與傳輸保留獨立設定。手機定位以約 1 Hz 驗證起步，保存實際收到的有效樣本；畫面可以更平順刷新；車隊最多每人 1 Hz 上傳。20 Hz 定位需先實測硬體，優先評估外接 GNSS；20 Hz 車隊傳輸另做耗電、延遲與頻寬驗證，不能用重送舊樣本冒充新定位。手機 API 的更新間隔不是頻率保證。[Android 定位頻率](https://developers.google.com/android/reference/com/google/android/gms/location/LocationRequest.Builder)

## 4. 手機功能設計

第一版主流程：選路線／模式 → GPS 品質確認 → 開始紀錄及待命 → 穿線自動計時 → 結束 → 結果與匯出。

| 畫面 | 必須清楚呈現 |
|---|---|
| 首頁 | 最近路線、路段／賽道選擇、開始紀錄 |
| 路線設定 | 起終點線、分段線、方向、路線版本；停車時設定 |
| 計時儀表 | 速度、目前圈／分段、時間、GPS 品質、記錄狀態；日後分享狀態 |
| 結果 | 總經過時間、有效圈／分段、有效最高速度、資料中斷與品質標記 |
| 歷史 | 本機行程列表、詳情、刪除、匯出 |
| 車隊（後續） | 加入、手動上線、直線距離、資料年齡、停止分享 |
| 設定 | 權限、單位、儲存用量、診斷匯出、版本；日後硬體／去廣告 |

紀錄狀態與計時狀態分開：記錄可先開始；計時必須先待命，再穿正確方向的起點線。路段用不同起終點；賽道用起終點線加有序檢查點。停車不自動暫停路段或圈速，日常紀錄模式才另訂移動時間規則。

計時使用定位測量時間及穿線內插，檢查方向、檢查點順序、離線後再武裝與合理行程；髮夾彎／相鄰道路需利用路線進度避免誤判。顯示精度與測量準確度分開。保留原始資料、品質旗標、路線版本與演算法版本。計時引擎禁止讀取網路時間或 UI timer 作為穿線依據。

## 5. 車隊與後端設計

只有車隊需要登入。建議先採 email OTP，帳號 UI 由 Codex 實作，驗證服務由 Supabase 提供，Claude Code 負責後端驗證／設定與寄信環境；測試及正式郵件容量需在導入時確認。

持久資料只保存帳號資料、車隊、成員、邀請與必要的分享狀態。完整軌跡預設留在手機。未啟用軌跡同步以前，不建立每秒 GPS 寫入 PostgreSQL 的流程。

分享狀態：加入車隊 → 未分享 → 使用者按上線 → 取得新的分享工作階段 → 上傳 → 手動下線／結束。加入不代表同意上傳；App 重啟預設不自動恢復分享。短暫斷線可以在同一個仍有效、未手動停止的分享工作階段重連。

下線先停止本機發送，再通知服務端；服務端撤銷工作階段，丟棄晚到封包。若通知未送達，依逾時清除，不能宣稱已收回其他手機先前看到的座標。

預設 1 Hz 上傳及 1 Hz 整隊快照，立即傳送上下線事件。建議起始門檻：有效樣本超過 3 秒標記過期；超過 15 秒隱藏精確標記並標記離線；值集中設定，依測試修正。新快照不得把舊定位的時間重設成現在。既有成員可看目前分享者，未分享成員不提供自己的座標。

服務端檢查身分、成員資格、16 人上限、邀請有效期、訊息大小及速率、序號與分享工作階段。被移除的成員即時失去讀取／發送權限。邀請碼不是位置讀取憑證。API 原則見 02-contract-draft.md。

300 位 Beta 測試者不等於同時在線 300 人。容量驗證分成 16 人滿隊、5 隊 80 人、19 隊至多 300 人（最後一隊不足 16）。先做合成負載，再觀察真實使用。合併快照降低封包數，不會消除隨人數增加的位置資料量。

秒差順序：先比較同一路段完成時間；再做共同檢查點通過時間差（需要跨裝置校時與不確定性）；最後才做依路線匹配的行進中秒差。直線距離不能直接除以某個速度當成可靠秒差。

## 6. 程式庫與兩個 AI 的合作規則

採單一 Git repository、兩套獨立工作目錄／worktree。兩個 AI 可以同時工作，但不要在同一份可寫 checkout 修改檔案。分支以任務建立，例如 mobile/recording-spike、server/contract-v1，保持小型 PR。

建議專案結構：

```text
apps/mobile/                  # Codex：Flutter UI、App 組裝與平台入口
packages/timing_core/          # Claude Code：純 Dart 計時與重播
packages/device_bridge/        # Codex：Swift／Kotlin 原生模組
packages/mobile_data/          # Claude Code：資料與匯出；P0 真機驗證後由 Codex 交接
services/api/                 # Claude Code：HTTP 與 WebSocket
infra/                        # Claude Code：部署與環境範例
supabase/migrations/           # Claude Code：資料庫遷移
contracts/                    # 共同規格，Claude 主筆、雙端驗證
testdata/                     # 公開合成測試資料；真實軌跡另行授權
docs/                         # 架構、驗收、決策與操作文件
.github/workflows/mobile.yml  # Codex
.github/workflows/backend.yml # Claude Code
.github/workflows/contracts.yml # Claude Code，雙端驗證
AGENTS.md                     # Codex 入口，指向共同規則
CLAUDE.md                     # Claude Code 入口，指向共同規則
```

第一個 bootstrap PR 由 Codex 建立骨架與共同規則入口，合併後 Claude Code 從該版本建立分支。跨目錄變更先寫明介面影響；共同規格由單一 PR 修改，避免雙方各改一份。P0 既有 `mobile_data` 實作由 Codex 完成真機採集驗證後交接 Claude Code；交接前不並行修改同一檔案。生成檔由生成器產生，不人工改兩份模型來湊相容。

AGENTS.md 與 CLAUDE.md 保持短小，要求兩邊讀取同一份 docs/engineering-rules.md 與相關 contracts。不要把全部產品需求重複維護在兩個入口。這兩種專案指引均有官方支援。[Codex 指引](https://learn.chatgpt.com/docs/agent-configuration/agents-md)、[Claude Code 指引](https://code.claude.com/docs/en/memory)

每張任務卡含：目標、可修改目錄、契約版本、依賴、驗收案例、需要的真機證據、已知限制。每次交付含：變更、測試命令及結果、未執行項目、待另一方配合項目。沒有使用者要求時不額外衍生其他 AI 任務。

合作循環：共同契約／案例 → App 使用假資料開發、Claude 完成服務 → 同一契約測試 → staging 整合 → 真機 → 合併。跨端審查可以指出問題，但修改回到主要負責方，避免為通過測試而偷偷改對方假設。

## 7. Linux 與朋友的 Mac／iPhone

Linux：Flutter、Android SDK／Studio、JDK、Git、編輯器、Android 真機；Claude 使用 Node.js、容器及本機後端環境。Linux 負責日常開發及大多數測試。

Mac：安裝相容的 Xcode、Flutter、iOS 原生依賴工具、Git。使用者與朋友依各自帳號權限存取專案；簽署憑證與必要設定放在安全儲存，勿寫進 Git 或聊天。擁有 Mac 不代表朋友要承擔商店帳號的持有人角色。

建議每週安排兩次固定 iOS 驗證窗口，另在原生定位／權限更動時補測；若只能偶爾借用，優先開通雲端 macOS 建置，每週至少保留一次真機窗口。朋友可依 05-mac-iphone-checklist.md 操作，不必理解全部程式碼。

有互動權限的遠端 Mac 可以協助建置／讀日誌，但實體 iPhone 的連接、授權及戶外測試仍須有人操作。GitHub macOS runner 適合自動編譯；不等同於連著朋友 iPhone 的遠端除錯機。[GitHub runner](https://docs.github.com/en/actions/reference/runners/github-hosted-runners)

## 8. 開發路線、依賴與投入

| 階段 | Codex 主工作 | Claude Code 主工作 | 驗收／投入初估 |
|---|---|---|---|
| P0 技術驗證 | 雙平台原生採集、鎖屏耐久保存、診斷頁 | 契約草案、資料檢查／重播輔助、簡單背景傳輸測試端點 | 真機兩小時測試與缺點率報告；30–50 小時 |
| P1 計時 MVP | 路線設定、計時／歷史 UI、原生整合 | 純 Dart 穿線／分段／圈數、資料恢復／GPX、決定性重播與契約案例 | 決定性重播、GPX 有效；80–140 小時 |
| P2 ≤20 人 Alpha | 真機問題、異常恢復、品質提示 | 診斷整理及測試自動化；車隊契約細化 | 無未解的重大資料遺失；40–70 小時 |
| P3 日常紀錄 | 日常模式 UI、原生採集整合 | 移動／經過時間與摘要資料邏輯；帳號／車隊後端可開始實作 | 計時模式不退步；30–50 小時 |
| P4 車隊 | 登入、加入／上線、距離、1 Hz、背景傳輸 | API、JWT、成員、WSS、TTL、限流、staging | 16 人完整場景及權限隔離；60–100 小時 |
| P5 ≤300 人 Beta | 耗電／弱網／多機型修正 | 80／300 人容量、監控、重啟與備份恢復 | 品質、延遲、成本報告；40–80 小時 |
| P6 正式發布 | 廣告非行進頁面、商店資料、發版 | 正式環境、告警、回復與日後去廣告權益 | 審核及發布，另估 |
| P7 擴充 | 外接 GNSS、OBD、完整 Log、秒差 | 必要協定版本／高頻服務驗證 | 按硬體及範圍另估 |

保留前版估算：Alpha 累計約 150–260 小時，含車隊 Beta 累計約 280–490 小時。這是規劃工程投入，不是 AI 執行時長；不含商店等待、朋友可配合的間隔、硬體採購及大量重新學習。兩個 AI 不會讓工期直接減半，P0 到 P2 的關鍵路徑仍是手機採集與真機驗證。Claude Code 另負責資料與計時核心，須與後端工作排程協調；不必先造大型後端。

建議首個兩週工作安排（依可投入時數調整）：

1. 第 1–2 天：bootstrap、固定工具版本、真機名單、樣本模型及基本狀態契約。
2. 第 3–5 天：Android 記錄器；Claude 做樣本驗證器與合成輸入；Mac 完成首次 iOS 建置。
3. 第 6–8 天：iOS 採集及鎖屏；雙方使用相同格式產生與驗證資料。
4. 第 9–10 天：兩平台測試 30 分鐘及兩小時，整理時間戳、資料中斷、耗電及背景傳輸結果，決定 P1 入口。

## 9. 驗收與測試資產

計時測試：正／逆向穿線、停在線附近、反覆抖動、相鄰髮夾彎、缺檢查點、重複／亂序樣本、長斷點、裝置校時、App 中斷重開。固定樣本與版本應產生相同結果。

資料測試：原生暫存重播冪等、SQLite 遷移、磁碟不足處理、未完成行程恢復、GPX 結構與時間格式。模擬強制終止，確認可恢復範圍；初期正常執行時以最多一秒寫入緩衝為設計目標，再依耗電量測調整，不宣稱斷電零遺失。

真機測試：至少一台 iPhone、兩品牌 Android；測量前景／鎖屏／切換導航、網路切換、GPS 弱訊號、權限降級、電量模式、發熱與中斷。依型號記錄每小時耗電，沒有量測前不給續航保證。

計時精度：用已知時間／參考設備比較穿線偏差，報告中位數、P95、漏判和誤判，先建立實測基準，再決定宣稱精度；無參考設備時，只能證明重播一致性與邏輯正確，不能聲稱測量準確度。

車隊測試：未上線零座標上傳、跨隊拒絕、下線晚到封包拒絕、離線清理、token 過期、成員被移除、16 人上限競態、App／伺服器重啟、慢用戶端背壓。暫定良好網路下樣本至畫面 P95 ≤2 秒為工程目標，須記錄跨裝置時間校正方法與網路條件；不是山區服務保證。

合併門檻：相關測試通過、契約相容、Android／iOS 建置成功；原生行為修改另附真機證據。測試綠燈只涵蓋已測條件，未測的硬體／版本要明列。

## 10. 部署、資料與營運

環境分 local／staging／production。App 的 API 位址、地圖金鑰及識別碼依環境區分；開發者機器不是正式伺服器。初期選能維持長連線的容器服務，以台灣實測延遲決定鄰近區域；不以一般短生命週期函式取代常駐 WebSocket。

Claude 負責健康檢查、TLS、斷線退避、部署排空、版本回復、資料庫備份與恢復演練。先單實例；重啟後 client 重連並重新驗證分享工作階段，絕不可跨過已撤銷狀態。未來多實例時，才把即時狀態與成員撤銷事件移到共用系統。

監控至少包含在線人數／車隊數、收發量、過期樣本比例、重連率、處理延遲、錯誤率與月用量。日誌預設不記完整座標、token 或原始 OBD payload；診斷軌跡由使用者主動匯出提供。精確位置不送到廣告分析。位置快取短期存在記憶體，軌跡不預設上雲；刪除帳號同時清除或解除必要的成員資料。

第一版廣告僅放結果／歷史／設定等適合位置；採購／訂閱去廣告後，App 商店購買及恢復流程由 Codex 負責，服務端權益驗證與通知由 Claude 負責。商店規則與 SDK 在該階段重新核對。所有核心功能持續免費。

預算先分項管理，不把預算上限當供應商報價：本機 Alpha 可不開正式後端；車隊 staging 可先設定每月 NT$1,000–2,000 的管理預算，Beta 設 NT$2,000–5,000 的預算警戒線，依實際流量與供應商方案調整。這些不是已驗證帳單，且不含 AI 工具、硬體、商店費、地圖或郵件超額費用。每月以活躍車隊時數、隊伍大小、傳輸率和出站流量核算。

Apple Developer Program 目前為 US$99／年；Google Play 開發者註冊目前為 US$25 一次性費用，實際本地金額以結帳為準。[Apple](https://developer.apple.com/programs/enroll/)、[Google](https://support.google.com/googleplay/android-developer/answer/6112435)

iOS 外部 TestFlight 測試可能需 Beta App Review；適用的新 Google Play 個人帳號目前需至少 12 位測試者連續加入封閉測試 14 天，再申請正式發布資格，完成測試不等於自動獲准。排程應保留這些等待。[TestFlight](https://developer.apple.com/help/app-store-connect/test-a-beta-version/invite-external-testers)、[Google 測試要求](https://support.google.com/googleplay/android-developer/answer/14151465)

## 11. 未來硬體與 Log

資料來源介面先留 PhoneLocationSource／ExternalGnssSource／ObdSource 的責任邊界，不先實作未選定裝置。OBD 第一版限定一款經驗證的雙平台轉接器及少數車種，轉速優先；機車依品牌／年份／ECU／接頭建立相容表。GPS 與 OBD 各自保留時間戳、頻率、來源及有效性，匯出再對齊。

完整 Log 建議 ZIP 封裝 manifest.json、track.gpx、telemetry.csv、events.json；有 schemaVersion、時間基準、單位、來源及演算法版本。GPX 保持通用，擴充欄位讀取相容性另外驗證。先落實可擴充資料模型，不在 Alpha 同時開發所有未來功能。

## 12. 交付文件使用順序

雙方先讀本文件與 02-contract-draft.md。將 03-codex-brief.md 交給 Codex，04-claude-code-brief.md 交給 Claude Code，05-mac-iphone-checklist.md 交給朋友。先執行 P0；透過真機數據決定後續實作細節，不直接把草案當成已完成的技術驗證。
