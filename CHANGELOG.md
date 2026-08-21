# Changelog

## Unreleased

### Changed

- 製品セッションのインシデント処理を`report-only`へ固定し、Kit／ECC修正は専用attestationを持つ中央Operatorだけが開始できるようにしました。旧background Codex remediationは廃止しました。
- 通常のPR／pushではGitHub Actions CIを起動せず、ローカル検証と明示的なrelease処理へ分離しました。
- 独立Codexレビューが差分だけでなく変更ファイル全体、呼出元、利用側、手順順序、前提条件、ロールバック経路まで確認するようにしました。指摘は`release-blocker`、`owner-action`、`follow-up`へ分類します。
- サブエージェントRulesは自動起動を保証せず、上位指示とランタイムで許可された場合だけモデルが明示的に委任する契約へ改めました。
- Kit導入プロジェクト向けに、現HEADの`Local Merge Gate`成功後だけPRをReady化して通常squash mergeし、GitHub上の`MERGED`まで確認するCompletion方式を追加しました。従来のDraft PR停止は既定値として維持します。
- PreToolUse Hookが直接の`gh pr merge`とsuccess commit status投稿を拒否し、Local Merge GateとCompletion Gateの決定論的経路へ統一します。
- Harness incidents now route deterministically to ECC, Engineering Environment Kit, or product follow-up labels; product sessions only report them and the dedicated central Operator owns remediation.
- Default MCP connector set reduced to a single connector (`chrome-devtools`) per the new connector policy (`docs/MCP-CONNECTOR-POLICY.md`). The six previous defaults (`github`, `context7`, `exa`, `memory`, `playwright`, `sequential-thinking`) were retired after the June 2026 audit: their jobs are covered by skills wrapping CLIs/REST APIs (`github-ops`, `documentation-lookup`, `exa-search`, e2e skills) or by harness-native features (memory, extended thinking, web search). All six remain opt-in via `mcp-configs/mcp-servers.json`.

### Fixed

- plan modeではContext Builderだけを実行し、Issue作成やbranch切替を開始しないようにしました。
- 同じHEAD、base、worktree差分へ独立Codexレビューを繰り返さず、外部所有者作業だけが残るレビューを閉じられない修正ループへ入れないようにしました。CRITICAL指摘を`owner-action`へ分類することは拒否します。
- 必須Codex roleをBash backgroundで起動すると非対話Claude Code終了時に証拠が失われるため、PreToolUseで拒否してforeground完了を強制するようにしました。
- Delivery Gateが解決済みのreset script pathとsession IDを案内し、`/ecc:codex-task-reset`もinteractive shellに存在しない`CLAUDE_PLUGIN_ROOT`へ依存しないようにしました。
- Draft PR作成後のterminal DeliveryをPreToolUse Gateが再遮断しないようにし、未準備状態でも明示的なstate resetを許可しました。Gateの復旧案内は未設定の`CLAUDE_PLUGIN_ROOT`へ依存せず、解決済みscript pathを表示します。
- 調査・診断だけの依頼をDeliveryへ誤分類しないようにし、自動作成Issueのtitleを要求本文ではなく匿名fingerprintへ変更しました。
- Claude Codeの継続turnで進行中DeliveryとContext Builder証拠を再利用し、同一Issueの既存branchを優先することで、重複調査と重複branch作成を防止しました。
- clean commit後は独立Codex reviewへ決定論的に遷移し、重大指摘がない状態での追加編集ループを停止するようにしました。
- 未完了DeliveryをSessionEndまたは次回SessionStartでインシデント化し、branch不一致はfail-closeを維持しつつ同一Delivery内の重複記録と過剰なcritical昇格を抑制しました。
- Engineering Environment Kitが生成する`devcontainer.voice`をproject config schemaで受理し、Docker Desktop／Rancher Desktop／無効の各設定を同じ契約で検証するようにしました。
- Session-end incident reporting now uses an external-state lock, reconciles duplicate GitHub Issues, preserves failed reports for retry, and mirrors `needs-human` or Draft PR status to the central Issue.
- Workspace-write Codex roles no longer pass the mutually exclusive `--sandbox` and `--approve-for-me` flags together.
- Context Builder now treats explicit operational or acceptance commands that need no repository exploration as valid context-free handoffs instead of recording a false Codex failure.
- Delivery classification now ignores negated mutation constraints such as "do not change" or `変更せず`, preventing diagnostic and acceptance commands from entering the Issue/branch workflow.

## 2.0.0 - 2026-06-09

### Added

- Discord community launch: server + GitHub PR/issue/release feed, `release-announce.yml` workflow (announce + pin + Discussions cross-post), and a dependency-free community bot (`scripts/discord/ecc-bot.mjs`) with `/ecc`, `/help`, `/skill`, `/docs`, `/release`.
- `orch-*` orchestrator skill family and dynamic workflow team orchestration.
- `kubernetes-patterns` skill, worktree-lifecycle service, MCP inventory (`ecc.mcp.v1`), codex-worktree and opencode session adapters.

### Fixed

- Plugin hooks silently no-oped on Node 21+ (`require.main` undefined under `node -e`).
- Windows reliability: `CLAUDE_PLUGIN_ROOT` normalization, stdin prompt passing, symlink/chmod test guards.
- Session-end `$`-sequence corruption, project-detect boundary matching, install manifest gaps, corrupted legacy shim truncation.

### Changed

- Version graduated to 2.0.0 stable across package, plugin, marketplace, OpenCode, and agent metadata.
- Smaller default OpenCode install surface; `rules/zh` removed from the always-loaded default install.

## 2.0.0-rc.1 - 2026-04-28

### Highlights

- Adds the public ECC 2.0 release-candidate surface for the Hermes operator story.
- Documents ECC as the reusable cross-harness substrate across Claude Code, Codex, Cursor, OpenCode, and Gemini.
- Adds a sanitized Hermes import skill surface instead of publishing private operator state.

### Release Surface

- Updated package, plugin, marketplace, OpenCode, agent, and README metadata to `2.0.0-rc.1`.
- Added `docs/releases/2.0.0-rc.1/` with release notes, social drafts, launch checklist, handoff notes, and demo prompts.
- Added `docs/architecture/cross-harness.md` and regression coverage for the ECC/Hermes boundary.
- Kept `ecc2/` versioning independent for now; it remains an alpha control-plane scaffold unless release engineering decides otherwise.

### Notes

- This is a release candidate, not a GA claim for the full ECC 2.0 control-plane roadmap.
- Prerelease npm publishing should use the `next` dist-tag unless release engineering explicitly chooses otherwise.

## 1.10.0 - 2026-04-05

### Highlights

- Public release surface synced to the live repo after multiple weeks of OSS growth and backlog merges.
- Operator workflow lane expanded with voice, graph-ranking, billing, workspace, and outbound skills.
- Media generation lane expanded with Manim and Remotion-first launch tooling.
- ECC 2.0 alpha control-plane binary now builds locally from `ecc2/` and exposes the first usable CLI/TUI surface.

### Release Surface

- Updated plugin, marketplace, Codex, OpenCode, and agent metadata to `1.10.0`.
- Synced published counts to the live OSS surface: 38 agents, 156 skills, 72 commands.
- Refreshed top-level install-facing docs and marketplace descriptions to match current repo state.

### New Workflow Lanes

- `brand-voice` — canonical source-derived writing-style system.
- `social-graph-ranker` — weighted warm-intro graph ranking primitive.
- `connections-optimizer` — network pruning/addition workflow on top of graph ranking.
- `customer-billing-ops`, `google-workspace-ops`, `project-flow-ops`, `workspace-surface-audit`.
- `manim-video`, `remotion-video-creation`, `nestjs-patterns`.

### ECC 2.0 Alpha

- `cargo build --manifest-path ecc2/Cargo.toml` passes on the repository baseline.
- `ecc-tui` currently exposes `dashboard`, `start`, `sessions`, `status`, `stop`, `resume`, and `daemon`.
- The alpha is real and usable for local experimentation, but the broader control-plane roadmap remains incomplete and should not be treated as GA.

### Notes

- The Claude plugin remains limited by platform-level rules distribution constraints; the selective install / OSS path is still the most reliable full install.
- This release is a repo-surface correction and ecosystem sync, not a claim that the full ECC 2.0 roadmap is complete.

## 1.9.0 - 2026-03-20

### Highlights

- Selective install architecture with manifest-driven pipeline and SQLite state store.
- Language coverage expanded to 10+ ecosystems with 6 new agents and language-specific rules.
- Observer reliability hardened with memory throttling, sandbox fixes, and 5-layer loop guard.
- Self-improving skills foundation with skill evolution and session adapters.

### New Agents

- `typescript-reviewer` — TypeScript/JavaScript code review specialist (#647)
- `pytorch-build-resolver` — PyTorch runtime, CUDA, and training error resolution (#549)
- `java-build-resolver` — Maven/Gradle build error resolution (#538)
- `java-reviewer` — Java and Spring Boot code review (#528)
- `kotlin-reviewer` — Kotlin/Android/KMP code review (#309)
- `kotlin-build-resolver` — Kotlin/Gradle build errors (#309)
- `rust-reviewer` — Rust code review (#523)
- `rust-build-resolver` — Rust build error resolution (#523)
- `docs-lookup` — Documentation and API reference research (#529)

### New Skills

- `pytorch-patterns` — PyTorch deep learning workflows (#550)
- `documentation-lookup` — API reference and library doc research (#529)
- `bun-runtime` — Bun runtime patterns (#529)
- `nextjs-turbopack` — Next.js Turbopack workflows (#529)
- `mcp-server-patterns` — MCP server design patterns (#531)
- `data-scraper-agent` — AI-powered public data collection (#503)
- `team-builder` — Team composition skill (#501)
- `ai-regression-testing` — AI regression test workflows (#433)
- `claude-devfleet` — Multi-agent orchestration (#505)
- `blueprint` — Multi-session construction planning
- `everything-claude-code` — Self-referential ECC skill (#335)
- `prompt-optimizer` — Prompt optimization skill (#418)
- 8 Evos operational domain skills (#290)
- 3 Laravel skills (#420)
- VideoDB skills (#301)

### New Commands

- `/docs` — Documentation lookup (#530)
- `/aside` — Side conversation (#407)
- `/prompt-optimize` — Prompt optimization (#418)
- `/resume-session`, `/save-session` — Session management
- `learn-eval` improvements with checklist-based holistic verdict

### New Rules

- Java language rules (#645)
- PHP rule pack (#389)
- Perl language rules and skills (patterns, security, testing)
- Kotlin/Android/KMP rules (#309)
- C++ language support (#539)
- Rust language support (#523)

### Infrastructure

- Selective install architecture with manifest resolution (`install-plan.js`, `install-apply.js`) (#509, #512)
- SQLite state store with query CLI for tracking installed components (#510)
- Session adapters for structured session recording (#511)
- Skill evolution foundation for self-improving skills (#514)
- Orchestration harness with deterministic scoring (#524)
- Catalog count enforcement in CI (#525)
- Install manifest validation for all 109 skills (#537)
- PowerShell installer wrapper (#532)
- Antigravity IDE support via `--target antigravity` flag (#332)
- Codex CLI customization scripts (#336)

### Bug Fixes

- Resolved 19 CI test failures across 6 files (#519)
- Fixed 8 test failures in install pipeline, orchestrator, and repair (#564)
- Observer memory explosion with throttling, re-entrancy guard, and tail sampling (#536)
- Observer sandbox access fix for Haiku invocation (#661)
- Worktree project ID mismatch fix (#665)
- Observer lazy-start logic (#508)
- Observer 5-layer loop prevention guard (#399)
- Hook portability and Windows .cmd support
- Biome hook optimization — eliminated npx overhead (#359)
- InsAIts security hook made opt-in (#370)
- Windows spawnSync export fix (#431)
- UTF-8 encoding fix for instinct CLI (#353)
- Secret scrubbing in hooks (#348)

### Translations

- Korean (ko-KR) translation — README, agents, commands, skills, rules (#392)
- Chinese (zh-CN) documentation sync (#428)

### Credits

- @ymdvsymd — observer sandbox and worktree fixes
- @pythonstrup — biome hook optimization
- @Nomadu27 — InsAIts security hook
- @hahmee — Korean translation
- @zdocapp — Chinese translation sync
- @cookiee339 — Kotlin ecosystem
- @pangerlkr — CI workflow fixes
- @0xrohitgarg — VideoDB skills
- @nocodemf — Evos operational skills
- @swarnika-cmd — community contributions

## 1.8.0 - 2026-03-04

### Highlights

- Harness-first release focused on reliability, eval discipline, and autonomous loop operations.
- Hook runtime now supports profile-based control and targeted hook disabling.
- NanoClaw v2 adds model routing, skill hot-load, branching, search, compaction, export, and metrics.

### Core

- Added new commands: `/harness-audit`, `/loop-start`, `/loop-status`, `/quality-gate`, `/model-route`.
- Added new skills:
  - `agent-harness-construction`
  - `agentic-engineering`
  - `ralphinho-rfc-pipeline`
  - `ai-first-engineering`
  - `enterprise-agent-ops`
  - `nanoclaw-repl`
  - `continuous-agent-loop`
- Added new agents:
  - `harness-optimizer`
  - `loop-operator`

### Hook Reliability

- Fixed SessionStart root resolution with robust fallback search.
- Moved session summary persistence to `Stop` where transcript payload is available.
- Added quality-gate and cost-tracker hooks.
- Replaced fragile inline hook one-liners with dedicated script files.
- Added `ECC_HOOK_PROFILE` and `ECC_DISABLED_HOOKS` controls.

### Cross-Platform

- Improved Windows-safe path handling in doc warning logic.
- Hardened observer loop behavior to avoid non-interactive hangs.

### Notes

- `autonomous-loops` is kept as a compatibility alias for one release; `continuous-agent-loop` is the canonical name.

### Credits

- inspired by [zarazhangrui](https://github.com/zarazhangrui)
- homunculus-inspired by [humanplane](https://github.com/humanplane)
