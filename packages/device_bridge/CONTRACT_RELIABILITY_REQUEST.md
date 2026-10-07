# 給 Claude Code 的完整協作 prompt

請協助 RoadScope 第 2 階段的共同契約與大檔驗證器設計定案。先依你的 CLAUDE.md
閱讀共同規則並重新核對遠端；保留各工作樹未提交修改。不要操作手機、讀取／發布私人
實測資料，不自行 approve／merge，也不要修改 Codex 工作樹。

背景與版本：

- 手機端 PR #11：https://github.com/RichardstGG/RoadScope/pull/11，branch
  `mobile/lean-foundation`，runtime 基準 `63e1b91e7a6c4d4e791c3e3cf89c42d94fd9bd36`；
  R1 文件提交 `4dd6c730dccc58a707b75c8fed5ae5d2f3819ef5`，請以最新遠端文件為準。
- 契約 PR #10：https://github.com/RichardstGG/RoadScope/pull/10，目前已核對基準
  `747493332c2dd59044a425508387b3b4d31ab24e`。PR #2、#9、#11 仍 Draft。
- 請讀 PR #11 的 `packages/device_bridge/ACCEPTANCE_BASELINE.md` 與
  `packages/device_bridge/RECORDING_RELIABILITY_DESIGN.md`。它們是驗收／設計提案，
  不是第二份契約，不應視為 schema 已生效。
- 使用者要求根本解決資料問題；原始資料和個別統計只留本機。iOS 真機仍延後。
  本輪先完成設計與必要相容性確認，不直接進入大規模程式實作。

請在你擁有的路徑內評估下列六項，對每項回覆接受／修改建議／不接受與理由，
提供確切欄位／事件／相容性方案及合法、非法 fixtures 清單；需要破壞性修改時明訂新版本，
不要另開與 PR #10 平行的共同格式：

1. 品質：將 `sensor_accuracy_unreliable`、`calibration_input_unverified` 列為已知且
   阻擋 extrema；確認實驗演算法／未驗證降採樣的資格表示。保留平台 accuracy 原值，
   不以未知旗標或空旗標集合默認正式有效。
2. 時間選樣：取代機型固定 stride，以每來源 20,000 us 測量時間桶最多選一筆真實原始樣本。
   需宣告 policy／period／version，以及桶內品質或時鐘轉換的有序控制事件。
   不改寫樣本時間、不用 storageStride=1 假裝全存、不把 intentional skip 當 buffer drop；
   在共同規格確認前 replayable 維持 false。請明訂舊宣告的相容與同檔多 session 規則。
3. 正式抗混疊輸入：全回呼進前置濾波，估算只使用已保存的衍生輸入。
   濾波值不可冒充 raw motion_sample；請評估 derived-input 型別／來源、支撐時間區間、
   延遲、品質、策略版本與引用。區分「已存輸入重播估算」「重新選校準」「raw 重做濾波」
   三種承諾。自動校準依賴未保存的 GPS heading accuracy／hint 消費順序，也須明確處理。
4. 恢復：保留 raw-before-lean sync；完整損壞／dangling-ref 檔案不刪改，拒絕該串流追加。
   若重算為新 lean 檔，請定義衍生 run 識別及關聯；不以新 epoch 掩蓋舊檔錯誤。
   手機端將補完整 boot／來源／範圍／epoch 驗證，GPS 可在 motion 失敗時獨立繼續。
5. 大檔驗證器：目前不只 readFileSync／split，sequence seen、raw model、estimates、breaks
   也無界。請設計逐行讀取＋磁碟索引／外部排序、完整 duplicate／conflict 及跨檔檢查、
   按引用所在 session 選宣告、串流 findings、暫存／取消／容量錯誤與 CLI 相容。
   工程目標為 2 GiB 合成檔、峰值 RSS ≤256 MiB；不能靠提高 heap 或省略配對規則達標。
   如選 SQLite，請明訂 Node minor／driver 與鎖版，不假定任意 Node >=22 API 相同。
6. fixtures 與遷移：列出品質轉換、時間選樣、多 session 政策、缺樣重設、衍生輸入／引用、
   截斷與完整壞行、跨 boot、長距離重複／衝突、dangling refs、大量 findings 的測試矩陣，
   保留既有 location-log v1 行為。說明哪些可沿用 v1、哪些需新版本，以及舊檔如何辨識。

請先提供設計決策與最小契約修訂範圍，不直接修改 mobile_data／timing_core，亦不替 Codex
實作 App／device_bridge。若更新 PR #10 的設計說明，附提交 SHA、差異與尚未實作項目。
請提供完整回覆，讓使用者原文交回 Codex；Codex 完成手機端可實作性驗證後再進入第 3 階段。
