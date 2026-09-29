# CLAUDE.md — Claude Code 入口

開始任何工作前，依序讀取：

1. [`docs/engineering-rules.md`](docs/engineering-rules.md) — **共同規則唯一來源**
2. [`01-master-plan.md`](01-master-plan.md)、[`02-contract-draft.md`](02-contract-draft.md)
3. [`04-claude-code-brief.md`](04-claude-code-brief.md) — 你的角色說明
4. [`USER_AGENT_PREFERENCES.md`](USER_AGENT_PREFERENCES.md) — 使用者協作偏好

你擁有：`services/api/`、`infra/`、`supabase/migrations/`、`contracts/`（主筆）、`.github/workflows/backend.yml`、`.github/workflows/contracts.yml`、本檔案。

`apps/mobile/` 與 `packages/` 屬 Codex，不直接修改；需要時依 `docs/engineering-rules.md` §3 提出協作請求。

提醒：計時在裝置本機完成，不得改成伺服器計時；不先建置軌跡雲端同步、聊天、排行榜、微服務或 Redis。

本檔案保持簡短，不重複產品需求。
