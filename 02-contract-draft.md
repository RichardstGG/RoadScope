# 共用資料與通訊契約草案 v1

用途：Codex／Claude Code 在正式建置前轉成 OpenAPI、JSON Schema 與案例。這是設計草案，不是已運行 API。共同規格由 Claude Code 主筆，Codex 驗證手機端可實作；bootstrap 時先確定手機樣本格式，再定車隊協定。

## 一、時間、單位與資料品質

- 座標：WGS84 十進位緯經度；距離／精度為公尺，速度為 m/s，畫面才轉 km/h；方向為相對真北順時針角度，未知為 null。
- 對外 UTC 採 RFC3339 字串；本機 duration／monotonic 採明示單位的整數欄位，不混用毫秒與微秒。
- 測量時間與收到資料的時間分開。monotonic 只在同一 deviceBootId 時間域比較，禁止跨手機直接相減；UTC 校時事件需記錄。
- iOS 原始定位時間／Android 測量的 elapsedRealtime 依平台能力保存。缺乏原生單調測量時間時，映射後的值標記來源與估計性，不用 callback 接收時間假裝測量時間。
- 無效速度／精度保存 null＋旗標，不用 0 冒充；原始資料與過濾結果分開；20 Hz 重播與真實硬體來源要標明。

LocationSample 最少包含：schemaVersion、recordingId、sourceId、sourceType、deviceBootId、sequence、measuredAtUtc、receivedAtUtc、measurementMonotonicUs（可 null）、receivedMonotonicUs、latDeg、lonDeg、altitudeM（可 null）、speedMps（可 null）、headingDeg（可 null）、horizontalAccuracyM（可 null）、speedAccuracyMps（可 null）、qualityFlags。

RouteDefinition 包含 routeId、routeVersion、模式、起終點線兩端座標、通過方向、有序分段線、必要檢查點。已完成行程保留其路線版本快照。

TimingResult 包含 recordingId、routeId／version、algorithmVersion、圈與分段索引、穿線事件、elapsedUs、validity、reasonCodes。elapsedUs 的儲存解析度不是產品準確度承諾。

VehicleSample 包含 sourceId、時間基準、parameter（例如 rpm）、value、unit、validity、來源協定版本。不同資料來源不強制同頻採樣。

## 二、登入與持久資料邊界

本機記錄不需要登入。車隊啟用 Supabase Auth，App 取得使用者 token，HTTP／WSS 傳給後端驗證。成員身分由已驗證 token 推導，不能相信 payload 自報 userId。管理金鑰不下發 App。

HTTP 建議路徑（均在 /v1）：

| 方法與路徑 | 行為 |
|---|---|
| GET /me | 回傳目前使用者的必要資料 |
| POST /teams | 建立車隊，隊長計入 16 人上限 |
| POST /teams/{id}/invites | 建立有期限邀請，權限限隊長 |
| POST /team-joins | 用邀請碼加入；交易內檢查人數，防止競態超額 |
| GET /teams/{id} | 僅成員讀取基本資料及成員名單 |
| DELETE /teams/{id}/members/me | 離隊並撤銷相關讀取／分享能力 |
| DELETE /teams/{id}/members/{memberId} | 隊長移除成員，處理既有 socket |
| POST /teams/{id}/sharing-sessions | 主動上線，建立新的分享工作階段 |
| DELETE /sharing-sessions/{id} | 冪等停止分享，晚到樣本作廢 |
| DELETE /me | 撤銷分享並啟動帳號資料刪除流程 |

隊長離隊時需先移交，或解散車隊；契約定案時明訂。v1 每個帳號同時只允許一個有效位置發布者，避免多裝置混寫；新工作階段需明確取代舊工作階段。

所有錯誤有 code、message、requestId、retryable。最少定義 unauthenticated、forbidden、team_full、invite_expired、sharing_revoked、rate_limited、unsupported_version。建立及加入操作提供冪等鍵／唯一約束；重試不得多建車隊或重複計人。

## 三、WebSocket v1

Native app 在 WSS 握手使用短效使用者 access token，例如 Authorization header；不要把長效 token 放 URL 查詢參數。後端定義 token 過期前重新認證或關閉重連流程，App 由安全儲存取得登入狀態並刷新。未認證連線不訂閱隊伍。

訊息 envelope：protocolVersion、type、requestId（適用時）、payload。序號屬於分享工作階段；換工作階段才可重置。

| 訊息 | 方向 | 重點 |
|---|---|---|
| team.subscribe | App → 服務 | 檢查當下成員資格；訂閱不啟動位置分享 |
| location.publish | App → 服務 | sharingSessionId、seq、sampleAtUtc、sampleAgeMsAtSend、位置／品質 |
| team.snapshot | 服務 → App | serverTimeUtc、snapshotSeq、每人最新樣本及資料年齡 |
| sharing.changed | 服務 → App | 上下線／撤銷；立即更新顯示 |
| error | 服務 → App | 結構化原因及是否可重試 |
| heartbeat | 雙向 | 連線健康；不可當成新的定位樣本 |

後端給每筆接受樣本加 receivedAtServer。時效依接收後經過時間加上有效的樣本年齡估計，另校核 sampleAtUtc；不信任裝置 UTC 一定準確。時鐘偏差或資料年齡不可信時標記 unknown／degraded。這能改善顯示，但不構成防作弊或精準跨車校時。

同一工作階段丟棄重複／逆序 seq。禁止補送歷史軌跡到即時頻道；重連只送最新有效樣本。App 沒有新樣本時可以心跳，但不改寫測量時間。

起始設定：上傳最多 1 Hz、整隊快照 1 Hz；有效樣本年齡 >3 秒 stale，>15 秒 offline 並隱藏精確位置，停止分享則立即清除。數值集中設定，不散落在 UI／服務中。

先定小型訊息上限，例如單筆 publish 4 KiB、快照 64 KiB；實作時以 schema 大小測試確認。慢連線合併／丟棄舊快照，不累積無限佇列；伺服器端限頻與大小驗證是權威，App 限頻只降低流量。

## 四、兩個獨立狀態機

Recording：idle → recording → finished／interrupted。Timing：unarmed → armed → running → finished；賽道依有序 checkpoint 重複完成圈。Sharing：off → starting → on → reconnecting／stopping → off。

錄製不隱含分享。手動 off 後，本機永久停止該分享意圖，直到下次手動 on；晚到的重連成功不能恢復。App 重啟預設 off。服務重啟後重新檢查有效工作階段，撤銷狀態有持久來源。

## 五、契約版本及自動化

HTTP 用 OpenAPI、WSS 用 JSON Schema，Dart／TypeScript 模型或驗證器從同一 schema 產生，生成工具在 bootstrap／契約 PR 選定並鎖版。狀態／權限語義仍需文字規格與測試，不能只靠生成型別。

每次契約修改包含合法與非法 JSON 案例、重連／下線案例、版本相容說明。新增欄位盡量可選；破壞性變更使用新版本或協調雙端過渡。舊版 App 留在測試者手機時，服務必須容忍已承諾支援的版本。

必要案例：未上線發位置、非成員訂閱、撤銷後舊封包、16→17 人同時加入、UTC 偏移、亂序 seq、token 過期、沒有新樣本但持續 heartbeat、慢用戶端、服務重啟、App 重啟。Codex 測試 client，Claude 測試 server，整合測試驗證雙端。
