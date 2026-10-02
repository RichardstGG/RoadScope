# 給 Codex 的工作說明

請先讀取同資料夾的 01-master-plan.md 與 02-contract-draft.md。你負責 Flutter UI、App 組裝、Android／iOS 原生整合及日後的 API／WebSocket 客戶端；P0 原生採集真機驗證完成後，純 Dart 記錄資料與計時核心由 Claude Code 維護。

## 工作責任

使用 Flutter／Dart 開發 iOS／Android App 的畫面、互動、路線設定、App 組裝及 API／WebSocket 客戶端；負責 Swift／Kotlin 原生採集、單一追加紀錄寫入者、權限與背景生命週期。透過共同介面使用 Claude Code 維護的 `mobile_data` 與 `timing_core`；不要在 UI 或原生層另寫正式計時演算法。計時與記錄仍須不依賴後端可用性。

Claude Code 負責純 Dart 記錄資料、正式計時核心、伺服器與資料庫。不要把穿線計時改成伺服器計時；不要在未同步契約時自行發明另一份 API。Swift 程式仍由你負責；朋友提供 Mac／iPhone 執行與測試，不能把待寫的原生整合默認交給朋友。

## 第一張任務：bootstrap＋P0

1. 在使用者指定的 Git 專案先檢查既有檔案，建立最少必要骨架、工具版本及共用規則入口；此文件本身不代表已有 repository。
2. 將共同規則存 docs/engineering-rules.md；AGENTS.md 與 CLAUDE.md 指向同一來源。先合併 bootstrap，讓 Claude 從同一基準開始。
3. 維護 P0 既有 LocationSample 實作與合成樣本到真機驗證完成；與 Claude Code 校對時間、精度、來源和無效值，再交接 `mobile_data`。
4. 建立最小診斷 App：開始／停止、即時速度、樣本時間／間隔、精度、記錄狀態、診斷匯出。
5. Android 與 iOS 都做原生背景採集及可恢復暫存。原生追加紀錄採單一寫入者；與 Claude Code 確認資料層的序號匯入、冪等與恢復語義。
6. 建立 Linux 的分析／單元測試／Android 建置，macOS 的 iOS 建置入口；列明需要朋友實際執行的步驟。
7. 提供 30 分鐘及兩小時真機測試包與檢查表。未跑 iPhone 要明列未驗證，不能把模擬器結果當背景定位實測。

P0 先做可測量的紀錄器；不先花大量時間做完整視覺精修、帳號頁或車隊動畫。確認採集穩定後才進入 P1。

## P1 到 Alpha

實作路段／賽道設定、計時儀表、歷史與結果 UI，串接 Claude Code 維護的純 Dart 計時與資料介面。原生採集保持單一寫入者；以合成與實際診斷樣本協助整合驗證，原始資料與結果分開保存。

畫面至少涵蓋模式與路線、計時儀表、結果、歷史、設定。大字速度、清楚的記錄／定位狀態；計時不因畫面關閉或動畫刷新改變。

## 車隊階段

依 contracts 實作登入、邀請加入、上線／下線、1 Hz 上傳、快照顯示、資料年齡及直線距離。記錄與分享是獨立狀態。手動停止後禁止重連流程自行恢復分享；App 重啟預設 off。

## 交付規則

主要可修改 apps/mobile、packages/device_bridge、mobile CI 與對應測試。P0 既有 packages/mobile_data 由你完成真機驗證後交接；後續修改 packages/mobile_data 或 packages/timing_core 先依共同規則協作。跨契約變更先提交相容性說明。每個任務使用獨立分支／worktree，不與 Claude 共用可寫 checkout。

每次交付寫清楚：完成項目、測試及真機資訊、尚未驗證項目、需要 Claude 配合的契約事項。測量準確度未與參考設備比較前不宣稱數值精度。P0 完成後提出實測報告及 P1 調整，不把規劃假設當測試結果。
