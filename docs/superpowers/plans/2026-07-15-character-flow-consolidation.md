# Character Flow Consolidation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把新角色从模板初始化、完整度检查、preflight、发布到回滚统一到一个可续作的 `character-pack-v1` 工作流，减少重复检查和多入口直接写 live 数据。

**Architecture:** 新增轻量 workspace 层保存输入/产物哈希和 37 项资源矩阵；现有 `PackTransaction` 与 `AtomicReleasePublisher` 仍是唯一 live 写入权限。CLI 只编排现有事务，后续角色生成器只能填充 package 工作目录，不能绕过 preflight、snapshot 或 active manifest。

**Tech Stack:** Python 3 标准库、现有 `wf_character_pack.py`、`wf_release.py`、`wf_assets.py`、unittest、CN orderedmap 工具链。

## Global Constraints

- 必须先完成 P0 基础修复和资产治理首轮隔离/恢复验收；活动角色 package、snapshot 和 generator work 在两个前置阶段中始终受保护。
- 不修改 `web/pages/`、`src/routes/web/`、`web/public/`、`admin/` 或服务端 TypeScript。
- 不修改用户未跟踪的 `mod-tools/docs/角色生成器方案.md` 和 `mod-tools/docs/角色生成器-Codex任务书.md`。
- 初始化和生成阶段只写 `work/character_packs/$packageId/`；preflight 之前不写真实 store、`assets/cdndata` 或 `.cdn`。
- ①层、②层和服务端 `assets/character.json` 必须一致；普通/嵌套表使用各自 codec，目标表宽和内层键序必须保持。
- 新角色必要资源必须达到 37/37；任何缺失都使 `release_ready=false`。
- `requires_client_base` 必须是 P0 图中的可达节点；陈旧 package 只能显式 rebase。
- 发布使用 common/medium/android 三根增量和 `active.json` 原子提交；不覆写历史 ZIP。
- 所有写入先 dry-run/preflight，再 snapshot/staging，最后显式确认；测试只用临时目录。

---

## File Structure

- Create `mod-tools/wf_character_requirements.py`: 从逻辑资产清单生成统一 37 项必要资源报告。
- Create `mod-tools/wf_character_workspace.py`: workspace 初始化、状态、哈希缓存和续作判断。
- Create `mod-tools/wf_character_flow.py`: `init/status/preflight/rebase/publish/rollback` CLI。
- Create `mod-tools/wf_character_rollback.py`: 从持久化 snapshot 构造反向增量发布。
- Create `mod-tools/tests/test_character_requirements.py`: 必要/建议/剧情分类测试。
- Create `mod-tools/tests/test_character_workspace.py`: 初始化、哈希续作和篡改测试。
- Create `mod-tools/tests/test_character_flow.py`: CLI 编排和零 live 写入测试。
- Create `mod-tools/tests/test_character_rollback.py`: snapshot 反向发布和故障恢复测试。
- Create `mod-tools/docs/角色包工作流.md`: 中文操作说明。
- Modify `mod-tools/wf_assets.py`: 暴露纯逻辑 `char_asset_requirements(code_name)`。
- Modify `mod-tools/wf_gui.py:4267-4308`: 复用统一 requirements 报告，保持端点响应兼容。
- Modify `mod-tools/wf_release.py`: 暴露可调用 preflight/rebase/publish API，CLI 接入 rollback。
- Modify `mod-tools/schemas/character-pack-v1.schema.json`: 收紧 `qa` 和 snapshot 的必需字段，不加入 workspace 私有状态。
- Modify `.gitignore`: 确保 `/work/character_packs/` 和 workspace 状态保持未跟踪。

### Task 1: Extract One Asset Requirement Contract

**Files:**
- Create: `mod-tools/wf_character_requirements.py`
- Create: `mod-tools/tests/test_character_requirements.py`
- Modify: `mod-tools/wf_assets.py`
- Modify: `mod-tools/wf_gui.py:4267-4308`

**Interfaces:**
- Produces: `char_asset_requirements(code_name: str) -> tuple[AssetRequirement, ...]`
- Produces: `build_requirement_report(requirements, existing_paths) -> RequirementReport`
- Preserves: current `/asset_template` response keys and category labels.

- [ ] **Step 1: Freeze the current report shape in a failing pure test**

```python
def test_requirement_report_counts_exactly_37_required_assets(self):
    requirements = tuple(fake_requirements(required=37, suggested=2, story=3))
    existing = {item.logical_path for item in requirements[:-1]}
    report = build_requirement_report(requirements, existing)
    self.assertEqual(37, report["required_total"])
    self.assertEqual(36, report["required_exists"])
    self.assertEqual([requirements[36].logical_path], report["missing_required"])
```

Add category tests for voice as suggested and story/expression/login paths as excluded.

- [ ] **Step 2: Run the test and observe missing module**

Run: `python -m unittest mod-tools.tests.test_character_requirements -v`

Expected: FAIL with missing module.

- [ ] **Step 3: Split requirement generation from store lookup**

```python
@dataclass(frozen=True)
class AssetRequirement:
    logical_path: str
    kind: str
    category: Literal["required", "suggested", "excluded"]
    expected_dims: tuple[int, int] | None = None

def build_requirement_report(requirements, existing_paths):
    existing = set(existing_paths)
    required = [item for item in requirements if item.category == "required"]
    missing = [item.logical_path for item in required if item.logical_path not in existing]
    return {
        "required_total": len(required),
        "required_exists": len(required) - len(missing),
        "missing_required": missing,
        "release_ready": not missing,
        "groups": _group(requirements, existing),
    }
```

`wf_assets.char_asset_manifest` calls the new pure requirement generator and adds store existence/size/dimensions. `wf_gui.asset_template_check` delegates report construction and preserves its existing public JSON fields.

- [ ] **Step 4: Run focused and existing asset tests**

Run: `python -m unittest mod-tools.tests.test_character_requirements mod-tools.tests.test_canary_skin mod-tools.tests.test_atf -v`

Expected: PASS; fixture report has 37 required items and GUI-facing grouping semantics are unchanged.

- [ ] **Step 5: Commit the shared contract**

```bash
git add mod-tools/wf_character_requirements.py mod-tools/tests/test_character_requirements.py mod-tools/wf_assets.py mod-tools/wf_gui.py
git diff --cached --check
git commit -m "refactor(mod-tools): share character asset requirements"
```

### Task 2: Add Isolated Character Workspaces and Hash-Based Status

**Files:**
- Create: `mod-tools/wf_character_workspace.py`
- Create: `mod-tools/tests/test_character_workspace.py`
- Modify: `.gitignore`

**Interfaces:**
- Produces: `init_workspace(root, template_id, character_id, code_name, package_id) -> Workspace`
- Produces: `workspace_status(workspace) -> WorkspaceStatus`
- Layout: `workspace.json`, `package/manifest.json`, `package/roots/{common,medium,android,server}`, `evidence/status.json`.

- [ ] **Step 1: Write failing init and resume tests**

```python
def test_init_writes_only_inside_workspace_and_status_is_resumable(self):
    workspace = init_workspace(root, 111165, 129999, "seris_dragon_king", "seris_dragon_king")
    self.assertEqual([], list(live_root.rglob("*")))
    first = workspace_status(workspace)
    add_package_file(workspace, "medium", required_path, b"asset")
    second = workspace_status(workspace)
    self.assertNotEqual(first.input_digest, second.input_digest)
    self.assertIn(required_path, second.completed_paths)

def test_status_reuses_hash_for_unchanged_size_and_mtime(self):
    first = workspace_status(workspace)
    second = workspace_status(workspace)
    self.assertEqual(first.file_count, second.file_count)
    self.assertEqual(second.file_count, second.hash_cache_hits)
```

- [ ] **Step 2: Run tests and verify the workspace module is absent**

Run: `python -m unittest mod-tools.tests.test_character_workspace -v`

Expected: FAIL with missing module.

- [ ] **Step 3: Implement strict workspace identity and manifest skeleton**

```python
workspace_payload = {
    "schema_version": 1,
    "package_id": package_id,
    "template_character_id": template_id,
    "character_id": character_id,
    "code_name": code_name,
    "package_dir": "package",
}
```

Reject existing non-empty destinations, invalid IDs, code names outside `^[a-z][a-z0-9_]*$`, path escapes and reparse components. The draft package manifest uses schema version 1, four empty roots and `qa.release_ready=false`; incomplete claims are expected until the upstream producer fills them.

- [ ] **Step 4: Implement content-hash status without storing secrets or live paths**

Cache key is normalized relative path plus size and mtime_ns; cache value is SHA-256. `status.json` includes input and output digests, required asset matrix, manifest errors, three-layer claim status and recommended next command. It contains no API key or absolute live store path.

- [ ] **Step 5: Run workspace tests**

Run: `python -m unittest mod-tools.tests.test_character_workspace mod-tools.tests.test_character_requirements -v`

Expected: PASS; all writes remain inside the temporary workspace.

- [ ] **Step 6: Commit workspace support**

```bash
git add mod-tools/wf_character_workspace.py mod-tools/tests/test_character_workspace.py .gitignore
git diff --cached --check
git commit -m "feat(mod-tools): add resumable character workspaces"
```

### Task 3: Build the Unified Character Flow CLI

**Files:**
- Create: `mod-tools/wf_character_flow.py`
- Create: `mod-tools/tests/test_character_flow.py`
- Modify: `mod-tools/wf_release.py`
- Modify: `mod-tools/schemas/character-pack-v1.schema.json`

**Interfaces:**
- Produces commands: `init`, `status`, `preflight`, `rebase`, `publish`, `rollback`.
- Consumes: workspace `package/`, P0 graph base provider, existing `PackTransaction` and `AtomicReleasePublisher`.
- Produces one final JSON object per command with `ok`, `stage`, `workspace`, `release_ready`, `errors`, `next_command`.

- [ ] **Step 1: Write CLI zero-write and delegation tests**

```python
def test_preflight_never_writes_live_roots_or_cdn(self):
    before = snapshot_tree(live_root)
    result = run_flow("preflight", "--workspace", workspace)
    self.assertFalse(result["release_ready"])
    self.assertEqual(before, snapshot_tree(live_root))
    self.assertEqual([], list(cdn_root.rglob("*.zip")))

def test_publish_requires_exact_confirmation_and_ready_status(self):
    with self.assertRaisesRegex(FlowError, "PUBLISH_CHARACTER_PACKAGE"):
        run_flow("publish", "--workspace", ready_workspace)

def test_runtime_test_preserves_existing_direct_test_contract(self):
    manifest = make_runtime_test_manifest(release_ready=False,
                                          user_authorized_direct_real_test=True)
    result = run_flow("publish", "--workspace", manifest.workspace,
                      "--confirm", "DIRECT_REAL_TEST")
    self.assertEqual("runtime_test", result["delivery_mode"])
```

- [ ] **Step 2: Run tests and observe missing CLI**

Run: `python -m unittest mod-tools.tests.test_character_flow -v`

Expected: FAIL with missing module.

- [ ] **Step 3: Expose callable release operations without changing semantics**

In `wf_release.py`, keep CLI parsing thin and expose the exact typed callables `preflight_package(package_dir: Path, profile_id: str, installed_package_dir: Path | None = None) -> dict` and `publish_package(package_dir: Path, profile_id: str, confirmation: str, installed_package_dir: Path | None = None) -> ReleaseResult`.

Both call existing transaction code. For `delivery_mode=production`, `publish_package` requires exact confirmation `PUBLISH_CHARACTER_PACKAGE`, a matching workspace digest, `release_ready=true`, 37/37 assets, a reachable base and a stopped server. Preserve the existing `delivery_mode=runtime_test` path unchanged: it requires `DIRECT_REAL_TEST`, `user_authorized_direct_real_test=true` and the existing `release_ready=false` safety marker. Runtime-test mode must never be silently promoted to production readiness.

- [ ] **Step 4: Tighten the manifest QA contract**

Require `qa` to contain `delivery_mode`, `release_ready`, `required_assets_total`, `required_assets_present` and `workspace_input_sha256`. Production manifests are rejected unless `release_ready=true`, totals are `37` and `37`, and the status digest matches. Runtime-test manifests retain the existing `release_ready=false` plus `user_authorized_direct_real_test=true` contract and are rejected by the production confirmation path. Add regression tests for both modes before changing schema or release code.

- [ ] **Step 5: Implement CLI orchestration**

`init` and `status` call `wf_character_workspace`; `preflight`, `rebase` and `publish` call exported release APIs. The CLI never imports `wf_gui`. It prints errors in Chinese plus stable machine fields.

- [ ] **Step 6: Run flow, pack and release tests**

Run: `python -m unittest mod-tools.tests.test_character_flow mod-tools.tests.test_character_workspace mod-tools.tests.test_character_pack mod-tools.tests.test_release mod-tools.tests.test_seris_release_pack -v`

Expected: PASS; publish remains blocked without exact confirmation and all dry-run commands have zero live writes.

- [ ] **Step 7: Commit the flow CLI**

```bash
git add mod-tools/wf_character_flow.py mod-tools/tests/test_character_flow.py mod-tools/wf_release.py mod-tools/schemas/character-pack-v1.schema.json
git diff --cached --check
git commit -m "feat(mod-tools): unify character package workflow"
```

### Task 4: Generate a Reverse Incremental from a Snapshot

**Files:**
- Create: `mod-tools/wf_character_rollback.py`
- Create: `mod-tools/tests/test_character_rollback.py`
- Modify: `mod-tools/wf_release.py`
- Modify: `mod-tools/wf_character_flow.py`

**Interfaces:**
- Produces: `prepare_snapshot_rollback(snapshot_dir, live_roots, release_store, staging_root) -> ReleasePayload`
- Produces: `publish_snapshot_rollback(snapshot_dir: Path, profile_id: str, confirmation: str, installed_package_dir: Path | None = None) -> ReleaseResult`
- Consumes: finalized `.character-pack-snapshot.json`, `snapshot.json`, before bytes and current active tail.

- [ ] **Step 1: Write snapshot rollback and failure-injection tests**

```python
def test_snapshot_rollback_publishes_before_bytes_as_a_new_release(self):
    payload = prepare_snapshot_rollback(snapshot_dir, live_roots, store, staging)
    result = publisher.publish(payload, server_running=lambda: False)
    self.assertEqual(original_bytes, live_file.read_bytes())
    self.assertEqual(previous_tail_bumped, result.version)
    self.assertTrue(all("rollback" in path.name for path in result.archives))

def test_rollback_failure_restores_current_live_state(self):
    current = live_file.read_bytes()
    with self.assertRaises(ReleaseError):
        publisher.publish(payload, server_running=lambda: False,
                          fail_after="after_archive_moves")
    self.assertEqual(current, live_file.read_bytes())
```

- [ ] **Step 2: Run tests and verify rollback support is absent**

Run: `python -m unittest mod-tools.tests.test_character_rollback -v`

Expected: FAIL with missing module.

- [ ] **Step 3: Parse only finalized snapshots and re-snapshot current live bytes**

Reject missing marker, mismatched transaction ID, unsafe live/logical paths, base64 errors and snapshot roots outside configured roots. Before publishing the rollback, capture current live bytes as `ReleaseFile.before_raw`; this allows the publisher's existing precommit rollback to restore the pre-rollback state.

- [ ] **Step 4: Build three reverse archives and append a new release**

Package ID is computed as `f"{original_package_id}-rollback"`; archive members use normal production paths and before bytes. `active.json` is appended atomically through `AtomicReleasePublisher`; historical release files and records remain untouched.

- [ ] **Step 5: Wire the exact confirmation gate**

`wf_character_flow.py rollback --snapshot-dir $snapshotDir --confirm ROLLBACK_CHARACTER_PACKAGE` is the only mutating rollback command. A missing installed package, running server or changed snapshot digest causes zero writes. Rollback confirmation is deliberately distinct from runtime-test publishing.

- [ ] **Step 6: Run rollback and release regression tests**

Run: `python -m unittest mod-tools.tests.test_character_rollback mod-tools.tests.test_release mod-tools.tests.test_character_pack -v`

Expected: PASS, including all existing failure-injection tests.

- [ ] **Step 7: Commit rollback support**

```bash
git add mod-tools/wf_character_rollback.py mod-tools/tests/test_character_rollback.py mod-tools/wf_release.py mod-tools/wf_character_flow.py
git diff --cached --check
git commit -m "feat(mod-tools): publish character rollback increments"
```

### Task 5: Document and Exercise the Operator Flow

**Files:**
- Create: `mod-tools/docs/角色包工作流.md`
- Test: existing Python suite and `wf_selftest.py`.

**Interfaces:**
- Documents exact commands and handoff from the existing untracked generator design into the package workspace.

- [ ] **Step 1: Write the command-complete Chinese guide**

The guide includes these exact stages:

```powershell
python mod-tools/wf_character_flow.py init --template-id 111165 --character-id 129999 --code-name seris_dragon_king --package-id seris_dragon_king
python mod-tools/wf_character_flow.py status --workspace work/character_packs/seris_dragon_king
python mod-tools/wf_character_flow.py preflight --workspace work/character_packs/seris_dragon_king
python mod-tools/wf_character_flow.py rebase --workspace work/character_packs/seris_dragon_king
$publishJson = python mod-tools/wf_character_flow.py publish --workspace work/character_packs/seris_dragon_king --confirm PUBLISH_CHARACTER_PACKAGE | Select-Object -Last 1 | ConvertFrom-Json
$snapshotDir = $publishJson.snapshot_dir
if (-not $snapshotDir) { throw 'Publish output did not provide snapshot_dir' }
python mod-tools/wf_character_flow.py rollback --snapshot-dir $snapshotDir --confirm ROLLBACK_CHARACTER_PACKAGE
```

Explain that the first command creates an incomplete draft, `status` must reach 37/37, and production publish stops if the server is running. Document `DIRECT_REAL_TEST` only in a separate warning section for existing explicitly authorized runtime-test packages; it is not the normal 37/37 publish command.

- [ ] **Step 2: Run a complete temporary-workspace rehearsal**

Create a temporary fixture package, run `init → status → preflight`, fill the fixture's missing claims/assets, run preflight again, publish to temporary live/CDN roots, then rollback from its snapshot.

Expected: first preflight reports missing items with zero writes; second preflight passes; temporary publish increments version; rollback restores original bytes through a newer increment.

- [ ] **Step 3: Run the full test matrix**

Run: `python -m unittest discover -s mod-tools/tests -p "test_*.py" -v`

Expected: all tests PASS except the already documented environment skip.

Run: `python mod-tools/wf_selftest.py`

Expected: all non-device checks PASS; ADB absence may be a clearly labeled warning.

- [ ] **Step 4: Commit documentation**

```bash
git add mod-tools/docs/角色包工作流.md
git diff --cached --check
git commit -m "docs(mod-tools): document character package workflow"
```

### Task 6: Validate the Live Project Without Publishing a New Character

**Files:**
- Runtime only: `$runDir/character-flow-verification.json`
- Do not modify current user character JSON or current generator work.

**Interfaces:**
- Consumes: active manifest, protected snapshots and current package/source workspaces read-only.
- Produces: package/release health report with blockers.

Resolve the active P0 remediation run before writing the report:

```powershell
$runDir = Get-ChildItem -LiteralPath 'work/remediation' -Directory |
    Where-Object { Test-Path (Join-Path $_.FullName 'baseline.json') } |
    Sort-Object LastWriteTime -Descending |
    Select-Object -First 1
if (-not $runDir) { throw 'No remediation baseline exists' }
$runDir = $runDir.FullName
```

- [ ] **Step 1: Read active releases and validate every archive**

Run the P0 graph health and `wf_release.py preflight` against every locally available installed package directory. Missing package source is reported as `source_unavailable`; it does not trigger reconstruction from live bytes without an explicit package claim.

Expected: active archive hashes match and the active tail is reachable.

- [ ] **Step 2: Run current character requirement checks read-only**

For character `129999`, record the 37-item matrix and the exact missing logical path. Do not synthesize or copy the missing asset in this task because the current user modifications are not yet a reviewed package.

Expected: report states either 37/37 or the precise blocker; no live file mtime changes.

- [ ] **Step 3: Verify protected working-tree boundaries**

Run: `git status --short`

Expected: only the user's pre-existing four JSON modifications, two untracked generator documents and ignored `work/` remain outside committed task changes.

---

## Final Acceptance Gate

- [ ] GUI、CLI 和发布层使用同一 37 项必要资源契约；建议/排除资源的现有语义不变。
- [ ] `init`、`status` 和失败的 `preflight` 只写 workspace；真实 store、CDN 和角色表保持零写入。
- [ ] production 发布同时要求 37/37、匹配 digest、可达 base、服务停止和 `PUBLISH_CHARACTER_PACKAGE`。
- [ ] 现有 runtime-test 流程仍要求 `release_ready=false`、显式授权及 `DIRECT_REAL_TEST`，不能被生产确认口令触发。
- [ ] 发布前快照包含 before bytes、真实/逻辑路径和完成 marker；失败注入可回到发布前状态。
- [ ] 回滚以新增 reverse increment 完成，使用独立确认 `ROLLBACK_CHARACTER_PACKAGE`，不改写历史归档或 manifest 记录。
- [ ] 临时根上的 init → status → preflight → publish → rollback 演练通过；完整 Python 测试矩阵通过。
- [ ] 对当前 129999 仅输出 37 项只读报告，不合成缺失资源、不发布、不覆盖四个用户 JSON 或生成器工作区。
