# PR #11 Android 傾角驗收與 Draft 門檻

這是實驗性 Android 傾角功能驗收，不是道路精度認證，也不是 PR #2 交接。
使用 PR #11 最新 HEAD 的 APK，記錄 commit、APK SHA256、手機型號／Android／安裝位置。
不把之前 GPS 30 分鐘測試、安裝成功或 CI 當成本版真機證據。
Android V1.0 基礎功能及 UI 真機通過前，不安排 iOS 真機；iOS 僅建置／降級相容。

## 轉出 Draft 前檢查

- [ ] 最新 HEAD 的 Android／iOS CI 通過。
- [x] 本機原生／App／bridge 測試、分析與 motion／lean 契約逐檔＋配對通過；最新 HEAD CI 另查。
- [ ] 本版 Android 停車校準與實際 UI 操作通過，無靜默顯示假角度。
- [ ] 本版背景連續採集短測通過，正常停止／匯出／重開可用。
- [ ] 安全行程可取得合格 GPS 時，驗證自動參考及未確認軸保持空值。
- [ ] 審查全部 PR diff，處理阻擋問題；說明未涵蓋硬體與依賴 PR。

尚缺真機時保留 Draft。轉出 Draft 不等於批准合併；不自行 approve／merge。
契約 PR #10 與 base PR #9 尚未合併時，明示依賴，不以改 base 隱藏依賴。

## 第一輪：停車校準與 UI（約 10 分鐘）

### 下一次先做品質阻擋診斷（約 2 分鐘，不上路）

前版 ba460d0 已遇到加速度全程 unreliable；此修正版沒有降低可靠性門檻，
不能承諾這台手機一定能校準。先安全停車，確認新版 APK，開始一筆**新記錄**：

1. 保持手機靜止約 60 秒，不做直立／左傾校準。USB 可保持連接，此輪不量耗電。
2. 核對時鐘皆 elapsed_realtime，最近已存樣本平台品質、阻擋來源與原因一致。
   若加速度 unreliable，UI 必須顯示不可靠與來源，校準禁用、角度／最大值空值，
   自動收集暫停；lean 事件原因可從 input_clock_not_verified 改為 input_interrupted。
   同原因持續時不得每筆追加事件。
3. 在安全停車且不破壞固定支架的情況下，可觀察正常移動／回靜止後品質是否改變；
   不將平放或向量量值近 g 當成精度證明，不進入 OEM 工程選單或重設手機。
4. 正常停止，保持 USB 供讀取三檔；驗證後明確通知可拔線。
   若平台品質仍不可靠，本輪只能驗收診斷及安全降級，不能算校準通過。
   需另查 OEM 品質回報或取得可用裝置；任何略過品質的產品政策需另行確認。

只有必要來源品質可用後，才執行以下停車校準與 UI 驗收。

1. 連接授權 USB，核對 APK／既有記錄未被刪除。停車安全支撐，前輪朝前，
   固定手機在車架或支架，不能手持手機冒充車身傾角。
2. 開始新記錄。三個來源時鐘由 unverified 到 elapsed_realtime 才允許校準；
   若始終不通過或 accuracy 不可用，保留紀錄回報，不放寬門檻來出數字。
3. 未校準時角度與最大值為「—」，品質應顯示 no_valid_calibration／lean_unavailable。
4. 車輛直立且靜止，按直立校準並保持至少 3 秒；確認 awaiting_left。
   不安全或無法穩定支撐就停止，不勉強傾車。
5. 安全向左傾 5–25°，按左傾確認並保持至少 3 秒；確認 calibrated、左傾為負值。
   回直立應接近零，安全右傾應為正值。沒有參考儀器時只判符號與操作，勿聲稱誤差。
6. 確認左右最大值不是單筆尖峰，取消新校準不刪舊校準；完成重校準後最大值重新從空值開始。
7. 鎖屏至少 2 分鐘，重開 UI 不必重新開始記錄。正常停止，分別匯出 GPS、motion、lean。
   驗證序號、缺口、sourceRefs、校準／分段／最大值與時鐘狀態。
8. 同一記錄的新 session／程序續錄需重新校準，舊最大值可在檔案保留，新段不可承襲。

## 第二輪：自動參考與背景（約 10–15 分鐘安全行程）

1. 新記錄，不做手動校準。先核對 GPS／感測狀態；確認未知角度不是零。
2. 正常、安全行程中包含穩定直行與鎖屏區段。勿刻意加速、傾車、看手機或操作 UI。
   核心只累計速度至少 5 m/s、品質合格且穩定的時間；30 秒是有效候選時間，非牆鐘等待。
   若路況或品質未符合門檻，未建立自動參考是正確降級，不能當作成功建立的證據。
3. 到安全停車處查看「自動直立參考已建立」，角度／左右最大值仍空值，quality 帶 lean_axis_unknown。
   未建立時匯出分析 GPS accuracy／時間／轉向／感測缺口，勿修改測試條件掩蓋原因。
4. 停車完成手動校準，確認新分段取代自動分段，UI 顯示手動優先；後續自動收集不覆蓋。
5. 正常停止與匯出，兩輪檔案皆做契約驗證。記錄鎖屏前後樣本數、頻率、缺口、
   時鐘通過比例、檔案大小、起迄電量與 error。精確軌跡只留本機，不提交 Git。

## 後續 V1.0 長測（不冒充已完成）

本版 Android 30 分鐘與 2 小時採集仍需各跑一次，包含鎖屏、task removed、
UI 重開、正常停止與匯出。USB 僅開始／結束插上，讀完狀態後明確通知可拔線。
重開機續錄另測：不自動沿用有效校準，最大值新段 null；force-stop／OEM 停服務與
正常近期清單滑掉不同。列明資料遺失／恢復邊界，不承諾斷電零遺失。
可先完成短測後轉 review，但長測、道路漂移、第二品牌 Android、真正斷電與 iOS runtime
仍是未驗證，不得在 PR 說明中刪除。合併由使用者主持。

## 本機驗證指令

從 lean-foundation worktree 執行，`contracts/tools` 使用 PR #10 固定 HEAD 的工作樹：

```bash
node ../motion-lean-contract/contracts/tools/validate-location-log.mjs /absolute/path/recording.ndjson
node ../motion-lean-contract/contracts/tools/validate-motion-lean.mjs /absolute/path/recording.motion.ndjson
node ../motion-lean-contract/contracts/tools/validate-motion-lean.mjs --motion /absolute/path/recording.motion.ndjson /absolute/path/recording.lean.ndjson
```

請替換為實際主動匯出檔案；驗證器成功只代表契約，不代表角度準確或背景續航。
原生重播比對為單元測試中的 LeanReplayAssertions，目前不是一般真機檔 CLI。
