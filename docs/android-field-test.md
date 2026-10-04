# Android 真機實測流程與證據索引

本文件記錄 P0 診斷 telemetry 階段實際跑過的 Android 真機流程、分析命令、判讀陷阱與工具限制，供下一次驗收或其他機型重現。格式規範見 [`diagnostics-telemetry.md`](diagnostics-telemetry.md)，驗證結論記在該文件 §9。

本文件**不含座標**。真實軌跡在 `testdata/private/fieldtest/`（`.gitignore:73`，不進版控），索引見 §8。

## 1. 基準環境

| 項目 | 值 |
|---|---|
| 裝置 | Xiaomi 21081111RG（`amber`，小米 11T Pro） |
| 系統 | Android 14／SDK 34，MIUI `V816.0.15.0.UKWTWXM` |
| App | `tw.idv.richardwutt.roadscope`，`versionCode=2`／`versionName=0.0.2`，`targetSdk=36`、`minSdk=24` |
| 定位 | `LocationManager.GPS_PROVIDER`，1000 ms、0 m |
| 工具 | Flutter 3.47.3（Dart 3.13.3）、Android SDK platform 36、adb 1.0.41 |

**只有這一台。** MIUI 是公認最激進的省電實作，下列結論不可推廣到其他品牌。`01-master-plan.md` §9 原本要求兩品牌 Android。

Linux 端每個 terminal 開頭：

```bash
export PATH="$HOME/Android/Sdk/platform-tools:/home/richard/RoadScope/scratch/flutter/bin:$PATH"
```

本機偏差（與 CI 不同，記錄備查）：CI 用 JDK 21，本機唯一有 `javac` 的 64-bit JDK 是 `/opt/android-studio/jbr`（JDK 25），所以本機的 gradle 與 APK 是在 JDK 25 下產生。

## 2. 安裝

```bash
adb devices -l
```

```bash
adb install -r apps/mobile/build/app/outputs/flutter-apk/app-debug.apk
```

**絕對不要 uninstall。** 解除安裝會清掉 §3 的 MIUI 設定、通知權限，以及手機上既有的紀錄檔。實測 `install -r` 會保留全部四項，連記錄中的 `prefs.state` 都保留（安裝會終止程序，但不會改資料）。

```bash
adb shell dumpsys package tw.idv.richardwutt.roadscope | grep -E "versionCode|versionName|lastUpdateTime"
```

## 3. 權限（MIUI 上是必要條件，不是建議）

定位權限**走 App 自己的請求流程**，不要用 adb 授予，否則測不到真實路徑。

通知權限目前程式碼未在執行期請求（見 `handoff-to-codex.md` H1），需手動給：

```bash
adb shell pm grant tw.idv.richardwutt.roadscope android.permission.POST_NOTIFICATIONS
```

手機上另外開啟：設定 → 應用設定 → 應用管理 → RoadScope → **自啟動**開啟、**省電策略**設為無限制。

驗證三項都生效：

```bash
adb shell cmd appops get tw.idv.richardwutt.roadscope | grep -E "MIUIOP|POST_NOTIF"
```

```bash
adb shell dumpsys deviceidle whitelist | grep roadscope
```

判讀方式：

- `MIUIOP(10008)` 從 `ignore` 清單消失＝自啟動已允許。該 op 在服務被系統重建的當下會被查詢（實測 `allow; time=+6m39s ago` 正好對應 SIGKILL 時刻），所以它就是自啟動權限。
- `MIUIOP(10020)`／`(10021)` 由 `ignore` 變 `allow` 對應省電策略。
- `deviceidle whitelist` 出現該套件＝電池最佳化白名單，`dumpsys` 的 `tempAllowListReason: SYSTEM_ALLOW_LISTED` 即由此而來，這是前景服務得以從背景啟動的豁免。

**實測差異**（同一台機器、同一個 APK）：

| 環境 | SIGKILL 後 180 秒內 |
|---|---|
| 三項皆未開 | **零重建**，ActivityManager 連 ServiceRecord 都移除 |
| 三項皆開 | **5 秒內重建**，寫出 `recording_resumed`，續錄未中斷 |

三項是一起改的，**無法分辨哪一項是決定性的**。要分辨必須逐項開關重測。

## 4. 短測流程

每次開始記錄都必須由**人在手機上點按**，MIUI 封鎖 `adb shell input`（見 §7）。

### A — 功能確認（約 3 分鐘，室外）

開始記錄 → 確認通知欄出現常駐通知 → 等速度與「有新定位」→ 檢查 telemetry 區塊的電量、充電、App 狀態（應為「前景」）、螢幕可互動、keyguard、定位服務狀態、telemetry 時間、可匯出 → 停止。

```bash
adb shell dumpsys activity services tw.idv.richardwutt.roadscope | grep -E "isForeground|startRequested|allowStartForeground"
```

要看到 `isForeground=true`、`types=00000008`（`FOREGROUND_SERVICE_TYPE_LOCATION`）、`stopIfKilled=false`（＝START_STICKY）。

### B — 螢幕／前後台轉換（約 5 分鐘，每步間隔 ≥20 秒）

Home → 關螢幕 → 等 30 秒 → 解鎖 → 回 App → 接充電線 → 拔充電線 → 開省電模式。

預期 telemetry 依序出現 `app_lifecycle`、`screen_interactive`、`keyguard_locked`、`battery_charging`＋`battery_power_source`、`power_save_mode` 等 `reasons`。

### C — 服務／程序恢復

C1：從近期工作清單滑掉 App，再查 §4 的 dumpsys —— 實測服務存活。
（telemetry 分不出「滑掉」與「切背景」，見 `handoff-to-codex.md` H5。）

C2，`am crash`（崩潰路徑）：

```bash
adb shell am crash tw.idv.richardwutt.roadscope
```

C2-b，SIGKILL（系統回收路徑，更接近 START_STICKY 的設計情境）：

```bash
adb shell run-as tw.idv.richardwutt.roadscope toybox kill -9 $(adb shell pidof -s tw.idv.richardwutt.roadscope)
```

**必須用 `toybox kill`**；`run-as` 內建的 `kill` 會回 `Permission denied`。

殺完後每 5 秒輪詢，至少 180 秒（AMS 的重啟退避可能到數十秒）：

```bash
for i in $(seq 1 36); do date -u +%H:%M:%S; adb shell pidof -s tw.idv.richardwutt.roadscope; adb shell dumpsys activity services tw.idv.richardwutt.roadscope | grep -c "isForeground=true"; sleep 5; done
```

### D — 權限降級

記錄中撤銷定位權限或關閉系統定位。預期畫面顯示記錄錯誤、telemetry 最後一列 `locationServiceState: failed` 且 `locationServiceDetail` 有文字，**不得**把沒有定位顯示成速度 0。

## 5. 長時間驗收

`docs/engineering-rules.md` §3 要求 30 分鐘與 2 小時各一次**含鎖屏區段**的完整採集。

必須先記下、否則事後算不出來的條件：

- 起始電量 % 與開始的 UTC 時間
- **手機不接電源**（實測一次 38 分鐘測試有 30.5 分鐘在充電，耗電完全算不出來）
- 螢幕關閉比例、App 前後台比例（可事後由 telemetry 算，但要確認符合測試設計）
- 地點、天空遮蔽、是否移動（目前所有測試都在靜止或近靜止）
- 省電模式狀態、手機溫度

流程：前景 5（／10）分 → 鎖屏 20（／100）分 → 前景 5（／10）分 → 停止 → 分別匯出兩個檔案。

## 6. 取檔

### 走 App 匯出（驗證匯出流程本身）

先停止記錄，再分別按「匯出 location-log v1」與「匯出 diagnostics telemetry」。兩次分享文字不同，這就是格式分離的驗證點。

### 走 adb（適合反覆測試；debug build 才可用）

```bash
adb shell run-as tw.idv.richardwutt.roadscope ls -l files/recordings files/diagnostics
```

```bash
adb exec-out run-as tw.idv.richardwutt.roadscope cat files/recordings/<ID>.ndjson > ~/roadscope-fieldtest/location.ndjson
```

用 `exec-out` 而非 `shell`，避免換行被轉成 CRLF。

## 7. 工具限制（這些不是待修項目，但會改變測試方式）

1. **MIUI 封鎖 `adb shell input`**，需要「USB 偵錯（安全設定）」，而該選項要登入小米帳號。因此無法自動點按，每次開始／停止記錄都要人工操作。`uiautomator dump` 可用（唯讀），但無法點按。
2. **`am start-foreground-service` 無法由 shell 啟動本服務**（`android:exported="false"`，回 `Requires permission not exported from uid`）。失敗的嘗試會在 AMS 留下一筆 `app=null`、`startForegroundCount=0` 的殘留 ServiceRecord，判讀時要用 `isForeground=true` 與 `startRequested=true` 過濾，不要只數 ServiceRecord。
3. **MIUI 幾乎關閉 AMS 的生命週期日誌**。一次 160 秒的 `logcat -b main -b crash` 共 26799 行，其中只有 8 行 `ActivityManager` 且全部無關。看不到 `Scheduling restart of crashed service` 或 `ForegroundServiceStartNotAllowedException`，所以**「logcat 沒有重啟訊息」不能當成「系統決定不重啟」的證據**。可靠觀測是輪詢 `dumpsys activity services` 的 `isForeground` 與 `pidof`。
4. **原生端沒有任何 log 輸出**（無 `Log.*`／`NSLog`），所以 logcat 只對崩潰與系統訊息有用。
5. **`apps/mobile/android/gradlew` 未被版控追蹤**。CI 能跑是因為 `flutter build apk` 排在 `./gradlew` 之前會產生 wrapper；乾淨 checkout 上單獨跑 gradle 需先 `flutter build` 或自備 gradle。

## 8. 分析命令

定位紀錄必須 0 error：

```bash
node contracts/tools/validate-location-log.mjs ~/roadscope-fieldtest/location.ndjson
```

```bash
cd packages/mobile_data && dart run bin/inspect_log.dart ~/roadscope-fieldtest/location.ndjson
```

telemetry 必須 0 bad lines：

```bash
cd packages/device_bridge && dart run bin/inspect_telemetry.dart --strict ~/roadscope-fieldtest/telemetry.ndjson
```

telemetry 狀態時間軸：

```bash
jq -r '[.telemetrySequence,.trigger,.occurredAtUtc,.batteryPercent,.batteryCharging,.screenInteractive,.keyguardLocked,.appLifecycle,.locationServiceState,.locationLogLastSequence]|@tsv' ~/roadscope-fieldtest/telemetry.ndjson | column -t
```

只看改變了什麼：

```bash
jq -r '[.occurredAtUtc, .trigger, (.reasons|join(","))]|@tsv' ~/roadscope-fieldtest/telemetry.ndjson | column -t
```

確認 telemetry 沒有位置資料（**應無輸出**）：

```bash
grep -cE '"(latDeg|lonDeg|speedMps|headingDeg)"' ~/roadscope-fieldtest/telemetry.ndjson
```

定位樣本間隔 >5 秒的空窗，再回去對照 telemetry 當時的狀態：

```bash
jq -r 'select(.recordType=="sample")|[.sequence,.measuredAtUtc,.measurementMonotonicUs]|@tsv' ~/roadscope-fieldtest/location.ndjson | awk -F'\t' 'NR>1 && ($3-p)/1000000 > 5 {printf "gap %.1fs before seq %s at %s\n", ($3-p)/1000000, $1, $2} {p=$3}'
```

## 9. 判讀陷阱

1. **telemetry 間隔 >300 秒不是異常。** heartbeat 是下限不是週期，被略過的觸發不會提前補排，列間隔上限約 600 秒（實測 max 581 秒）。狀態變化頻繁時 heartbeat 可能一列都不寫，那也是正確的。
2. **telemetry 有缺口不等於採集中斷。** 程序被系統暫停期間不會有任何 telemetry。
3. **沒有 `recording_interrupted` 不代表正常結束。** 使用者從此沒再開 App 就沒人補寫。要同時比對最後一筆的時間與預期結束時間。
4. **兩個螢幕欄位不能互相推導**（見 `diagnostics-telemetry.md` §6）。
5. **耗電必須排除充電區段**，並記下螢幕關閉與前後台比例，否則數字不可比。
6. **把 telemetry 檔餵給 `validate-location-log.mjs` 會 PASS**（`0 samples, 0 events` ＋ `UNKNOWN_RECORD_TYPE` 警告）。那是契約 §4 對未知 `recordType` 的正確行為，不是驗證通過。
7. 電源來源是作業系統回報值。實測接筆電 USB 時該機仍可能回報 `ac`，不是我們判斷錯。

## 10. 證據索引

以下目錄在 `testdata/private/fieldtest/`，**含真實座標，不進版控**。每個目錄都有自己的 README 記錄條件與結論。

| 目錄 | 內容 | 證明什麼 |
|---|---|---|
| `2026-10-03-short-b` | 短測 B，137 樣本／11 telemetry | 螢幕與前後台轉換、鎖屏 28.8 秒不中斷、對齊 11/11 |
| `2026-10-03-short-c` | 短測 C（`am crash`），46 樣本／4 telemetry ＋ `adb-console.txt` | 崩潰後零重建（舊權限）、崩潰前 59 ms 的 append 完整落盤 |
| `2026-10-04-short-c2b` | C2-b（SIGKILL，舊權限）＋完整 logcat／dumpsys | 154 秒零重建；AMS 日誌不可觀測 |
| `2026-10-04-short-c2b-rerun` | C2-b（SIGKILL，新權限） | **5 秒內重建**並正確續錄 352 筆 |
| `2026-10-04-interrupted-marker` | `recording_interrupted` 端對端 | 補寫的 `locationLogLastSequence` 等於紀錄實際最後序號；location-log 未被加事件 |
| `2026-10-04-short-ab-after-fix` | 短測 A＋B（修復後），245 樣本／8 telemetry | `appLifecycle` 初始值修復；精度中位 1.6 m |
| `2026-10-04-30min` | 38.4 分，2304 樣本／39 telemetry | 資料完整，但**全程充電且螢幕關閉僅 2.7%**，不符驗收條件 |
| `2026-10-04-2hour` | **201 分，12063 樣本／107 telemetry** | 零缺口、無 >2 秒空窗、鎖屏 92.1%、heartbeat 10 列、耗電 −9.5 %/小時 |
| `2026-10-04-env-after-permission-change.txt` | 權限調整後的 appops／白名單快照 | 長時間測試的環境基準 |
