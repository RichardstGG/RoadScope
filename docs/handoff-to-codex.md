# 交接給 Codex 的待辦（累積中）

本檔案收集 Claude Code 在工作中發現、但**不屬於當次任務範圍或屬於 Codex 擁有路徑**的問題。原則：

1. **不自行修改**他方擁有的路徑（`docs/engineering-rules.md` §3）。
2. **不丟掉**。發現當下寫進本檔案，附可查證的證據與建議。
3. **不逐項打擾**。該階段完成後**一次交付**，並附可直接貼給 Codex 的 prompt（見文末）。
4. 證據若存放在 `testdata/private/`（真實軌跡，不進版控），本檔案必須把關鍵數字寫進來，讓 Codex 不需要那些檔案也能動手。本檔案不含座標。

狀態標記：`待交付` → `已交付` → `Codex 處理中` → `已解決`／`不處理`。

---

## H1 · `POST_NOTIFICATIONS` 未在執行期請求

- **擁有者路徑**：`apps/mobile/`、`packages/device_bridge/android/`
- **狀態**：已解決（PR #8；2026-10-05 Android 真機驗證）
- **為什麼不在本次範圍**：本次任務是「App 端診斷 telemetry」。加入執行期權限請求是 App 權限流程的行為變更，不屬於 telemetry。

`AndroidManifest.xml` 宣告了 `POST_NOTIFICATIONS`，但程式碼**從未在執行期請求**（`DeviceBridgePlugin.kt` 只請求 `ACCESS_FINE_LOCATION`／`ACCESS_COARSE_LOCATION`）。APK 的 `targetSdkVersion` 為 36，所以 Android 13+ 上前景服務的常駐通知會被靜默擋掉。

**證據**（Xiaomi 21081111RG／Android 14／MIUI V816）：

```
cmd appops get tw.idv.richardwutt.roadscope
  POST_NOTIFICATION: ignore          ← 權限從未被授予
dumpsys activity services …
  isForeground=true foregroundId=8042 types=00000008
  foregroundNoti=Notification(channel=roadscope_recording …)   ← 通知物件存在但沒被張貼
```

手動 `pm grant` 之後，`dumpsys notification` 才數得到 `roadscope_recording` channel，使用者也**目視確認通知欄確實出現**常駐通知（2026-10-04 短測 A）。所以通知本身的實作是對的，缺的只有執行期權限請求。

**影響**：

1. 使用者看不到記錄中的常駐通知，無法確認採集是否還在跑，也沒有入口回到 App。
2. 對 MIUI 這類激進省電實作，一個沒有可見通知的前景服務更容易被處理掉。
3. **2026-10-03 之前所有「背景採集」的真機觀察都帶著這個未受控變數。**

**建議**：在 `start` 流程裡，於請求定位權限的同一條路徑上請求 `POST_NOTIFICATIONS`（Android 13+ 才需要）。被拒絕時不要阻止記錄，但要在診斷畫面明確標示「常駐通知已被關閉」。

**Codex 處理**：開始流程現在會同時請求缺少的定位與通知權限；通知被拒絕時仍啟動記錄。原生 status 回報通知權限，Flutter 的「Android 背景執行準備」區塊會顯示結果。2026-10-05 以新安裝的 PR #8 APK 實測，開始記錄時定位與通知權限均由未授予變成已授予；服務為 `isForeground=true`，`dumpsys notification` 可查到 `roadscope_recording` 的實際 NotificationRecord，並非只有建立 channel。

---

## H2 · 恢復路徑在 UI 沒有入口

- **擁有者路徑**：`apps/mobile/`（畫面）、`packages/device_bridge/android/`（狀態判讀）
- **狀態**：等待使用者決定產品語義
- **為什麼不在本次範圍**：這是產品行為決策（程序被殺之後要不要、以及怎麼續錄），不是診斷資料的問題。

程序在記錄中被終止後，`SharedPreferences` 的 `state` 仍是 `recording`。重開 App 時畫面依這個值顯示「停止記錄」，按下去走的是 `ACTION_STOP`，也就是**停止而不是續錄**。使用者沒有任何方法接續同一次記錄。

**證據**：

- 2026-10-03T21:18:40Z `am crash` 後，`prefs.state` 維持 `recording`，服務未重建，使用者必須按「停止記錄」才能匯出。
- 2026-10-04T22:13Z 以 `adb install -r` 終止記錄後同樣如此。

**注意範圍**：在 MIUI 自啟動＋電池白名單＋通知三項都開啟的環境下，系統會自己重建 sticky 前景服務（實測 SIGKILL 後 5 秒重建，並正確寫出 `recording_resumed`）。因此 H2 主要影響**系統不重建**的情況：權限未開、`force-stop`、或重開機。

**建議**：先決定產品語義（三選一），再實作。

1. 畫面提供明確的「續錄」按鈕（從前景啟動前景服務是被允許的，技術上可行）。
2. 明確承認「程序被終止即結束該次記錄」，開 App 時把殘留的 `recording` 自動收斂成結束，並在畫面說明。
3. 維持現狀，但畫面不得顯示成「正在記錄」。

**已由 Claude Code 緩解的部分**：telemetry 現在會補寫 `recording_interrupted`，所以**資料上**看得出上一段非正常結束（含定位紀錄寫到哪一個序號）。這只解決判讀，沒有解決使用者無法續錄。

---

## H3 · 沒有 `BOOT_COMPLETED` receiver，`resumeReason: "boot"` 實務上不可達

- **擁有者路徑**：`packages/device_bridge/android/`
- **狀態**：等待使用者決定產品語義
- **為什麼不在本次範圍**：開機自動恢復採集是記錄生命週期功能，需要產品決策，不屬於 telemetry。

`LocationLogWriter` 與 telemetry 都有 `reason: "boot"` 的程式路徑，且有單元測試覆蓋（`boot rollback changes time domain but sequence continues`）。但 Android 的 `START_STICKY` 服務**不會跨裝置重開機重啟**，而專案沒有 `BOOT_COMPLETED` receiver，也沒有別的開機觸發點。

加上 H2，重開機後 `prefs.state` 仍是 `recording`、畫面顯示「停止記錄」，所以使用者也無法手動接續。結論：**該程式路徑在真機上沒有觸發點**。

**建議**：要嘛加上 `BOOT_COMPLETED` 並處理 Android 的開機後前景服務限制，要嘛明確記錄「不支援跨重開機恢復」並在文件標註該程式路徑僅為資料層相容性保留。無論哪一種，`contracts/location-log/v1` §8 對 `recording_resumed.reason` 的定義不需要改。

---

## H4 · 廠商省電權限需要引導（小米實測為必要條件）

- **擁有者路徑**：`apps/mobile/`（引導畫面）；產品決策屬使用者
- **狀態**：已解決（PR #8；2026-10-05 Android 真機驗證）
- **為什麼不在本次範圍**：引導流程是產品與 UI 工作。

Xiaomi 21081111RG／Android 14／MIUI V816 實測，**自啟動關閉時程序一死採集就永久結束**：

| 環境 | SIGKILL 後 180 秒內 |
|---|---|
| 自啟動 `ignore`、不在電池白名單、通知 `ignore` | **零重建**，ActivityManager 連 ServiceRecord 都移除 |
| 自啟動 `allow`、電池白名單、通知 granted | **5 秒內重建**，寫出 `recording_resumed`（`process_restart`），續錄 352 筆樣本未中斷 |

`cmd appops get` 顯示 `MIUIOP(10008)`（自啟動）在重建當下被系統查詢（`allow; time=+6m39s ago`，回推正好是 SIGKILL 時刻）。`dumpsys` 的 `tempAllowListReason: SYSTEM_ALLOW_LISTED` 對應電池白名單，是前景服務得以從背景啟動的豁免來源。

**限制**：三項是一起改的，**無法分辨哪一項是決定性的**。要分辨必須逐項開關重測。

**建議**：在開始長時間記錄前偵測並引導使用者開啟（至少小米／OPPO／vivo／華為）。沒有引導的話，「背景採集穩定」在這些機型上不成立。

**Codex 處理**：診斷畫面會顯示廠牌、通知權限與 Android 公開的電池最佳化排除狀態，並提供 App 權限與電池最佳化設定入口。小米／OPPO／vivo／華為等廠牌另顯示人工設定說明。2026-10-05 真機確認兩個入口分別開啟 Android App 詳細設定與 MIUI 電池設定；將 RoadScope 設為不受限制並返回 App 後，畫面刷新為「常駐通知權限：已允許」與「電池最佳化：已排除」，`dumpsys deviceidle whitelist` 也包含套件。`MIUIOP(10008)` 仍為 `ignore`，證實 App 無法可靠讀取或代替使用者開啟小米自啟動權限，人工引導仍是必要資訊。

---

## H5 · 分不出「task 被滑掉」與「切到背景」

- **擁有者路徑**：`packages/device_bridge/android/`
- **狀態**：已解決（PR #8；2026-10-05 Android 真機驗證）
- **為什麼不在本次範圍**：這是新增原生生命週期觀測點，不只是補一個 telemetry 欄位。範圍小，若使用者指定，Claude Code 也可以做。

從近期工作清單滑掉 App 與按 Home 都只產生一次 `appLifecycle: background`，telemetry 無法區分。實測 2026-10-03T22:18:28Z 的 `background` 無法判定是哪一種操作。

**建議**：在 `LocationRecorderService` 實作 `onTaskRemoved()`，寫一筆 trigger（例如 `task_removed`）。新增 trigger 已有向前相容規則（未知 trigger 是警告並保留），`docs/diagnostics-telemetry.md` §4 的欄位集合不需要變，但三端的 trigger 清單要同步。

**Codex 處理**：Android `Service.onTaskRemoved()` 現在寫入 `task_removed`，記錄服務不會因此停止；Kotlin、Swift、Dart 的 trigger 清單與 UI 標籤已同步。2026-10-05 由使用者實際從近期工作清單滑掉 App 後，telemetry 寫入唯一一筆 `task_removed`（sequence 12）；前景服務仍為 `isForeground=true`、`startRequested=true`。重新開啟 App 後可正常停止。該次 telemetry 共 15 列、0 bad lines，trigger 為 `recording_started` 1、`state_change` 10、`heartbeat` 2、`task_removed` 1、`recording_stopped` 1。

---

## 測試環境注意事項

已整理到 [`docs/android-field-test.md`](android-field-test.md) §7（工具限制）與 §3（MIUI 權限）。重點：MIUI 封鎖 `adb shell input` 所以無法自動點按、MIUI 幾乎關閉 AMS 生命週期日誌所以 logcat 看不到重啟決策、重裝務必用 `adb install -r`、以 `run-as <pkg> toybox kill -9 <pid>` 模擬程序死亡。該文件 §10 是真機證據索引。

## 交付紀錄

2026-10-04 交付給 Codex，分支 `mobile/diagnostics-telemetry`（PR #7）。交付時的 prompt 見下。Codex 回覆或處理進度請更新上方各項狀態。

### 交付 prompt

> 你負責 `apps/mobile/` 與 `packages/device_bridge/`。Claude Code 在「App 端診斷 telemetry」階段（分支 `mobile/diagnostics-telemetry`，PR #7）發現 5 項屬於你擁有路徑或需要產品決策的問題，沒有自行修改，整理在 `docs/handoff-to-codex.md`（H1–H5）。
>
> 請先讀 `docs/engineering-rules.md`、`AGENTS.md`、`docs/handoff-to-codex.md`，再讀 `docs/diagnostics-telemetry.md`（telemetry 格式、平台限制、§9 真機驗證現況）與 `docs/android-field-test.md`（真機流程、工具限制、證據索引）。
>
> 建議順序：
> 1. **H1 `POST_NOTIFICATIONS` 未在執行期請求** —— 影響所有背景採集測試的可信度，MIUI 上還會提高被殺機率。純實作，建議優先。
> 2. **H4 廠商省電權限引導** —— 小米實測為採集恢復的必要條件：三項權限未開時 SIGKILL 後 180 秒零重建，開啟後 5 秒重建。
> 3. **H2 UI 沒有續錄入口**、**H3 無開機恢復觸發點** —— 兩項都要先由使用者決定產品語義，H2 已列出三個選項。
> 4. **H5 分不出 task 被滑掉與切背景** —— 範圍最小，建議用 `Service.onTaskRemoved()`，新增 trigger 要同步 Kotlin／Swift／Dart 三端清單。
>
> telemetry 本身已完成並有真機證據（201 分鐘連續採集零缺口、鎖屏 92.1%、heartbeat 已觀測、`recording_interrupted` 端對端驗證）。`contracts/` 零修改。真實軌跡在 `testdata/private/fieldtest/`（不進版控），關鍵數字已寫進交接檔案與上述兩份文件，不需要那些檔案也能動手。
>
> 尚未驗證、不屬於本次交接但你需要知道的：iOS 只有 CI 編譯與 static validation，沒有任何執行期證據；所有 Android 結論都來自一台小米機；合規的 30 分鐘採集尚未完成（已跑那次全程充電且螢幕關閉僅 2.7%）。
