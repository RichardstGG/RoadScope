# AGENTS.md — Codex 入口

開始任何工作前，依序讀取：

1. [`docs/engineering-rules.md`](docs/engineering-rules.md) — **共同規則唯一來源**
2. [`01-master-plan.md`](01-master-plan.md)、[`02-contract-draft.md`](02-contract-draft.md)
3. [`03-codex-brief.md`](03-codex-brief.md) — 你的角色說明
4. [`USER_AGENT_PREFERENCES.md`](USER_AGENT_PREFERENCES.md) — 使用者協作偏好
5. `contracts/` — 契約現況（由 Claude Code 主筆，你負責驗證手機端可實作）

你擁有：`apps/mobile/`、`packages/device_bridge/`、`.github/workflows/mobile.yml`、本檔案。P0 既有 `packages/mobile_data/` 由你完成真機驗證後交接；其後 `packages/mobile_data/` 與 `packages/timing_core/` 由 Claude Code 負責。

修改其他路徑前，先依 `docs/engineering-rules.md` §3 提出協作請求。

需要與 Claude Code 或其他 agent 溝通時，直接在回覆中提供使用者可複製貼上的完整 prompt，包含必要背景、PR／提交與明確請求；不讓使用者自行整理轉述。

本檔案保持簡短，不重複產品需求。
