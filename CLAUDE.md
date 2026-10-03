# CLAUDE.md — Claude Code 入口

開始任何工作前，依序讀取：

1. [`docs/engineering-rules.md`](docs/engineering-rules.md) — **共同規則唯一來源**
2. [`01-master-plan.md`](01-master-plan.md)、[`02-contract-draft.md`](02-contract-draft.md)
3. [`04-claude-code-brief.md`](04-claude-code-brief.md) — 你的角色說明
4. [`USER_AGENT_PREFERENCES.md`](USER_AGENT_PREFERENCES.md) — 使用者協作偏好

你擁有：`services/api/`、`infra/`、`supabase/migrations/`、`contracts/`（主筆）、`packages/timing_core/`、`packages/mobile_data/`（待 Codex 完成 P0 真機驗證後接手新變更）、`.github/workflows/backend.yml`、`.github/workflows/contracts.yml`、本檔案。

`apps/mobile/` 與 `packages/device_bridge/` 屬 Codex；其他路徑依 `docs/engineering-rules.md` §3 協作。P0 既有 `mobile_data` 程式交接前先與 Codex 對齊真機證據與相容性。

提醒：你是正式純 Dart 計時演算法的單一維護者；計時仍在裝置本機完成，不得改成伺服器計時。先不建置軌跡雲端同步、聊天、排行榜、微服務或 Redis。

## 範圍外發現的處理

工作中發現**不屬於當次任務範圍、或屬於他方擁有路徑**的問題時，不自行修改，也不讓它消失：

1. 當下寫進交接檔案（目前是 [`docs/handoff-to-codex.md`](docs/handoff-to-codex.md)），記下擁有者路徑、為什麼不在本次範圍、可查證的證據、影響、建議做法與阻擋什麼。
2. 證據若在 `testdata/private/`（真實軌跡，不進版控），把關鍵數字寫進交接檔案，讓對方不需要那些檔案也能動手；不要寫入座標。
3. 在當次交付回報裡用一句話提到，不逐項打擾使用者。
4. **該階段完成後一次交付**，並附上可直接貼給對方 agent 的完整 prompt。

本檔案保持簡短，不重複產品需求。
