# RoadScope

汽機車計時 App：iOS／Android，台灣優先。第一版專注山路路段與賽道計時，之後擴充日常紀錄與車隊即時位置。

**目前狀態：已有 Flutter 手機骨架；P0 原生記錄器仍在 Draft PR 與真機驗證階段。後端與外部帳號狀態請以目前 repository／PR 為準。**

## 快速入口

| 你是 | 先讀 |
|---|---|
| Codex（UI／原生整合／客戶端） | [`AGENTS.md`](AGENTS.md) |
| Claude Code（資料／計時／伺服器／契約） | [`CLAUDE.md`](CLAUDE.md) |
| 協助 iOS 測試的朋友 | [`05-mac-iphone-checklist.md`](05-mac-iphone-checklist.md) |
| 任何接手的 agent | [`docs/engineering-rules.md`](docs/engineering-rules.md) |

## 目錄結構

```text
apps/mobile/            Codex：Flutter UI、App 組裝與平台入口
packages/timing_core/   Claude Code：純 Dart 計時與重播
packages/device_bridge/ Codex：Swift／Kotlin 原生模組
packages/mobile_data/   Claude Code：資料、恢復與匯出（P0 真機驗證後交接）
services/api/           Claude Code：HTTP 與 WebSocket
infra/                  Claude Code：部署與環境範例
supabase/migrations/    Claude Code：資料庫遷移
contracts/              共同規格，Claude Code 主筆、雙端驗證
testdata/               公開合成測試資料；真實軌跡另行授權
docs/                   架構、驗收、決策與操作文件
```

各目錄內容與交接狀態以目前原始碼及 `docs/engineering-rules.md` 為準。
