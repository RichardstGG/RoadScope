# C2 有界驗證器復核

## 最新復核：6f98f2c（2026-10-09）

受審提交 `6f98f2c588f5d927cc89912687ceef2a5c635996`，分支 contracts/motion-lean-c2。
**原六個反例已通過，C2 仍暫不驗收：剩餘 C2-4（P1）為跨階段報告收尾不完整。**
本次只有 consumer 腳本及復核文件，手機 runtime 仍為 `63e1b91`。

### 已確認的修正

- 輸入先開啟，findings 輸出以不截斷開啟後，透過同一描述元核對 dev／ino 再截斷。
  原三種別名均 exit 2，輸入雜湊不變；契約測試另涵蓋 --motion／--parent 及相對路徑。
- 驗證中途中止的 NOT_JSON 已保留，指定輸出有 VALIDATION_INCOMPLETE；
  文字與 JSON 在既有單檔驗證中止案例均保留部分結果。
- 格式探測共用行長限制，64 MiB 首行已在累積超限時拒絕；文字輸出期間 SIGINT 為 130。

### C2-4：沒有 active sink 時丟掉既有輸出，JSON 輸出中止未收尾（P1）

固定提交的 `contracts/tools/validate-motion-lean.mjs`：
1956 行在 probe 前設定 sink=null；1973 行在結果輸出前設定 sink=null；
2059 行在 sink=null 時直接 return，跳過已有輸出排空、JSON 收尾及未完成項目。
「沒有正在驗證的 findings sink」不能代表「沒有待交付的結果」。

獨立合成反例（一次取消後 stdout 仍可寫，沒有第二次取消或 EPIPE）：

| 情境 | exit | 實際輸出 | 應有行為 |
|---|---:|---|---|
| 第一檔完成且含 NOT_JSON，第二檔首行 >1 MiB，文字模式 | 3 | stdout 0 bytes | 保留第一檔結果，第二檔 INCOMPLETE |
| 第一檔就在 probe 遇超長首行，--json | 3 | stdout 0 bytes | 合法 JSON，含未完成項目，kind 可未知 |
| 第一檔完成且含 NOT_JSON，第二檔 probe 遇超長首行，--json | 3 | stdout 0 bytes | 保留第一檔 findings，附第二檔未完成項目並關閉 JSON |
| 4 MiB many-findings 的 --json，首批輸出後送一次 SIGINT，暫停讀取 200 ms 再繼續 | 130 | 約 65 KiB 未關閉 JSON，JSON.parse 失敗 | 明確標示輸出未完成並有合法 JSON |

請分開管理驗證進度與報告輸出進度，讓受控失敗共用收尾流程，不以 sink 是否存在決定
是否交付報告。probe 前即建立目前檔案的未完成上下文；既有文字結果須排空；
JSON writer 須知道自己正在輸出哪個項目，能在一次取消後完成結構收尾，並標示輸出未完成。
不能只在目前提早 return 前補 json.end()：若取消發生於 json.result() 中間，項目本身也未關閉。
成功輸出格式保持 C1 等價；再次取消或 stdout 本身失效可明列無法完成報告的例外。

### 本輪證據

- automated tests：21 location、274 v2 檔案一致、345 motion／lean、820 C1 等價、
  56 CLI 失敗檢查全通過；四個 C1 consumer 反例仍全部被拒絕。
- automated tests（consumer）：原六項通過，新增四項 C2-4 斷言失敗，腳本 exit 1。
- automated tests（4 MiB）：七組 profile 對 C1 的 findings 全部一致。
- static validation：六個變更檔案、描述元身分核對、tee／guard／JSON writer 與失敗清理生命週期。
- mock／manual／hardware tests：未執行，未操作手機。
- untested：Windows／macOS、契約 GitHub CI；--location／qualification registry 仍未實作。
  私有 v1 的 PASS 是前輪 b298ea8 的實跑，本輪沒有重跑，不把它寫成 6f98f2c 的新證據。

### RSS 量測修正

本機實驗確認父行程的配置會影響子行程 getrusage：同一小子程式的 VmHWM 約 42,724 KiB，
父行程持有 200 MiB 時，子程式 maxRSS 為 208,088 KiB；小父行程則兩值約 42,700 KiB。
接受同時回報 VmHWM／getrusage 的修正，大檔仍取兩者較大值。
consumer 的 64 MiB 首行改為逐 64 KiB 寫入，避免父行程自行配置大型緩衝；
修正版實測兩種峰值均約 64.8 MiB（環境觀測，非承諾）。
同一低記憶體父行程腳本重跑 b298ea8，首行案例仍約 320.2 MiB，
確認前輪超過 256 MiB 的阻擋不是父行程緩衝造成的假象。

### 本輪 2 GiB 獨立重跑

固定提交的七組 **7／7 完整通過**，各為 2 GiB motion＋約 0.35 GB 配對 lean，
以磁碟索引與預設安全網執行，沒有 exit 3／130；含錯誤的 profile 如預期 exit 1。
兩種 RSS 指標本輪各組相同，下表列兩者較大值。

| 合成 profile | exit | 峰值 RSS（MiB） | 耗時（秒） | 暫存峰值（MiB） |
|---|---:|---:|---:|---:|
| valid | 0 | 195.9 | 105.2 | 835 |
| tail-corrupt | 1 | 191 | 101.7 | 835 |
| long-duplicate | 1 | 187.4 | 105 | 837 |
| session-churn | 0 | 193.1 | 99.7 | 820 |
| dangling-refs | 1 | 191.6 | 102.5 | 835 |
| clock-churn | 0 | 198.2 | 159.7 | 818 |
| many-findings | 1 | 189.2 | 104 | 1001 |

各組 findings 與前輪相同，many-findings 完整保存並核算 1,733,351 個警告與 173,336 個錯誤。
這些完整完成案例不涵蓋 C2-4 的跨階段中止，不能代替其修正。
本輪 Node 22.23.3／Linux；鎖檔與前輪一致，獨立副本沿用前輪安裝的相同依賴。
耗時與磁碟用量僅為本機觀測。重跑命令見下方首輪記錄，使用本輪受審 checkout。

使用者本輪不需指令或手機測試。下一步修正 C2-4 並復核；S1 仍是下一手機切片，
不因此標記 S3／S4 或 PR #2 完成，C3 仍等待 S5。

## 首輪復核：b298ea8（以下保留歷史證據）

2026-10-09；契約分支 contracts/motion-lean-c2，提交
`b298ea8e569d7c92453eb1a2f936772996dbeaa4`，基於已接受 C1 `36662fa`。
Codex runtime 仍為 `63e1b91`；本輪只有審查及合成反例，不改契約或手機程式。

## 結論

**C2 暫不驗收：三項執行層問題需修正。** C1 小檔語義相容已驗證；
輸入保護、失敗時 findings 保留及偵測階段記憶體界線未滿足要求，不能當成 S3／S4 完成。
不需重開契約資料語義，C2 修正後仍以 C1 的規則結果為準。

## C2-1：findings 輸出可以清空輸入檔（P1）

CLI main 在驗證前以 FileSink 開啟 --findings-out，FileSink 使用 openSync(path, 'w')。
若輸出是任一輸入檔的同一路徑、symlink 或 hardlink，輸入立即截成空檔。
已用 3,854-byte 合法合成 fixture 的獨立副本重現三種別名，三者均被截成 0 bytes，exit 1。

請在任何截斷操作前核對輸出與所有 positional inputs、--motion、--parent 的檔案身分，
拒絕別名，保留每個輸入的 byte hash；不能只比較 resolve(path) 字串。
實作可用已開啟描述元的身分及非截斷開啟策略消除檢查／使用間的漏洞。
新增同路徑、相對路徑、symlink、hardlink、--motion／--parent 別名案例；失敗須非零且資料不變。

## C2-2：容量失敗前已找到的 findings 被刪掉（P1）

runAsync 先把 findings 寫到本次暫存 sink。CLI 只在整檔 validateFile 成功返回後，
才複製到使用者指定 --findings-out；throw 後 finally 卻會刪掉暫存。
因此「合法基底＋not-json 行＋1 MiB 以上行」先產生 NOT_JSON，接著 LINE_TOO_LONG
退出 3，stdout 沒有 findings，指定 JSONL 也是 0 bytes；已發現結果消失。

請在驗證過程即串流保存到指定輸出，或在失敗／取消路徑完整排出已發現結果；
明示結果未完成，絕不標 PASS。取消、RSS、磁碟／findings IO 失敗也須測試，
能保存的診斷不要因索引清理丟失。保持既有成功輸出的 C1 格式與順序。
沒有 --findings-out 時，已知 findings 也須在預設輸出可取得。

## C2-3：kind／version 偵測繞過行長與資源保護（P1）

detectKind 與 detectSchemaVersion 使用 input.lines(Number.MAX_SAFE_INTEGER)，
在 runAsync 的 maxLineBytes／guard 之前讀完整超長行並解碼／JSON.parse。
用「64 MiB 非 JSON 首行＋合法 fixture」及預設 1 MiB 行長限制重現：
最後 exit 3／LINE_TOO_LONG，但子行程 maxRSS 約 320 MiB，peakSampledRssBytes=0。
這不是通過資源驗收，也不能用最終非零退出掩蓋拒絕前的無界配置。

請所有掃描階段共用相同行長上限與 guard，包含無法識別 kind／version 的輸入、
開頭空白／未知行、格式探測、父檔處理及輸出重播；需要取消的長迴圈仍需讓訊號被處理。
超長行須在串流累積超限時拒絕，不先組合整行；新增超長首行與前導未知資料的有界失敗測試。
驗收須看實際子行程峰值，不能只看 watchdog 回報或採樣值。

另以 4 MiB many-findings 合成資料，在首批 stdout findings 出現後暫停讀取、送 SIGINT，
200 ms 後恢復讀取。CLI 繼續排完結果並 exit 1，而非取消所需的 130。
取消保護不能只作用於驗證迴圈，輸出排空也須觀察取消並回報未完成狀態。

## 已接受的相容與分工

- --summary 搭配 --findings-out、16 MiB auto 後端門檻、exit 3／130 的規約符合手機測試呼叫；
  實作仍須修正上述失敗路徑。
  tmp-dir 可選、安全預設保留；實際大檔使用實體磁碟，不以 tmpfs 承擔長時間索引。
- canonical 雜湊縮為 16 bytes 可接受：同 hash 仍回讀並 canonical 比較，碰撞不影響正確性。
  兩後端的宣告／序號／引用語義經差異測試確認。
- 等待 stdout 排空是對 C1 截斷缺陷的有意修正，不要求複製舊缺陷；大量輸出仍須完整、有界。
- Linux 的鎖版 SQLite 驅動安裝及磁碟路徑已跑過。Windows／macOS 為 untested，
  不能宣稱跨平台已支持；後續應補相應安裝／煙霧測試，保留 Linux 驗收範圍。
- --location／qualification registry 仍未實作；既有 qualified 宣告不等於本機核驗資格，
  不開啟正式最大值或三種 replayScope。C3 仍等待 S5，不屬本輪。

## 驗證與重現

固定提交的獨立暫存副本，Node 22.23.3／Linux，未切換 Claude 的可寫 checkout。
原生套件安裝與子行程測試需要允許子行程管線；沙盒首次 EPERM 的結果未當作產品失敗。

- automated tests：21 location fixtures、274 v2 檔案一致、345 motion／lean、
  820 C1 等價、17 CLI 失敗檢查全通過；四個 C1 consumer 反例仍全部拒絕。
- automated tests（C2 consumer）：三種輸入別名均失敗；部分 findings 保留失敗；
  超長首行在拒絕前超過 256 MiB；輸出時 SIGINT 未回傳 130。
  共六個拒絕斷言失敗，對應以上三項問題。
- static validation：io／store／CLI 生命週期與保護界線、CI 設定、規範文字。
- automated tests（私有）：本機既有 v1 motion／lean 全量配對驗證 PASS（含 V1-4／V1-5）；
  詳細路徑、findings 與紀錄保留在 Git 忽略的私有目錄，只對外回報 PASS，不公開統計。
- mock／manual／hardware tests：本輪未執行，未操作手機。

### 合成大檔

七組 2 GiB motion＋約 0.35 GB 配對 lean，以 `--index disk --motion M M L`
及預設安全網完整跑測，**7／7 通過**。這裡通過表示完整結束、預期錯誤全部被檢出且
實際子行程峰值 ≤256 MiB；exit 1 的資料本身仍不合法，未將 exit 3／130 算通過。

| 合成 profile | exit | 峰值 RSS（MiB） | 耗時（秒） | 暫存峰值（MiB） |
|---|---:|---:|---:|---:|
| valid | 0 | 194.8 | 103.5 | 837 |
| tail-corrupt | 1 | 186.3 | 100.6 | 835 |
| long-duplicate | 1 | 196.4 | 101 | 835 |
| session-churn | 0 | 197.8 | 98.9 | 820 |
| dangling-refs | 1 | 196.1 | 103.7 | 835 |
| clock-churn | 0 | 190.6 | 158.7 | 818 |
| many-findings | 1 | 188.3 | 104.7 | 1002 |

many-findings 的完整 JSONL 經串流核算，保留 1,733,351 個警告及 173,336 個錯誤。
尾行損壞、長距離重複／衝突、懸空引用均出現預期結果；其餘合法 profile 沒有 findings。
上述峰值來自子行程 getrusage／maxRSS，耗時與磁碟用量是本機觀測，不是性能承諾。
另外七組 4 MiB profile 在函式庫層逐筆比對 C1 findings，**7／7 完全一致**。

重跑大檔的命令（scratch 必須在實體磁碟，有足夠空間；只用合成資料）：

```bash
node contracts/tools/test/run-large.mjs --bytes 2147483648 --dir /path/to/scratch --clean-inputs
node contracts/tools/test/run-large.mjs --bytes 4194304 --dir /path/to/small-scratch --compare-reference --clean-inputs
```

這七組正常完成案例不涵蓋 C2-3 的超長首行與輸出時取消；不能代替失敗路徑修正。

### 可重跑腳本

```bash
node packages/device_bridge/bin/review_c2_cli.mjs /path/to/C2-checkout
```

該 checkout 需安裝 contracts/tools 鎖版依賴。只使用臨時合成副本並自行清理，
任何失敗斷言即 exit 1；不讀私人資料、不改契約。

使用者本輪無需執行指令或測試手機。下一步由契約主筆修正上述三項並補失敗路徑矩陣，
Codex 復核後才接受 C2；手機端下一開發切片仍為 S1。C1／C2 尚無 PR，GitHub contracts
CI 尚未驗證；本輪不代開、核准或合併契約 PR。
