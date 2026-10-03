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
- **狀態**：待交付
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

---

## H2 · 恢復路徑在 UI 沒有入口

- **擁有者路徑**：`apps/mobile/`（畫面）、`packages/device_bridge/android/`（狀態判讀）
- **狀態**：待交付
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
- **狀態**：待交付
- **為什麼不在本次範圍**：開機自動恢復採集是記錄生命週期功能，需要產品決策，不屬於 telemetry。

`LocationLogWriter` 與 telemetry 都有 `reason: "boot"` 的程式路徑，且有單元測試覆蓋（`boot rollback changes time domain but sequence continues`）。但 Android 的 `START_STICKY` 服務**不會跨裝置重開機重啟**，而專案沒有 `BOOT_COMPLETED` receiver，也沒有別的開機觸發點。

加上 H2，重開機後 `prefs.state` 仍是 `recording`、畫面顯示「停止記錄」，所以使用者也無法手動接續。結論：**該程式路徑在真機上沒有觸發點**。

**建議**：要嘛加上 `BOOT_COMPLETED` 並處理 Android 的開機後前景服務限制，要嘛明確記錄「不支援跨重開機恢復」並在文件標註該程式路徑僅為資料層相容性保留。無論哪一種，`contracts/location-log/v1` §8 對 `recording_resumed.reason` 的定義不需要改。

---

## H4 · 廠商省電權限需要引導（小米實測為必要條件）

- **擁有者路徑**：`apps/mobile/`（引導畫面）；產品決策屬使用者
- **狀態**：待交付
- **為什麼不在本次範圍**：引導流程是產品與 UI 工作。

Xiaomi 21081111RG／Android 14／MIUI V816 實測，**自啟動關閉時程序一死採集就永久結束**：

| 環境 | SIGKILL 後 180 秒內 |
|---|---|
| 自啟動 `ignore`、不在電池白名單、通知 `ignore` | **零重建**，ActivityManager 連 ServiceRecord 都移除 |
| 自啟動 `allow`、電池白名單、通知 granted | **5 秒內重建**，寫出 `recording_resumed`（`process_restart`），續錄 352 筆樣本未中斷 |

`cmd appops get` 顯示 `MIUIOP(10008)`（自啟動）在重建當下被系統查詢（`allow; time=+6m39s ago`，回推正好是 SIGKILL 時刻）。`dumpsys` 的 `tempAllowListReason: SYSTEM_ALLOW_LISTED` 對應電池白名單，是前景服務得以從背景啟動的豁免來源。

**限制**：三項是一起改的，**無法分辨哪一項是決定性的**。要分辨必須逐項開關重測。

**建議**：在開始長時間記錄前偵測並引導使用者開啟（至少小米／OPPO／vivo／華為）。沒有引導的話，「背景採集穩定」在這些機型上不成立。

---

## H5 · 分不出「task 被滑掉」與「切到背景」

- **擁有者路徑**：`packages/device_bridge/android/`
- **狀態**：待交付
- **為什麼不在本次範圍**：這是新增原生生命週期觀測點，不只是補一個 telemetry 欄位。範圍小，若使用者指定，Claude Code 也可以做。

從近期工作清單滑掉 App 與按 Home 都只產生一次 `appLifecycle: background`，telemetry 無法區分。實測 2026-10-03T22:18:28Z 的 `background` 無法判定是哪一種操作。

**建議**：在 `LocationRecorderService` 實作 `onTaskRemoved()`，寫一筆 trigger（例如 `task_removed`）。新增 trigger 已有向前相容規則（未知 trigger 是警告並保留），`docs/diagnostics-telemetry.md` §4 的欄位集合不需要變，但三端的 trigger 清單要同步。

---

## 測試環境注意事項（給下一位執行真機測試的人）

這些不是待修項目，但會影響測試方式：

1. **MIUI 封鎖 `adb shell input`**，需要「USB 偵錯（安全設定）」，而該選項要登入小米帳號。因此無法用腳本自動點按「開始記錄」，必須人工按一次。
2. **MIUI 幾乎關閉 AMS 的生命週期日誌**。一次 160 秒的 `logcat -b main -b crash` 擷取共 26799 行，其中只有 8 行 `ActivityManager` 且全部無關。看不到 `Scheduling restart of crashed service` 或 `ForegroundServiceStartNotAllowedException`，所以「logcat 沒有重啟訊息」不能當成「系統決定不重啟」的證據。可靠的觀測方式是輪詢 `dumpsys activity services <pkg>` 的 `isForeground` 與 `pidof`。
3. **`apps/mobile/android/gradlew` 未被版控追蹤**（`.gitignore`）。CI 能跑是因為 `flutter build apk` 排在 `./gradlew` 之前會產生 wrapper；在乾淨 checkout 上單獨跑 gradle 需要先 `flutter build` 或自備 gradle。
4. **重裝務必用 `adb install -r`，不要 uninstall**。解除安裝會清掉 MIUI 自啟動／省電設定、通知權限與手機上既有的紀錄檔。實測 `install -r` 會保留全部四項。
5. 以 `run-as <pkg> toybox kill -9 <pid>` 可模擬程序死亡（`run-as` 內建的 `kill` 會回 `Permission denied`，要用 `toybox kill`）。

---

## 交付時使用的 prompt（草稿，交付前再核對狀態）

> 以下是 Claude Code 在「App 端診斷 telemetry」階段發現、但屬於你擁有路徑或需要產品決策的項目，共 5 項，整理在 `docs/handoff-to-codex.md`。請先讀 `docs/engineering-rules.md` 與該檔案，再依你的判斷排序。
>
> 相關分支與提交：`mobile/diagnostics-telemetry`（PR #7）。telemetry 的格式、平台限制與真機驗證現況見 `docs/diagnostics-telemetry.md`。
>
> 其中 H1（通知權限未在執行期請求）會影響所有背景採集測試的可信度，建議優先。H2（恢復路徑沒有 UI 入口）與 H3（無開機恢復觸發點）需要先由使用者決定產品語義。H4 是小米實測確認的必要條件。H5 範圍最小。
>
> 真機證據在 `testdata/private/fieldtest/`（含真實座標，不進版控）；關鍵數字已寫進交接檔案，不需要那些檔案也能動手。
