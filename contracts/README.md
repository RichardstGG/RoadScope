# contracts

共同規格。Claude Code 主筆，Codex 驗證手機端可實作；修改流程見 [`docs/engineering-rules.md`](../docs/engineering-rules.md) §5。

每份契約由**規範本文（README.md）＋ 機器可檢查的 schema** 組成。兩者衝突時以本文為準：狀態機、權限與時間語義無法只靠型別表達。

| 契約 | 狀態 | 範圍 |
|---|---|---|
| [`location-log/v1`](location-log/v1/README.md) | v1 草案，待 Codex 驗證 | 裝置本機原生 NDJSON 位置紀錄與匯入規則 |
| 車隊 HTTP（OpenAPI） | 未開始 | 待 `docs/engineering-rules.md` §10 第 1、2、3、5、6 項定案 |
| 車隊 WebSocket（JSON Schema） | 未開始 | 同上 |

`location-log` 不是網路協定，不經過伺服器。車隊契約與它無共用欄位。

## 工具

```bash
npm install --prefix contracts/tools
npm test --prefix contracts/tools        # 對全部 fixtures 斷言預期行為
node contracts/tools/validate-location-log.mjs [--json] <file.ndjson> [...]
```

fixtures 在 `testdata/contracts/`，與契約同版本。

## 型別策略

JSON Schema 是唯一真實來源。目前**不生成** Dart／TypeScript 模型，兩端以同一批 fixtures 對齊；決定與重新評估時機見 [`docs/decisions/0001-location-log-format.md`](../docs/decisions/0001-location-log-format.md) D8。
