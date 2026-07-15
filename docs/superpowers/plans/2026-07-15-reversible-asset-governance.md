# Reversible Asset Governance Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 建立证据化资产分类、隔离、验证和恢复工具，并对当前项目中已证明无效或可重建的资产执行首轮可逆清理。

**Architecture:** 扫描、引用解析、归档证明和文件移动分为独立 Python 模块；计划文件是唯一动作授权，隔离器不能自行重新分类。大目录用带 Merkle 清单的同卷原子 rename，单文件使用逐项哈希；证据不足统一保留。

**Tech Stack:** Python 3 标准库、Windows NTFS、7-Zip `C:\Program Files\7-Zip\7z.exe`、现有 `wf_restore_package.py`、P0 CDN 图输出。

## Global Constraints

- 必须先完成并验证 `2026-07-15-p0-foundation-remediation.md`。
- 首轮只执行 `scan`、`plan`、`quarantine`、`verify` 和 `restore` 演练；不执行 `purge`。
- 隔离根由已验证基线的 `$runId` 固定为 `D:\WF\asset-quarantine\startpoint-cn-$runId`，不得位于任何扫描根内部。
- 不跟随 symlink、junction 或 reparse point；不跨卷删除源文件。
- `protected`、`live_referenced`、`corrupt` 和 `unknown` 永不自动移动。
- 必须保护活动 `WorldFlipper` store、全部 full CDN、可达 diff、角色 active manifest、数据库、快照、角色生成工作目录、pathlist/CSV 和逆向工作区。
- `.bak-wfmod-*` 每个目标至少保留最新 3 份、最新成功发布前最后恢复点及全部被引用备份。
- 同盘隔离不等于释放磁盘空间；只有后续另行批准的永久删除才能增加 D: 可用空间。
- 不修改 `web/pages/`、`src/routes/web/`、`web/public/`，不执行 Git 对象维护。

---

## File Structure

- Create `mod-tools/wf_asset_inventory.py`: 安全遍历、流式哈希、目录 Merkle 清单和扫描模型。
- Create `mod-tools/wf_asset_policy.py`: 保护规则、引用解析、备份保留和分类决策。
- Create `mod-tools/wf_asset_archive.py`: 7-Zip 测试、成员清单及解压树 CRC 对比。
- Create `mod-tools/wf_asset_quarantine.py`: 计划签名、原子隔离、校验、恢复和 purge 硬门。
- Create `mod-tools/wf_asset_maintenance.py`: `scan/plan/quarantine/verify/restore/purge` CLI。
- Create `mod-tools/asset-maintenance-policy-v1.json`: 显式扫描根、保护根和保留策略。
- Create `mod-tools/tests/test_asset_inventory.py`: 路径、reparse、hash 和 Merkle 测试。
- Create `mod-tools/tests/test_asset_policy.py`: 分类和引用图测试。
- Create `mod-tools/tests/test_asset_archive.py`: ZIP/伪 RAR 清单解析和 7-Zip runner 测试。
- Create `mod-tools/tests/test_asset_quarantine.py`: 隔离、篡改检测、恢复和 purge 确认测试。
- Create `mod-tools/tests/test_asset_maintenance.py`: CLI 阶段摘要、摘要绑定和确认门测试。
- Modify `mod-tools/wf_remediation_baseline.py`: 复用 run 目录和原子 JSON/JSONL 写入。
- Runtime only `work/remediation/$runId/`: 扫描、计划、验证和最终报告。
- Runtime only `D:\WF\asset-quarantine\startpoint-cn-$runId`: 隔离数据和恢复清单。

### Task 1: Implement a Safe Inventory and Merkle Model

**Files:**
- Create: `mod-tools/wf_asset_inventory.py`
- Test: `mod-tools/tests/test_asset_inventory.py`

**Interfaces:**
- Produces: `InventoryEntry(path, kind, size, sha256, mtime_ns, reparse)`
- Produces: `scan_root(root: Path) -> Iterator[InventoryEntry]`
- Produces: `tree_manifest(root: Path) -> TreeManifest`
- Consumes: explicit roots only; never follows directory links.

- [ ] **Step 1: Write failing file, directory and junction tests**

```python
def test_scan_root_hashes_files_without_following_directory_links(self):
    (root / "safe.bin").write_bytes(b"safe")
    make_directory_link(root / "linked", outside)
    entries = list(inventory.scan_root(root))
    self.assertEqual(["safe.bin", "linked"], [item.relative_path for item in entries])
    self.assertEqual("reparse", entries[1].kind)
    self.assertFalse(any("secret.bin" in item.relative_path for item in entries))

def test_tree_manifest_changes_when_content_or_path_changes(self):
    first = inventory.tree_manifest(root)
    (root / "a.bin").write_bytes(b"changed")
    second = inventory.tree_manifest(root)
    self.assertNotEqual(first.tree_sha256, second.tree_sha256)
```

- [ ] **Step 2: Run focused tests and observe missing module**

Run: `python -m unittest mod-tools.tests.test_asset_inventory -v`

Expected: FAIL with missing `wf_asset_inventory`.

- [ ] **Step 3: Implement streaming hashes and stable tree manifests**

```python
def sha256_file(path: Path, chunk_size: int = 8 * 1024 * 1024) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for chunk in iter(lambda: stream.read(chunk_size), b""):
            digest.update(chunk)
    return digest.hexdigest()

def tree_manifest(root: Path) -> TreeManifest:
    files = tuple(entry for entry in scan_root(root) if entry.kind == "file")
    digest = hashlib.sha256()
    for entry in sorted(files, key=lambda item: item.relative_path.casefold()):
        digest.update(entry.relative_path.replace("\\", "/").encode("utf-8"))
        digest.update(b"\0")
        digest.update(str(entry.size).encode("ascii"))
        digest.update(b"\0")
        digest.update(entry.sha256.encode("ascii"))
        digest.update(b"\n")
    return TreeManifest(files=files, tree_sha256=digest.hexdigest())
```

On Windows, inspect `st_file_attributes & stat.FILE_ATTRIBUTE_REPARSE_POINT`; emit one `reparse` entry and do not descend. Sort names case-insensitively with the original path as a tie-breaker.

- [ ] **Step 4: Run inventory tests**

Run: `python -m unittest mod-tools.tests.test_asset_inventory -v`

Expected: PASS on normal files and the symlink/junction fixture; outside content is never read.

- [ ] **Step 5: Commit inventory**

```bash
git add mod-tools/wf_asset_inventory.py mod-tools/tests/test_asset_inventory.py
git diff --cached --check
git commit -m "feat(mod-tools): add safe asset inventory"
```

### Task 2: Encode Protection, Reference and Retention Policy

**Files:**
- Create: `mod-tools/wf_asset_policy.py`
- Create: `mod-tools/asset-maintenance-policy-v1.json`
- Test: `mod-tools/tests/test_asset_policy.py`

**Interfaces:**
- Produces: `Policy.load(path) -> Policy`
- Produces: `ReferenceIndex.from_project(repo_root, cdn_graph_json) -> ReferenceIndex`
- Produces: `classify(entry, context) -> Decision`
- Consumes: `profiles.json`, active character releases, P0 graph JSON, snapshot manifests, changelog and fixed-path runtime artifacts.

- [ ] **Step 1: Write failing policy precedence tests**

```python
def test_unknown_and_live_referenced_override_cache_rules(self):
    entry = fake_entry("work/active/__pycache__/needed.pyc")
    refs = ReferenceIndex(paths={entry.absolute_path})
    self.assertEqual("live_referenced", classify(entry, refs, policy).category)

def test_backup_retention_keeps_three_and_referenced_restore_points(self):
    decisions = classify_backup_group(backups, referenced={backups[4]}, last_success=backups[3])
    kept = {item.path for item in decisions if item.category == "protected"}
    self.assertTrue(set(backups[-3:]).issubset(kept))
    self.assertIn(backups[4], kept)
    self.assertIn(backups[3], kept)
```

- [ ] **Step 2: Run tests and verify no policy exists**

Run: `python -m unittest mod-tools.tests.test_asset_policy -v`

Expected: FAIL with missing module.

- [ ] **Step 3: Check in the explicit policy**

```json
{
  "schema_version": 1,
  "scan_roots": [".cdn/cn", "assets/asset-patch", "work", "mod-tools/work", "logs", "弹国服"],
  "protected_roots": [
    "弹国服/WorldFlipper", "work/character_releases", "work/ai_canary",
    "mod-tools/work/char_snapshots", "mod-tools/work/char_gen",
    "弹国服/instrument", "decompile", "ffdec_26.2.1", "pc-run"
  ],
  "backup_keep_latest": 3,
  "auto_categories": ["exact_duplicate", "proven_regenerable", "stale_cache", "retention_expired"]
}
```

The loader resolves every path against the repository, rejects scan roots containing the quarantine root, and rejects unknown keys.

- [ ] **Step 4: Implement reference sources and classification precedence**

Precedence is fixed: `protected` → `live_referenced` → `corrupt` → `exact_duplicate` → `proven_regenerable` → `stale_cache` → `retention_expired` → `unknown`. A lower category can never override a higher one.

References include every archive in the P0 selected paths, every file in active character release manifests, snapshot/recovery JSON paths, profile store roots, `WF_PATHLIST_recovered*`, `HarvestedPaths.csv`, `.pathlist`, database files and current generator workspaces.

- [ ] **Step 5: Run policy and inventory tests**

Run: `python -m unittest mod-tools.tests.test_asset_policy mod-tools.tests.test_asset_inventory -v`

Expected: PASS; all unproven entries resolve to `unknown`, never an auto category.

- [ ] **Step 6: Commit policy**

```bash
git add mod-tools/wf_asset_policy.py mod-tools/asset-maintenance-policy-v1.json mod-tools/tests/test_asset_policy.py
git diff --cached --check
git commit -m "feat(mod-tools): classify assets from explicit evidence"
```

### Task 3: Prove Archive and Extracted-Tree Relationships

**Files:**
- Create: `mod-tools/wf_asset_archive.py`
- Test: `mod-tools/tests/test_asset_archive.py`

**Interfaces:**
- Produces: `SevenZip(path: Path).test(archive) -> ArchiveTestResult`
- Produces: `SevenZip.list(archive) -> tuple[ArchiveMember, ...]`
- Produces: `compare_archive_to_tree(members, tree_root) -> ArchiveTreeComparison`
- Consumes: `C:\Program Files\7-Zip\7z.exe`, with PATH fallback.

- [ ] **Step 1: Write runner and CRC comparison tests**

```python
def test_archive_must_pass_test_and_match_tree_crc(self):
    runner = FakeRunner(test_code=0, listing=fixture_slt())
    seven = SevenZip(Path("7z.exe"), runner=runner)
    members = seven.list(Path("assets.rar"))
    comparison = compare_archive_to_tree(members, extracted)
    self.assertTrue(comparison.exact)
    (extracted / "changed.bin").write_bytes(b"changed")
    self.assertFalse(compare_archive_to_tree(members, extracted).exact)
```

Include encrypted archive, CRC-less member, unsafe `../` member, duplicate normalized path and nonzero `7z t` cases. All become unproven, not duplicates.

- [ ] **Step 2: Run tests and observe missing archive module**

Run: `python -m unittest mod-tools.tests.test_asset_archive -v`

Expected: FAIL with missing module.

- [ ] **Step 3: Implement strict 7-Zip invocation and listing parsing**

```python
def test(self, archive: Path) -> ArchiveTestResult:
    completed = self.runner([
        str(self.executable), "t", "-bso0", "-bsp0", "-bse1", str(archive)
    ])
    return ArchiveTestResult(ok=completed.returncode == 0,
                             stderr=completed.stderr[-4000:])
```

Use `7z l -slt -ba` for member records. Reject absolute, drive-relative, UNC, `.` and `..` paths before comparing. Compute extracted CRC32 by streaming and compare normalized path, size and CRC.

- [ ] **Step 4: Run tests and a read-only real archive test**

Run: `python -m unittest mod-tools.tests.test_asset_archive -v`

Expected: PASS.

Run: `& "C:\Program Files\7-Zip\7z.exe" t -bso0 -bsp0 "D:\WF\startpoint-cn\弹国服\assets.rar"`

Expected: exit 0. A nonzero exit marks `弹国服/assets` as `unknown` and stops duplicate classification.

- [ ] **Step 5: Commit archive proof**

```bash
git add mod-tools/wf_asset_archive.py mod-tools/tests/test_asset_archive.py
git diff --cached --check
git commit -m "feat(mod-tools): verify archive duplicates"
```

### Task 4: Implement Signed Plans, Atomic Quarantine and Restore

**Files:**
- Create: `mod-tools/wf_asset_quarantine.py`
- Test: `mod-tools/tests/test_asset_quarantine.py`
- Modify: `mod-tools/wf_remediation_baseline.py`

**Interfaces:**
- Produces: `write_plan(entries, run_dir) -> PlanRecord`
- Produces: `quarantine(plan_path, quarantine_root) -> OperationSummary`
- Produces: `verify_manifest(manifest_path) -> VerificationSummary`
- Produces: `restore(manifest_path, ids) -> OperationSummary`
- Produces: `purge(manifest_path, confirmation)`, requiring exact `PERMANENT_DELETE` but not run in this project cycle.

- [ ] **Step 1: Write failure-safe move and restore tests**

```python
def test_quarantine_rejects_modified_or_unknown_plan(self):
    plan = make_plan(category="unknown")
    with self.assertRaisesRegex(QuarantineError, "not auto-approved"):
        quarantine(plan.path, quarantine_root)
    self.assertTrue(plan.source.exists())

def test_restore_round_trip_preserves_tree_digest(self):
    plan = make_tree_plan(source_tree)
    summary = quarantine(plan.path, quarantine_root)
    self.assertFalse(source_tree.exists())
    restore(summary.manifest_path, ids=None)
    self.assertEqual(plan.tree_sha256, tree_manifest(source_tree).tree_sha256)
```

Also test existing destination, cross-volume root, manifest tampering, post-move hash mismatch, interrupted manifest and wrong purge confirmation.

- [ ] **Step 2: Run tests and observe missing quarantine module**

Run: `python -m unittest mod-tools.tests.test_asset_quarantine -v`

Expected: FAIL with missing module.

- [ ] **Step 3: Implement immutable plan digests and append-only operations**

```python
def canonical_digest(value: object) -> str:
    raw = json.dumps(value, ensure_ascii=False, sort_keys=True,
                     separators=(",", ":")).encode("utf-8")
    return hashlib.sha256(raw).hexdigest()

def atomic_move(source: Path, target: Path) -> None:
    if source.drive.casefold() != target.drive.casefold():
        raise QuarantineError("cross-volume quarantine is not allowed")
    target.parent.mkdir(parents=True, exist_ok=True)
    os.replace(source, target)
```

Before each move, append a `planned` record and fsync; after move and digest readback, append `quarantined`. Recovery treats a dangling `planned` record by checking both source and target and never deleting either.

- [ ] **Step 4: Generate a restore wrapper that calls the Python tool**

`restore.ps1` is generated only after the final quarantine root is known. It embeds the normalized absolute path from `manifest_path.resolve(strict=True)` as a single-quoted PowerShell literal and invokes `wf_asset_maintenance.py restore --manifest $manifestPath`; optional IDs are passed through as an array. It must not contain `Remove-Item` and generation must reject a manifest path containing a single quote rather than emitting ambiguous script text.

- [ ] **Step 5: Run quarantine tests**

Run: `python -m unittest mod-tools.tests.test_asset_quarantine mod-tools.tests.test_asset_inventory -v`

Expected: PASS, including byte-identical round-trip and tamper rejection.

- [ ] **Step 6: Commit quarantine primitives**

```bash
git add mod-tools/wf_asset_quarantine.py mod-tools/tests/test_asset_quarantine.py mod-tools/wf_remediation_baseline.py
git diff --cached --check
git commit -m "feat(mod-tools): quarantine and restore assets atomically"
```

### Task 5: Assemble the Asset Maintenance CLI

**Files:**
- Create: `mod-tools/wf_asset_maintenance.py`
- Test: `mod-tools/tests/test_asset_maintenance.py`

**Interfaces:**
- Produces CLI commands: `scan`, `plan`, `quarantine`, `verify`, `restore`, `purge`.
- Consumes the exact scan file from the previous command; each command validates schema and digest.

- [ ] **Step 1: Write CLI contract tests**

```python
def test_plan_then_quarantine_moves_only_auto_categories(self):
    run_cli("scan", "--repo-root", root, "--run-dir", run_dir)
    run_cli("plan", "--scan", run_dir / "scan.jsonl")
    summary = run_cli("quarantine", "--plan", run_dir / "plan.json")
    self.assertEqual(0, summary["moved_by_category"].get("unknown", 0))
    self.assertGreater(summary["moved_by_category"]["stale_cache"], 0)
```

Assert every mutating command requires the preceding digest, and `purge` refuses missing or wrong confirmation.

- [ ] **Step 2: Run CLI tests and observe missing entrypoint**

Run: `python -m unittest mod-tools.tests.test_asset_maintenance -v`

Expected: FAIL with missing module.

- [ ] **Step 3: Implement deterministic command output**

Each command prints one final JSON object containing `ok`, `run_id`, `artifact`, category counts and byte counts. Progress goes to stderr. Exit codes: 0 success, 2 invalid input/evidence, 3 partial move requiring recovery, 4 verification failure.

- [ ] **Step 4: Run all new asset tests and the full Python suite**

Run: `python -m unittest mod-tools.tests.test_asset_inventory mod-tools.tests.test_asset_policy mod-tools.tests.test_asset_archive mod-tools.tests.test_asset_quarantine mod-tools.tests.test_asset_maintenance -v`

Expected: PASS.

Run: `python -m unittest discover -s mod-tools/tests -p "test_*.py" -v`

Expected: all existing tests PASS except the already documented environment skip.

- [ ] **Step 5: Commit CLI**

```bash
git add mod-tools/wf_asset_maintenance.py mod-tools/tests/test_asset_maintenance.py
git diff --cached --check
git commit -m "feat(mod-tools): add reversible asset maintenance cli"
```

### Task 6: Produce and Review the Real Dry-Run Plan

**Files:**
- Runtime only: `$runDir/scan.jsonl`
- Runtime only: `$runDir/plan.json`
- Runtime only: `$runDir/evidence/`

**Interfaces:**
- Consumes: the P0 baseline run, P0 CDN graph health JSON and policy v1.
- Produces: a no-write plan with category and byte totals.

- [ ] **Step 1: Export the validated CDN graph locally**

Use the compiled `getCnReleaseGraphSnapshot()` helper to write a redacted graph summary into the active remediation run. The exported file includes selected edge archive paths and hashes, not the admin token.

Expected: every configured supported base is reachable and `issues` is empty. Stop if it is not.

- [ ] **Step 2: Scan all explicit roots without moving data**

Resolve the already-created P0 run directory once and reuse it for every remaining command:

```powershell
$runDir = Get-ChildItem -LiteralPath 'work/remediation' -Directory |
    Where-Object { Test-Path (Join-Path $_.FullName 'baseline.json') } |
    Sort-Object LastWriteTime -Descending |
    Select-Object -First 1
if (-not $runDir) { throw 'No P0 remediation baseline exists' }
$runDir = $runDir.FullName
$runId = Split-Path $runDir -Leaf
python mod-tools/wf_asset_maintenance.py scan --repo-root D:\WF\startpoint-cn --policy mod-tools\asset-maintenance-policy-v1.json --run-dir $runDir
```

Expected: exit 0, prints `"ok": true`; scan totals cover `.cdn/cn`, `assets/asset-patch`, `work`, `mod-tools/work`, `logs` and `弹国服`; reparse entries are reported but not followed.

- [ ] **Step 3: Build the evidence plan**

Run: `python mod-tools/wf_asset_maintenance.py plan --scan (Join-Path $runDir 'scan.jsonl') --cdn-graph (Join-Path $runDir 'cdn-graph.json') --policy mod-tools\asset-maintenance-policy-v1.json`

Expected: exit 0 and `plan.json`; `auto_move_bytes` is separated from protected/unknown bytes.

- [ ] **Step 4: Apply hard review invariants**

Run: `python mod-tools/wf_asset_maintenance.py verify --plan (Join-Path $runDir 'plan.json') --mode preflight`

Expected:

- `unknown_moved = 0`
- `corrupt_moved = 0`
- `protected_moved = 0`
- active store/full CDN/active character archives/snapshots/generator/reverse roots each appear in protected evidence
- `弹国服/assets` is auto-approved only if `assets.rar` test and member comparison are exact
- `restored*` is auto-approved only if script/input/manifests and regeneration evidence are present

Stop and fix policy/tests if any invariant fails.

### Task 7: Execute the First Reversible Quarantine

**Files:**
- Runtime only: `$quarantineRoot`
- Runtime only: `$runDir/actions.jsonl`

**Interfaces:**
- Consumes: immutable reviewed `plan.json`.
- Produces: quarantine `manifest.jsonl`, `summary.json`, `restore.ps1` and evidence.

- [ ] **Step 1: Quarantine only pre-approved categories**

```powershell
$quarantineRoot = Join-Path 'D:\WF\asset-quarantine' ("startpoint-cn-{0}" -f $runId)
python mod-tools/wf_asset_maintenance.py quarantine --plan (Join-Path $runDir 'plan.json') --quarantine-root $quarantineRoot
```

Expected: exit 0; summary contains only `exact_duplicate`, `proven_regenerable`, `stale_cache` and `retention_expired`; source and target digests match.

- [ ] **Step 2: Verify project references and quarantine bytes**

Run: `python mod-tools/wf_asset_maintenance.py verify --manifest (Join-Path $quarantineRoot 'manifest.jsonl')`

Expected: `"ok": true`, zero missing quarantine files and zero live references now pointing to missing protected assets.

- [ ] **Step 3: Re-run P0 and WF validation**

Run: `npm run typecheck`

Expected: PASS.

Run: `npx tsc && node --test out/tests`

Expected: PASS.

Run: `python -m unittest discover -s mod-tools/tests -p "test_*.py" -v`

Expected: PASS except the documented environment skip.

Run: `python mod-tools/wf_selftest.py`

Expected: all non-device checks PASS; an unavailable ADB endpoint is recorded as a warning, not hidden.

### Task 8: Perform a Restore Drill and Finalize the Asset Report

**Files:**
- Runtime only: `$runDir/final-report.md`
- Runtime only: quarantine manifest and restored/re-quarantined entries.

**Interfaces:**
- Consumes: manifest IDs selected deterministically by category and size.
- Produces: byte-identical restore proof and a final four-way asset report.

- [ ] **Step 1: Select three restore samples deterministically**

Choose the lexicographically first quarantined stale cache, first retention-expired backup and largest proven-regenerable tree. Record their IDs before moving anything.

- [ ] **Step 2: Restore the samples**

Parse the manifest and derive the three IDs exactly as stated in Step 1:

```powershell
$manifestPath = Join-Path $quarantineRoot 'manifest.jsonl'
$records = Get-Content -LiteralPath $manifestPath -Encoding utf8 |
    Where-Object { $_.Trim() } |
    ForEach-Object { $_ | ConvertFrom-Json } |
    Where-Object { $_.state -eq 'quarantined' }
$cacheId = ($records | Where-Object category -eq 'stale_cache' | Sort-Object source | Select-Object -First 1).id
$backupId = ($records | Where-Object category -eq 'retention_expired' | Sort-Object source | Select-Object -First 1).id
$treeId = ($records | Where-Object category -eq 'proven_regenerable' | Sort-Object @{Expression='size';Descending=$true},source | Select-Object -First 1).id
$restoreIds = @($cacheId, $backupId, $treeId)
if ($restoreIds.Count -ne 3 -or $restoreIds -contains $null) { throw 'Restore drill categories are incomplete' }
$restoreArgs = @('mod-tools/wf_asset_maintenance.py', 'restore', '--manifest', $manifestPath)
foreach ($id in $restoreIds) { $restoreArgs += @('--id', [string]$id) }
python @restoreArgs
```

Expected: exit 0; original paths exist and hashes/tree digest equal the pre-quarantine manifest.

- [ ] **Step 3: Re-quarantine using the original immutable plan records**

```powershell
$resumeArgs = @('mod-tools/wf_asset_maintenance.py', 'quarantine', '--resume', '--manifest', $manifestPath)
foreach ($id in $restoreIds) { $resumeArgs += @('--id', [string]$id) }
python @resumeArgs
```

Expected: exit 0; original paths are absent again, quarantine paths and digests are valid, and no duplicate manifest identity is created.

- [ ] **Step 4: Write the final report**

The report contains exact counts and bytes for:

1. isolated and recoverable;
2. protected/live referenced;
3. corrupt but retained;
4. unknown/evidence insufficient;
5. future permanent-delete candidates.

It explicitly states that same-volume quarantine has not freed D: space and that `purge` was not executed.

- [ ] **Step 5: Commit only policy/tool documentation changes if any**

Runtime scan, plan, quarantine and report remain ignored. If implementation required tracked usage documentation, stage that exact file with the asset tool paths and commit `docs: document reversible asset cleanup`; otherwise make no additional commit.

---

## Final Acceptance Gate

- [ ] 扫描只遍历 policy 中的明确根，不跟随 reparse point，不扫描 `.git`，并为每个候选提供大小与哈希/Merkle 证据。
- [ ] protected、unknown、corrupt 分类的移动数均为 0；活动 CDN、`WorldFlipper`、`.cdn/cn`、快照、生成器输入和用户 WIP 均有保护证据。
- [ ] `弹国服/assets` 仅在 `assets.rar` 通过 7-Zip 测试且成员路径、大小、CRC 全等时进入重复候选。
- [ ] `.pyc` 和 `.bak-wfmod-*` 只按已测试的缓存/保留策略隔离；备份仍保留每目标最新 3 份、最后成功点及所有被引用项。
- [ ] 所有动作由不可变 plan digest 授权，源/隔离目标摘要一致，发生中断后可安全 resume。
- [ ] 三类确定性样本完成 byte-identical restore drill 并重新隔离，无重复 manifest identity。
- [ ] 首轮未执行 purge；报告明确隔离字节数、保护字节数、损坏保留数、未知数及未来删除候选。
- [ ] P0/Node/Python/WF 非设备自检在隔离后仍通过，用户 WIP 与旧后台路径未改变。
