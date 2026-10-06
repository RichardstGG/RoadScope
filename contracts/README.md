# contracts

共同規格。Claude Code 主筆，Codex 驗證手機端可實作；修改流程見 [`docs/engineering-rules.md`](../docs/engineering-rules.md) §5。

每份契約由**規範本文（README.md）＋ 機器可檢查的 schema** 組成。兩者衝突時以本文為準：狀態機、權限與時間語義無法只靠型別表達。

| 契約 | 狀態 | 範圍 |
|---|---|---|
| [`location-log/v1`](location-log/v1/README.md) | v1 草案，待 Codex 驗證 | 裝置本機原生 NDJSON 位置紀錄與匯入規則 |
| [`motion-lean/v1`](motion-lean/v1/README.md) | v1 草案，待 Codex 確認原生可實作性 | 裝置本機原始動態感測（加速度／角速度／姿態）與衍生傾角紀錄、校準分段與最大值 |
| 車隊 HTTP（OpenAPI） | 未開始 | 待 `docs/engineering-rules.md` §10 第 1、2、3、5、6 項定案 |
| 車隊 WebSocket（JSON Schema） | 未開始 | 同上 |

`location-log` 與 `motion-lean` 不是網路協定，不經過伺服器。車隊契約與它們無共用欄位。`motion-lean` 與 `location-log` 彼此獨立：不新增 location-log 欄位，location-log v1 驗證器把 motion／lean 的每一行視為未知 `recordType` 並容忍。

## 工具

```bash
npm install --prefix contracts/tools
npm test --prefix contracts/tools        # 對全部 fixtures 斷言預期行為
node contracts/tools/validate-location-log.mjs [--json] <file.ndjson> [...]
node contracts/tools/validate-motion-lean.mjs [--json] [--motion <motion.ndjson>] <file.ndjson> [...]
```

fixtures 在 `testdata/contracts/`，與契約同版本（location-log 在 `location-log/v1/`，motion／lean 在 `motion-lean/v1/`）。

## 型別策略

JSON Schema 是唯一真實來源。目前**不生成** Dart／TypeScript 模型，兩端以同一批 fixtures 對齊；決定與重新評估時機見 [`docs/decisions/0001-location-log-format.md`](../docs/decisions/0001-location-log-format.md) D8。
