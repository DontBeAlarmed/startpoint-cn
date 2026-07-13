# Seris Dual-Form Character Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在 CN 服创建全新的水属性龙王“赛瑞斯”，交付可重复构建的角色数据包、30 秒人形/龙形战斗形态、双元素技能、原创 UI/像素/Flatomo/SFX、22 条日语游戏语音，以及可安装和回滚的通用 `dual_form_v1` 客户端基座。

**Architecture:** 战斗权威仍由原生 `Unique 22` 与 `switched_action_skill` 决定；客户端基座只从原生切换条件派生表现状态，并补齐 matched 像素、cut-in、循环效果和跨 zone 的原生 condition 续存。通用角色包工具以声明式 manifest 驱动四类根目录和表事务，先在隔离 staging 中读回、校验和打包，再通过单一 active release manifest 原子公开三根 CDN 增量。赛瑞斯专属模块只提供数据和资产规格，不向通用客户端写入角色 ID 或 code name。

**Tech Stack:** Python 3 标准库 + Pillow/ffmpeg/ffprobe、现有 AMF3/ATF 工具、ActionScript 3/FFDec、TypeScript/Fastify、Node `node:test`、ADB/MuMu、GPT 图片生成用于位图母版。

## Global Constraints

- 设计权威是 `docs/superpowers/specs/2026-07-13-seris-dual-form-character-design.md`；发现实现与规格冲突时先停下并更新设计评审，不静默改需求。
- 只使用 CN profile 和真实 CN upload store；不得回退到国际服表、全局样本或旧备份作为写入来源。
- 每次 apply 前重新确认 `129999`、`1299991`–`1299996`、leader `129999`、Unique `22`、`seris_dragon_king` 和两套技能键仍未被其他包占用。
- `dual_form_v1` 不得硬编码 `129999` 或 `seris_dragon_king`；唯一适用条件是 `ModDualForm` 标签加原生 `ConditionExist + Unique` switching 合同。
- 客户端表现控制器不得计算伤害、增加技能槽、刷新 Unique 或维护第二套 1800 帧计时器。
- 原生续战结构当前不保存活跃 condition；跨 zone 必须续存并无事件地恢复 switching 所引用 Unique 的实际剩余帧，恢复过程不得再次触发能力 6。
- 能力 6 的纯数据 canary 是硬门：若不能证明每次 `0→1` 恰好触发一次，且 zone 切换、表现重建和 condition 恢复均不误触发，则停止正式角色实现并回到设计评审；不得把充能逻辑移入客户端。
- 混合元素技能也是硬门：必须先证明同一 ActionDsl 的显式水/雷段按敌人各自抗性独立结算。
- APK 主 SWF 不能由服务端/CDN 安装。Mod 工具只允许通过本机 ADB 覆盖安装；界面和文档不得称为“服务端推送客户端补丁”。
- 禁止自动卸载、`pm clear`、删除用户下载目录或猜测 APK；安装成功后只清理 `/data/data/com.leiting.wf/cache/app/`。
- 本角色不生成剧情语音、`words`、登录语音、剧情立绘或表情差分；包校验必须拒绝这些路径。
- 所有人形/龙形资产都必须保持银白鳞甲、深蓝布料、蓝眼和同一角色身份；不得残留黑狼、金丝雀、Kyle 或任何模板角色的可见像素、路径、字符串和 atlas 键。
- 生成资产、APK、store staging、QA 视频与发布 zip 全部放在 `/work/character_packs/seris_dragon_king/` 或其发布目录，不提交大体积二进制；只提交可重现的代码、AS3 源、声明式规格、测试和文档。
- 运行时目录固定分层：`authoring/` 保存可编辑源，`build/roots/` 保存编译输出，`qa/` 保存证据，`package/` 保存从空目录组装的最终包，`release/` 保存待激活 zip/journal；`--clean` 只允许清理 `package/` 或一次性 staging，不得删除 `authoring/` 和 `qa/`。
- 不修改 `web/pages/`、`src/routes/web/`、`web/public/`；不提交 `web/dist`、`admin/node_modules`，不碰未跟踪逆向目录的内容。
- 每次提交只 stage 本任务明确列出的路径；不得使用 `git add .` 或 `git add -A`。
- 当前 `mod-tools/work/sync_pending.json` 曾被一次误调用清成 `[]`，同步前内容和实际推送结果未知。实现阶段不得猜测恢复旧队列；所有新 pending 项只能由本计划的 manifest/dry-run 从零生成并在执行前展示。

## File Map

### New production files

- `mod-tools/schemas/character-pack-v1.schema.json` — 通用角色包 manifest 合同。
- `mod-tools/wf_character_pack.py` — 包加载、冲突检查、只读快照和隔离 staging 原语；不写生产。
- `mod-tools/wf_seris_pack.py` — 赛瑞斯常量、表行、技能规格、包构建 CLI。
- `mod-tools/wf_bundle.py` — 按精确 logical path 读取 CN bundle 及 raw-deflate AMF3 容器。
- `mod-tools/wf_pixelart.py` — 两套像素 sprite-sheet/atlas/frame/timeline 的确定性编译器。
- `mod-tools/wf_flatomo.py` — 可读 IR、AMF3 编译、结构验证与 fixture/golden gate。
- `mod-tools/wf_audio.py` — 语音/SFX 路径合同、ffprobe、响度、CBR 与解码校验。
- `mod-tools/wf_voice.py` — 凭据外置的日语语音生成适配器和 take 记录。
- `mod-tools/wf_character_art.py` — 透明母版到 27 张 UI PNG、atlas 和 4 张 cut-in ATF 的确定性派生。
- `mod-tools/wf_client_base.py` — SWF 注入、ABC/P-code 验证、APK 对齐/签名/安装/runtime marker/回滚。
- `mod-tools/wf_release.py` — 四根 staging、三根 zip 和 active release manifest 的事务发布。
- `mod-tools/characters/seris_dragon_king/character.json` — 角色、leader、abilities、Unique、skills 与 speech 行声明。
- `mod-tools/characters/seris_dragon_king/voice-lines.json` — 22 条中文稿、日语台词、声线与文件映射。
- `mod-tools/characters/seris_dragon_king/pixel-sequences.json` — 两形态序列、帧数、tick、锚点和帧目录。
- `mod-tools/characters/seris_dragon_king/effects.json` — 五套 Flatomo 与六个 SFX 的时长/引用合同。
- `mod-tools/characters/seris_dragon_king/art-direction.md` — 三张透明母版的身份不变量和生成提示。
- `client-patch/dual-form-v1/patch-manifest.json` — 基线 SWF、导入类、P-code 断言和 capability 版本。
- `client-patch/dual-form-v1/as3/` — 通用双形态 AS3 hook、控制器、runtime marker 与续战扩展。
- `client-patch/dual-form-v1/patch_dual_form.py` / `verify_dual_form.py` — 幂等源补丁与最终 P-code 检查。
- `client-patch/dual-form-v1/README.md` — 本地构建、覆盖安装、验证和回滚说明。
- `client-patch/tests/test_dual_form_patch.py` / `test_dual_form_pcode.py` — 源锚点、状态合同和最终 ABC/P-code 回归。
- `src/lib/cn-character-release.ts` — active release manifest 解析、三根完整性检查和版本链合并。
- `src/tests/cn-character-release.test.ts` — 半包不可见、旧链兼容、hash 与回滚链测试。
- `docs/mod-tools/seris-character-pack.md` — 角色包生产、canary、发布和验收手册。

### Modified production files

- `.gitignore` — 忽略 `/work/character_packs/`。
- `mod-tools/wf_mod_tool.py` — 通用嵌套 orderedmap 与 `switched_action_skill` 读写。
- `mod-tools/wf_dsl.py` — 带路径/祖先/顺序的命令遍历和语义检查支撑。
- `mod-tools/wf_assets.py` — matched ready/skill 语音发现和角色包显式白名单。
- `mod-tools/wf_gui.py` / `mod-tools/wf_gui.html` — “客户端基座”“角色包”薄适配页。
- `mod-tools/wf_publish.py` — 仅暴露版本/zip 原语供事务发布器复用，不承载角色业务规则。
- `src/routes/cn/asset.ts` — legacy diff 与 active character release 的安全合并。
- `src/lib/version.ts` — active character release 版本参与有效版本和缓存失效。

### New tests

- `mod-tools/tests/test_character_pack.py`
- `mod-tools/tests/test_seris_pack.py`
- `mod-tools/tests/test_bundle.py`
- `mod-tools/tests/test_pixelart.py`
- `mod-tools/tests/test_flatomo.py`
- `mod-tools/tests/test_audio.py`
- `mod-tools/tests/test_character_art.py`
- `mod-tools/tests/test_client_base.py`
- `mod-tools/tests/test_release.py`
- `mod-tools/tests/test_gui_character_pack.py`

## Dependency Order and Gates

1. Task 0 先把反编译新证据形成设计补充并取得用户确认；未确认前不得实现 condition 续战补丁。
2. Tasks 1–4 建立纯数据与包合同。
3. Task 5 先完成混合元素和能力 6 的纯数据边沿 canary；Task 10 安装基座后再完成 zone/condition 恢复 canary。两部分都通过后，Task 15 才能生成“可发布”正式包。
4. Tasks 6–8 建立音频、像素和 Flatomo 编译器；Task 8 的官方 fixture 与 golden effect 两道门通过后，才制作五套完整特效。
5. Tasks 9–10 建立并真机确认 `dual_form_v1`。未安装基座时，人形/龙形技能与 matched voice 仍可用，但 matched 视觉和跨 zone 的 Unique 剩余帧续存均不作保证。
6. Tasks 11–14 的四类原创资产可在各自编译器测试通过后并行制作。
7. Tasks 15–17 只消费已通过 QA 的产物；Task 16 的 active manifest 是服务器可见性的唯一提交点。
8. Task 18 完成真机全链路和双回滚后才算交付。

---

### Task 0: Approve the native-condition continuation design addendum

**Files:**
- Modify after explicit review: `docs/superpowers/specs/2026-07-13-seris-dual-form-character-design.md`

- [ ] **Step 1: Record the newly verified native gap**

Add the read-only decompile evidence: `BattleContinuationData.next()` and `MemberImpl.setContinuationData()` do not capture/restore active conditions, while the native expiry formula is `addedTime + timeLimit - frameCount` and a condition expires only when the result is `< 0`.

- [ ] **Step 2: Narrowly authorize a generic native continuation repair**

Change the scope from “client patch is presentation only” to: the controller remains presentation-only, while the same client base may persist and silently restore only the one Unique condition selected by a valid `ModDualForm + ConditionExist + Unique` switching contract. It must not persist unrelated buffs/debuffs, compute damage/gauge, emit condition-change events, or own a second timer.

- [ ] **Step 3: Correct the unpatched-client fallback promise**

Document that an unpatched client still selects native human/dragon ActionDsl and matched voice, but keeps human pixel/cut-in and cannot guarantee that the 1800-frame Unique survives a zone transition because the baseline client omits active conditions from continuation data.

- [ ] **Step 4: Define proof stronger than call avoidance**

Require exported P-code inspection plus an instrumented device canary proving that restoration dispatches no condition-change/ability trigger, does not add gauge, preserves the exact remaining frame and directly builds the matched view without replaying `form_in`.

- [ ] **Step 5: Stop for explicit design approval**

Show the addendum diff to the user. Do not edit AS3 or claim cross-zone support until the user approves this scope correction; if rejected, remove the cross-zone persistence guarantee instead of creating a hidden gameplay patch.

- [ ] **Step 6: Commit the approved addendum separately**

```powershell
git add -- docs/superpowers/specs/2026-07-13-seris-dual-form-character-design.md
git commit -m "docs(spec): clarify dual-form continuation scope"
```

---

### Task 1: Generic nested tables and package manifest contract

**Files:**
- Modify: `.gitignore`
- Modify: `mod-tools/wf_mod_tool.py`
- Create: `mod-tools/schemas/character-pack-v1.schema.json`
- Create: `mod-tools/wf_character_pack.py`
- Modify: `mod-tools/tests/test_core.py`
- Create: `mod-tools/tests/test_character_pack.py`

- [ ] **Step 1: Resolve the current CN profile and run the existing baseline without writing**

Run a read-only profile check and the existing core tests:

```powershell
$env:PYTHONPATH=(Resolve-Path 'mod-tools').Path
python -c "from wf_mod_tool import resolve_profile; p=resolve_profile('cn'); assert p and p.store.exists(); print(p.id, p.store, p.res_version)"
python -m unittest mod-tools.tests.test_core -v
```

Expected: existing core tests pass; the selected profile identifies an existing CN store. Task 3's read-only `plan` command records table hashes and key reservations after that API exists. Do not run import/apply/sync commands.

- [ ] **Step 2: Write failing raw nested-table tests**

Add tests that construct an outer orderedmap with two inner rows, then require:

```python
decoded = load_nested_table_bytes(encoded, logical)
self.assertEqual(list(decoded.rows), ["seris_dragon_king", "fixture"])
self.assertEqual(decoded.rows["seris_dragon_king"], original_inner_rows)
self.assertEqual(build_nested_table(decoded, logical), encoded)
```

Cover `master/skill/action_skill.orderedmap` and `master/skill/switched_action_skill.orderedmap`; assert the switched program path is read from its inner `c0`, never from outer action-skill column `c7`.

- [ ] **Step 3: Run the focused tests and confirm the expected missing APIs**

```powershell
python -m unittest mod-tools.tests.test_core.TestGenericNestedTable -v
```

Expected: fail because `load_nested_table_bytes`, `build_nested_table`, and `SWITCHED_ACTION_SKILL_LOGICAL` do not yet exist.

- [ ] **Step 4: Implement table-specific, lossless nested read/write primitives**

Add constants and signatures:

```python
ACTION_SKILL_LOGICAL = "master/skill/action_skill.orderedmap"
SWITCHED_ACTION_SKILL_LOGICAL = "master/skill/switched_action_skill.orderedmap"

def load_nested_table(logical_path: str, target_store: Path,
                      source_store: Path | None = None) -> OrderedMap: ...
def load_nested_table_bytes(raw: bytes, logical_path: str) -> OrderedMap: ...
def build_nested_table(ordered: OrderedMap, logical_path: str) -> bytes: ...
def write_nested_table(ordered: OrderedMap, logical_path: str, target_store: Path,
                       backup_suffix: str, no_backup: bool = False) -> Path: ...
```

Dispatch each logical path to its real inner-row decoder, preserve outer and inner key order/types, and reject unknown nested layouts instead of guessing.

- [ ] **Step 5: Write the failing generic manifest tests**

The schema and Python loader must require:

```json
{
  "schema_version": 1,
  "package_id": "seris_dragon_king",
  "character_id": 129999,
  "code_name": "seris_dragon_king",
  "package_version": "1.0.0",
  "requires_client_base": "dual_form_v1",
  "required_capabilities": ["ModDualForm", "MatchedCutin", "MatchedPixelart"],
  "roots": {"common": [], "medium": [], "android": [], "server": []},
  "tables": [],
  "skills": {},
  "unique_condition": {},
  "qa": {},
  "snapshot": {}
}
```

Test rejection of absolute paths, `..`, duplicate logical paths, a file present in two roots, missing SHA-256, unknown schema versions, and story/`words`/login/expression asset paths.

- [ ] **Step 6: Run the manifest contract test and confirm the missing contract**

```powershell
python -m unittest mod-tools.tests.test_character_pack.TestManifestContract -v
```

Expected: fail because the schema file and `wf_character_pack` loader/validation APIs do not exist yet.

- [ ] **Step 7: Implement strict manifest loading and canonical hashing**

In `wf_character_pack.py` expose:

```python
@dataclass(frozen=True)
class PackFile:
    root: Literal["common", "medium", "android", "server"]
    logical_path: str
    sha256: str
    size: int

def load_manifest(path: Path) -> dict: ...
def validate_manifest(manifest: dict, package_dir: Path) -> list[str]: ...
def canonical_manifest_bytes(manifest: dict) -> bytes: ...
```

Validation returns all deterministic errors in sorted order and never mutates a live store.

- [ ] **Step 8: Protect generated work and run the foundation tests**

Add `/work/character_packs/` to `.gitignore`, then run:

```powershell
python -m unittest mod-tools.tests.test_core.TestGenericNestedTable -v
python -m unittest mod-tools.tests.test_character_pack.TestManifestContract -v
python -m unittest discover -s mod-tools/tests -p "test_*.py" -v
```

Expected: all tests pass; the existing baseline remains at least 74 passing tests plus the new cases.

- [ ] **Step 9: Commit the generic contract**

```powershell
git add -- .gitignore mod-tools/wf_mod_tool.py mod-tools/schemas/character-pack-v1.schema.json mod-tools/wf_character_pack.py mod-tools/tests/test_core.py mod-tools/tests/test_character_pack.py
git commit -m "feat(mod-tools): add character pack contract"
```

---

### Task 2: Transactional pack preflight, snapshot, and isolated staging

**Files:**
- Modify: `mod-tools/wf_character_pack.py`
- Modify: `mod-tools/tests/test_character_pack.py`

- [ ] **Step 1: Write failing collision and upgrade-ownership tests**

Create temporary stores and assert:

- first install refuses any occupied character/ability/leader/skill/Unique/code-name key not owned by this package;
- upgrade is allowed only when the installed manifest has the same `package_id`;
- version diff is returned before write;
- `prepare()` writes only under a supplied staging root;
- root-to-store mapping is exact: server → project `assets/`, common/medium/android → their own upload stores.

- [ ] **Step 2: Write failing all-or-nothing staging tests**

Inject failures after each staging phase: table materialization, asset copy, readback, hash verification. Require every live file to remain byte-identical and the active manifest to remain unchanged.

```python
with self.assertRaises(PackStagingError):
    tx.materialize_staging(fail_after="readback")
self.assertTreeEqual(live_before, live_after)
```

- [ ] **Step 3: Confirm failures before implementation**

```powershell
python -m unittest mod-tools.tests.test_character_pack.TestPackPreflight mod-tools.tests.test_character_pack.TestPackStagingRecovery -v
```

Expected: fail on missing `PackTransaction` and ownership checks.

- [ ] **Step 4: Implement an explicit plan/apply boundary**

Expose:

```python
class PackTransaction:
    def preflight(self) -> PreflightReport: ...
    def prepare(self, staging_root: Path) -> PreparedPack: ...
    def snapshot(self, snapshot_root: Path) -> SnapshotRecord: ...
    def materialize_staging(self, prepared: PreparedPack) -> StagedPack: ...
    def discard_staging(self, staged: StagedPack) -> None: ...
```

`PreparedPack` must hold expected before/after hashes for every table key and file. `materialize_staging()` writes only beneath the supplied staging root and reads back every nested table. No API in `wf_character_pack.py` may write production stores or active release state; `wf_release.py` owns that single locked activation in Task 16.

- [ ] **Step 5: Make snapshots address exact keys and files**

Snapshot records must list each outer key, each nested skill key, four server JSON paths, all asset paths, current active release ID, and whether a path was absent. They are read-only inputs to Task 16. `discard_staging()` deletes only the isolated staging tree; after an active release, restoration is allowed only through Task 16's new forward reverse-diff release.

- [ ] **Step 6: Test dry-run output stability**

Serialize the plan twice and assert byte-identical sorted JSON containing `creates`, `updates`, `deletes`, `conflicts`, root totals, and capability warnings. A missing `dual_form_v1` capability requires explicit degraded-data confirmation and must state that matched visuals and cross-zone Unique persistence are unavailable; it cannot be presented as full dual-form delivery.

- [ ] **Step 7: Run tests and commit**

```powershell
python -m unittest mod-tools.tests.test_character_pack -v
git add -- mod-tools/wf_character_pack.py mod-tools/tests/test_character_pack.py
git commit -m "feat(mod-tools): add transactional character packs"
```

---

### Task 3: Declarative Seris master data, leader, abilities, Unique, and speech

**Files:**
- Create: `mod-tools/characters/seris_dragon_king/character.json`
- Create: `mod-tools/characters/seris_dragon_king/voice-lines.json`
- Create: `mod-tools/wf_seris_pack.py`
- Create: `mod-tools/tests/test_seris_pack.py`

- [ ] **Step 1: Write the immutable source declarations**

Declare exactly:

```python
SERIS_ID = "129999"
SERIS_CODE = "seris_dragon_king"
ABILITY_IDS = tuple(str(1299990 + i) for i in range(1, 7))
LEADER_ID = "129999"
UNIQUE_ID = "22"
TAG = "ModDualForm"
```

Use ★5 water Dragon donor `121105` only for row shape and level curve. Set male, attack role, `speciality_type=2`, Lv100 HP `3780`, ATK `940`, skill energy `520`; remap every character-owned key/path to the new ID/code name.

The visible identity is fixed: Chinese name `赛瑞斯`, Japanese name `セイリス`, title `苍海龙王`, human skill `苍海雷狱・龙王显现`, dragon skill `天穹万潮・王龙雷息`, leader `苍海龙王的敕令`, and remote attack range. The character description is `统御苍海与风暴的古龙之王。平日以银鳞龙人的姿态行走于人世；解开王印后便显露翼龙真身，以万潮与苍雷肃清战场。`

- [ ] **Step 2: Write failing semantic row tests**

Tests must decode generated rows by named columns and assert:

- character element uses table value `1` for water;
- role/race/sex/rarity/stats match the design;
- no generated row still points to donor `121105` or its code name;
- server JSON mirrors exist for `assets/cdndata/character.json`, `assets/cdndata/character_text.json`, `assets/character.json`, and `assets/mana_node.json`;
- status keys `10,1,80,100` produce exact Lv100 HP/ATK;
- mana nodes point only to `1299991`–`1299996`.

The generated table set must explicitly cover `character`, `character_text`, `character_status`, `character_awake_status`, `mana_node`, `ability`, `leader_ability`, `action_skill`, `switched_action_skill`, `unique_condition`, `character_speech`, `character_image`, `full_shot_image_attribute` and `trimmed_image`. Text tests require the approved character/skill/leader/ability descriptions and reject any donor string ID or untranslated template text.

- [ ] **Step 3: Run the semantic tests and confirm the missing builder failure**

```powershell
python -m unittest mod-tools.tests.test_seris_pack.TestSerisMasterRows mod-tools.tests.test_seris_pack.TestSerisAbilityRows -v
```

Expected: fail because the Seris row builder and nested switched-skill support have not been implemented.

- [ ] **Step 4: Encode leader and six ability contracts**

Use existing official layouts as structural donors, then assert semantics:

| Key | Required semantic effect |
|---|---|
| leader `129999` | water characters ATK +100%, skill damage +150%, no main-position restriction |
| `1299991` | self skill damage +75%, always active |
| `1299992` | `SkillInvoke(23)`, limit 3, self `SkillDamage(34)` +30% each |
| `1299993` | battle start self gauge +100%; while Unique 22 exists self ATK +100%; main only |
| `1299994` | self skill damage +40%, always active |
| `1299995` | all water characters skill damage +30% |
| `1299996` | Unique 22 `0→1` self gauge +30%, limit 3; while Unique exists self skill damage +50%; main only |

For the experimental ability-6 entry use exactly trigger `185`, puller/target self `0`, Unique `22`, threshold `1`, limit `3`, content `211`, strength `30000`. Mark the package `canary_pending` until Task 5 evidence passes.

Semantic tests also require abilities 1 and 4 to work from the unison slot, ability 2 to count both human and dragon casts and reset each battle, and ability 3's opening 100% gauge to run once per battle. Mana-board mapping is fixed: abilities 1–3 on the base board, abilities 4–6 on the second/awakening board.

- [ ] **Step 5: Encode Unique 22 and switching rows**

Require Unique row:

```text
id=22
string_id=unique_seris_dragon_king
name=龙王显现
icon_image=battle/common/unique_condition/unique_seris_dragon_king
flags=false,true,0,0,true
max_stack=1
extra=(None)
```

Decode and assert the flag semantics individually: `cancelable=false`, `force_apply=true`, `condition_direction=0` (good), `overwrite_mode=0`, `remove_if_encoffin=true`.

Require action-skill switching columns `kind=1`, condition master kind `28`, condition parameter `22`, switched key `seris_dragon_king`, `no_voice=false`, `no_ready_voice=false`. Update `_SWITCH_COLS` during Task 17, but generate and test the raw row here.

- [ ] **Step 6: Encode both skill tables without sharing inner programs**

Create outer key `seris_dragon_king` in both `action_skill` and `switched_action_skill`, with complete base/evolution level rows and independent program paths. Tests must resolve the switched program from its inner `c0` and prove neither table points to a donor program.

- [ ] **Step 7: Encode exactly eight `character_speech` rows**

Use actual row order `[kind,constraint,evolution_level,text,voice_path]`, without `.mp3` in `voice_path`. Encode this exact mapping; `null` means the table field is empty:

| Voice path | Kind | Constraint | Evolution level |
|---|---:|---:|---:|
| `home/human_form` | 0 | 0 | null |
| `home/storm` | 0 | 2 | null |
| `home/memory` | 0 | 2 | null |
| `home/courage` | 0 | 1 | null |
| `home/true_form` | 0 | 1 | null |
| `home/tea` | 0 | 1 | null |
| `ally/evolution` | 1 | null | 1 |
| `ally/join` | 2 | null | null |

Leave the 14 fixed combat files out of `character_speech`.

- [ ] **Step 8: Run semantic tests and inspect the dry-run**

```powershell
python -m unittest mod-tools.tests.test_seris_pack.TestSerisMasterRows mod-tools.tests.test_seris_pack.TestSerisAbilityRows -v
python mod-tools/wf_seris_pack.py plan --profile cn --output work/character_packs/seris_dragon_king/plan.json
```

Expected: tests pass; plan reports no writes and retains `canary_pending`. If any reserved key is occupied, stop instead of choosing a new ID silently.

- [ ] **Step 9: Commit declarations and adapter**

```powershell
git add -- mod-tools/characters/seris_dragon_king/character.json mod-tools/characters/seris_dragon_king/voice-lines.json mod-tools/wf_seris_pack.py mod-tools/tests/test_seris_pack.py
git commit -m "feat(mod-tools): declare Seris character data"
```

---

### Task 4: Explicit dual-element ActionDsl and semantic validator

**Files:**
- Modify: `mod-tools/wf_dsl.py`
- Modify: `mod-tools/wf_seris_pack.py`
- Modify: `mod-tools/characters/seris_dragon_king/character.json`
- Modify: `mod-tools/tests/test_dsl.py`
- Modify: `mod-tools/tests/test_seris_pack.py`

- [ ] **Step 1: Write failing command traversal tests**

Add:

```python
commands = list(iter_commands(tree))
self.assertEqual(commands[0].order, 0)
self.assertEqual(commands[0].path, (0, "commands", 0))
self.assertEqual(commands[0].ancestors[-1].name, "ForEachAliveEnemy")
```

`iter_commands(tree)` must return stable preorder, tuple path, command name, parameters, and ancestor stack without changing the tree.

- [ ] **Step 2: Run the traversal test and confirm the missing API failure**

```powershell
python -m unittest mod-tools.tests.test_dsl.TestCommandTraversal -v
```

Expected: fail because `iter_commands` and `DslCommandRef` do not exist.

- [ ] **Step 3: Implement traversal and typed semantic extraction**

Add immutable `DslCommandRef` and helpers that can identify `CreateNormalAttack`, `ACToleranceOfElement`, condition grants, subject scopes, effect calls and timing markers. Unknown commands remain visible to reports and are never discarded.

- [ ] **Step 4: Write failing human-skill assertions**

Require ordered attack segments:

```text
[water 1.6, water 1.6, water 1.6, water 1.6, water 1.6,
 water 2.0, thunder 1.5, thunder 1.5, thunder 1.5, thunder 1.5]
```

ActionDsl element IDs are explicitly water `2` and thunder `3`; value `255` is forbidden. After hit 10, apply water and thunder resistance `-10%` for `1800` frames to hit enemies, then outside the enemy-subject branch grant self Unique `22` for `1800` frames and trigger `transform`.

All ten segments target each currently alive enemy. Tests sum the first six water multipliers to `10.0` and the last four thunder multipliers to `6.0`, require `human_start` before hit 1, and require `transform` only after self Unique 22 has actually been inserted. The 1800-frame measurement begins on that insertion frame, not at cast, voice, cut-in or `human_start` start.

- [ ] **Step 5: Write failing dragon-skill assertions**

Require `[water 2.0×5, thunder 2.0×5]`, with each element totaling `10.0`, then 300-frame paralysis after hit 10. Require `dragon_attack` before hit 1. Traverse the entire tree and fail if any command grants, extends, overwrites or refreshes Unique `22`, calls `transform`, or changes the native remaining time.

- [ ] **Step 6: Run both semantic tests and confirm the missing skill builders**

```powershell
python -m unittest mod-tools.tests.test_seris_pack.TestSerisDslContract -v
```

Expected: fail on missing `build_seris_human_dsl` and `build_seris_dragon_dsl`.

- [ ] **Step 7: Generate both DSLs from explicit specs**

Expose:

```python
def build_seris_human_dsl(donor_tree: dict) -> dict: ...
def build_seris_dragon_dsl(donor_tree: dict) -> dict: ...
def validate_seris_dsl(kind: Literal["human", "dragon"], tree: dict) -> list[str]: ...
```

Use donor structure only for client-compatible command shapes and labels. Multipliers are written to command parameter 6 as complete skill-level arrays; every attack segment sets its own element.

- [ ] **Step 8: Prove lossless encoding and exact semantics**

```powershell
python -m unittest mod-tools.tests.test_dsl -v
python -m unittest mod-tools.tests.test_seris_pack.TestSerisDslContract -v
python mod-tools/wf_seris_pack.py inspect-dsl --profile cn --format json
```

Expected: decode→encode→decode preserves key order/types; report prints 10 ordered hits for each form and the exact post-hit effects.

- [ ] **Step 9: Commit DSL support**

```powershell
git add -- mod-tools/wf_dsl.py mod-tools/wf_seris_pack.py mod-tools/characters/seris_dragon_king/character.json mod-tools/tests/test_dsl.py mod-tools/tests/test_seris_pack.py
git commit -m "feat(mod-tools): build Seris dual-element skills"
```

---

### Task 5: Mixed-element and ability-6 hard canary gates

**Files:**
- Modify: `mod-tools/wf_seris_pack.py`
- Modify: `mod-tools/wf_character_pack.py`
- Modify: `mod-tools/tests/test_seris_pack.py`
- Modify: `mod-tools/tests/test_character_pack.py`
- Create at runtime only: `work/character_packs/seris_dragon_king/qa/canary-evidence.json`

- [ ] **Step 1: Write the evidence schema tests before any device write**

Require two signed data-canary records, each with build hash, source-table hashes, device/package version, timestamp, test cases, observed values and pass/fail. `data_canaries_ready()` returns false for missing, stale, failed or hash-mismatched evidence; `formal_package_ready()` additionally requires Task 10's continuation canary.

- [ ] **Step 2: Run the evidence-gate tests and confirm the missing APIs**

```powershell
python -m unittest mod-tools.tests.test_seris_pack.TestSerisCanaryGate mod-tools.tests.test_character_pack.TestQaGates -v
```

Expected: fail because the evidence-record validator, freshness/hash checks and release-readiness gates do not exist yet.

- [ ] **Step 3: Implement isolated canary package generation**

Add CLI modes that create minimal, independently reversible data diffs:

```powershell
python mod-tools/wf_seris_pack.py canary-build mixed-element --profile cn --output work/character_packs/seris_dragon_king/canary/mixed-element
python mod-tools/wf_seris_pack.py canary-build ability6 --profile cn --output work/character_packs/seris_dragon_king/canary/ability6
```

Neither mode may include final art/audio, client gameplay code, or publish an active release.

- [ ] **Step 4: Dry-run, snapshot, and explicitly apply only the mixed-element canary**

Use two enemies with deliberately different water/thunder resistance. Capture all ten displayed/internal damage events and prove the first six use water resistance and final four use thunder resistance. If the result cannot be distinguished, improve instrumentation and repeat; do not infer from effect color.

- [ ] **Step 5: Roll back the first canary and apply only the ability-6 canary**

Record all of these cases:

1. first, second and third real `0→1` transitions each add exactly 30% gauge;
2. fourth transition adds no gauge;
3. maintaining or refreshing the same active stack adds none;
4. after real expiry, a new cast creates the next valid transition;
5. ability 2 increments before the first ActionDsl damage hit and stops after three invocations.

Zone and continuation restoration are deliberately deferred until Tasks 9–10, because the baseline client has no condition continuation payload. They remain mandatory final hard-gate cases.

- [ ] **Step 6: Enforce the stop condition in code**

`data_canaries_ready()` becomes true only when both current data records pass. A failed ability-6 record must print “return to design review”; no option may bypass it. Even after these two pass, `wf_seris_pack.py build --release-ready` remains blocked as `client_continuation_pending` until Task 10 proves zone restore/rebuild do not emit a new ability-6 event. A non-release exploratory build cannot publish.

- [ ] **Step 7: Test the gate logic and commit**

```powershell
python -m unittest mod-tools.tests.test_seris_pack.TestSerisCanaryGate mod-tools.tests.test_character_pack.TestQaGates -v
git add -- mod-tools/wf_seris_pack.py mod-tools/wf_character_pack.py mod-tools/tests/test_seris_pack.py mod-tools/tests/test_character_pack.py
git commit -m "feat(mod-tools): gate Seris on battle canaries"
```

Do not commit runtime evidence; the final package manifest records its path and SHA-256.

---

### Task 6: Matched voice discovery and audio validation

**Files:**
- Modify: `mod-tools/wf_assets.py`
- Create: `mod-tools/wf_audio.py`
- Modify: `mod-tools/characters/seris_dragon_king/voice-lines.json`
- Create: `mod-tools/tests/test_audio.py`
- Modify: `mod-tools/tests/test_seris_pack.py`

- [ ] **Step 1: Write failing fixed-voice discovery tests**

Require the fixed set to include:

```text
battle/matched_skill_ready.mp3
battle/matched_skill_0.mp3
battle/matched_skill_1.mp3
```

Assert clone/export/import/template validation returns all 14 battle files plus the eight `character_speech` files, exactly 22 unique paths.

- [ ] **Step 2: Run the discovery test and confirm matched paths are absent**

```powershell
python -m unittest mod-tools.tests.test_audio.TestMatchedVoiceDiscovery -v
```

Expected: fail because `_VOICE_FIXED` does not yet expose the three matched-skill files and the exact 22-path contract is unmet.

- [ ] **Step 3: Add the matched voice paths without broad vocabulary guesses**

Extend `_VOICE_FIXED` and make package validation use the explicit Seris manifest. Do not scan or include story/login/`words` directories merely because an MP3 exists.

- [ ] **Step 4: Write failing audio probe tests**

Mock ffprobe JSON and real short fixture files to require: 44.1 kHz, mono, MP3, 96 kbps CBR, every frame decodable, integrated loudness near `-16 LUFS`, true peak ≤ `-1 dBTP`, non-empty leading/trailing decoded samples, and unique SHA-256 per intended recording except deliberate SFX reuse by reference.

- [ ] **Step 5: Run the audio-contract test and confirm the probe API is missing**

```powershell
python -m unittest mod-tools.tests.test_audio.TestAudioContract -v
```

Expected: fail because `wf_audio.AudioContract`, probing, decoding and normalization validation do not exist yet.

- [ ] **Step 6: Implement the validation/report API**

Expose:

```python
@dataclass(frozen=True)
class AudioContract:
    sample_rate: int = 44100
    channels: int = 1
    bitrate: int = 96000
    integrated_lufs: float = -16.0
    true_peak_db: float = -1.0

def probe_audio(path: Path) -> AudioProbe: ...
def validate_audio(path: Path, contract: AudioContract) -> list[str]: ...
def normalize_to_mp3(source: Path, destination: Path, contract: AudioContract) -> None: ...
```

Use two-pass loudness measurement; never accept only container metadata as proof of decodability or CBR.

- [ ] **Step 7: Validate line identity rules**

`voice-lines.json` must contain exactly 22 records, unique logical paths, Chinese script, Japanese spoken line copied byte-for-byte from the approved design, form (`human` or `dragon`), delivery direction, pronunciation overrides and speech-table metadata where applicable. Human lines use a restrained low male middle register; dragon lines are independently performed with the same identity plus resonance/formant treatment, not a simple pitch-shift and not an imitation of a real actor.

- [ ] **Step 8: Run tests and commit**

```powershell
python -m unittest mod-tools.tests.test_audio mod-tools.tests.test_seris_pack.TestSerisVoiceContract -v
git add -- mod-tools/wf_assets.py mod-tools/wf_audio.py mod-tools/characters/seris_dragon_king/voice-lines.json mod-tools/tests/test_audio.py mod-tools/tests/test_seris_pack.py
git commit -m "feat(mod-tools): validate matched character audio"
```

---

### Task 7: Exact bundle loader and original pixel animation compiler

**Files:**
- Create: `mod-tools/wf_bundle.py`
- Create: `mod-tools/wf_pixelart.py`
- Create: `mod-tools/characters/seris_dragon_king/pixel-sequences.json`
- Create: `mod-tools/tests/test_bundle.py`
- Create: `mod-tools/tests/test_pixelart.py`
- Modify: `mod-tools/wf_gui.py`

- [ ] **Step 1: Write the exact logical-path loader tests**

Test that `BundleLocator.load_exact(logical_path)` hashes the logical path exactly as passed, searches the configured CN roots in explicit order, and never adds the ActionDsl suffix to pixel/Flatomo paths. Cover APK zip input and extracted upload store input with the same logical path and expected bytes.

- [ ] **Step 2: Run the loader test and confirm the missing module failure**

```powershell
python -m unittest mod-tools.tests.test_bundle -v
```

Expected: fail because `wf_bundle.BundleLocator` does not exist.

- [ ] **Step 3: Implement the shared bundle boundary**

Expose:

```python
class BundleLocator:
    def load_exact(self, logical_path: str) -> bytes: ...
    def load_amf3_deflate(self, logical_path: str) -> OrderedDict: ...
    def store_hash(self, logical_path: str) -> str: ...
```

Move GUI bundle reads to this helper and remove `_apk_read_asset()`'s unconditional DSL-path conversion. Missing or duplicate sources must report all candidates and fail closed in release validation.

- [ ] **Step 4: Write the pixel IR and failing tick-boundary tests**

Use immutable declarations:

```python
@dataclass(frozen=True)
class PixelSequence:
    name: str
    frame_paths: tuple[Path, ...]
    frame_durations: tuple[int, ...]
    loop: bool

@dataclass(frozen=True)
class PixelForm:
    code_name: str
    root_name: Literal["pixelart", "pixelart_matched"]
    standard: tuple[PixelSequence, ...]
    special: tuple[PixelSequence, ...]
```

Assert `len(frame_paths) == len(frame_durations)` and every duration is positive. Texture-name suffixes are cumulative absolute inclusive end ticks: two frames with durations `(5,3)` end at `5,8`, representing ticks `1..5` and `6..8`. Explicitly test sequence boundaries, last tick, and no zero-length range.

- [ ] **Step 5: Declare the exact Seris motion inventory**

`pixel-sequences.json` must contain:

| Form | Sequence | Frames × ticks | Total ticks |
|---|---|---:|---:|
| human | `neutral` | 8×6 | 48 |
| human | `walk_back` | 8×4 | 32 |
| human | `walk_front` | 8×4 | 32 |
| human | `skill_ready` | 6×5 | 30 |
| human | `kachidoki` | 10×5 | 50 |
| human | `into_coffin` | 6×5 | 30 |
| human | `ghost_raise` | 8×5 | 40 |
| human | `ghost_neutral` | 6×6 | 36 |
| human | `revive` | 8×5 | 40 |
| human special | `form_in` | 15×4 | 60 |
| dragon | `neutral` | 10×6 | 60 |
| dragon | `walk_back` | 8×4 | 32 |
| dragon | `walk_front` | 8×4 | 32 |
| dragon | `skill_ready` | 8×5 | 40 |
| dragon | `kachidoki` | 12×5 | 60 |
| dragon special | `matched_skill` | 24×4 | 96 |
| dragon special | `form_out` | 12×4 | 48 |

Require logical canvas 256×256, pivot `(-128,-128)`, scale `6`, `smoothing=false`, and identical `unit_body`/`hp_gauge` anchors in both forms.

- [ ] **Step 6: Run pixel tests and confirm the compiler APIs are missing**

```powershell
python -m unittest mod-tools.tests.test_pixelart -v
```

Expected: fail on missing `compile_sequence_group`, `compile_pixel_bundle`, tick mapping and validators.

- [ ] **Step 7: Implement separate standard/special sheet, atlas, frame, and timeline compilation**

Expose:

```python
def pack_atlas(frames: Sequence[ImageFrame]) -> AtlasResult: ...
def compile_sequence_group(sequences: Sequence[PixelSequence],
                           atlas: AtlasResult, group: Literal["pixelart", "special"]) -> PixelGroupTrees: ...
def compile_pixel_bundle(form: PixelForm, output_root: Path) -> list[Path]: ...
def validate_pixel_bundle(form: PixelForm, output_root: Path) -> list[str]: ...
```

Compile standard and special groups independently so they cannot accidentally share the wrong sheet/atlas. Each form emits exactly these eight client filenames:

```text
sprite_sheet.png
special_sprite_sheet.png
sprite_sheet.atlas.amf3.deflate
special_sprite_sheet.atlas.amf3.deflate
pixelart.frame.amf3.deflate
pixelart.timeline.amf3.deflate
special.frame.amf3.deflate
special.timeline.amf3.deflate
```

All AMF3 files use raw DEFLATE, preserve required key order/types, and read back before success.

- [ ] **Step 8: Add structural and visual diagnostics**

Validate no atlas region is outside bounds or overlaps unexpectedly, no frame is fully transparent, all named sequences resolve, every frame's `fx/fy` and pivot stay in range, all tick→frame mappings match a generated golden JSON, and both anchors remain stable. Generate a contact sheet and animated preview under the package QA directory without committing them.

- [ ] **Step 9: Run tests and commit**

```powershell
python -m unittest discover -s mod-tools/tests -p "test_bundle.py" -v
python -m unittest discover -s mod-tools/tests -p "test_pixelart.py" -v
git add -- mod-tools/wf_bundle.py mod-tools/wf_pixelart.py mod-tools/characters/seris_dragon_king/pixel-sequences.json mod-tools/tests/test_bundle.py mod-tools/tests/test_pixelart.py mod-tools/wf_gui.py
git commit -m "feat(mod-tools): compile matched pixel animation"
```

---

### Task 8: Flatomo IR/compiler with official fixture and golden-effect gates

**Files:**
- Create: `mod-tools/wf_flatomo.py`
- Create: `mod-tools/characters/seris_dragon_king/effects.json`
- Create: `mod-tools/tests/test_flatomo.py`
- Modify: `mod-tools/wf_dsl.py`
- Modify: `mod-tools/wf_seris_pack.py`

- [ ] **Step 1: Write numeric and graph validation tests first**

Cover Q12 `RESOLUTION=4096`, positive/negative truncation, exact int32 boundary acceptance and out-of-range rejection, six-part `IntMatrix`, matrix-index/high-bit and alpha/blend low-12-bit packing, missing part/image/matrix references, texture bounds, non-monotonic frames, invalid durations, sequence overlap, loop closure, sound ticks and unsupported value types. Never silently clamp an overflowing matrix component.

- [ ] **Step 2: Run the focused tests and confirm the missing compiler failure**

```powershell
python -m unittest mod-tools.tests.test_flatomo -v
```

Expected: fail because `wf_flatomo` and its typed IR/validators do not exist.

- [ ] **Step 3: Define a readable, typed effect IR**

Expose immutable types for texture regions, images, graphics, matrices, part nodes, keyframes, sequences, sounds and markers, plus:

```python
def quantize_q12(value: Decimal) -> int: ...
def compile_parts(effect: EffectIR) -> OrderedDict: ...
def compile_timeline(effect: EffectIR) -> OrderedDict: ...
def encode_raw_deflate(tree: OrderedDict) -> bytes: ...
def validate_effect(effect: EffectIR) -> list[str]: ...
```

Parts fields must match client keys `s,a,o,f,t,c,i`. Timeline uses `sequences,sounds,points,circles,rectangles,matrices`; preserve integer versus double types exactly.

- [ ] **Step 4: Add the real CN fixture hard gate**

Require an explicit CN store or `WF_BASELINE_APK`; release verification must fail when the fixture is unavailable rather than skip it. Use:

```text
scene/general/animation/effect_long_touch.parts.amf3.deflate
raw sha256 4407b6d56e19f7c7749f5b54261fd53dec5573f05eb719f87321f4fc55d51406
top keys i,g,m,a,o,t,c,s

scene/general/animation/effect_long_touch.timeline.amf3.deflate
raw sha256 b18f84c4f8936f3c9189b664400a82dd8a4f9fb365336bb35914a991d1f7b6f7
top keys sequences,sounds,points,circles,rectangles,matrices
```

Assert decode→encode→decode preserves the full normalized tree, top-level and nested key order, every scalar type, array order and all logical reference targets. Byte equality may be reported as a diagnostic but is not a release gate because a semantically equivalent AMF3 encoder may rebuild reference tables differently. Assert fixture sequence `neutral` is begin `1`, end `13`, loop.

- [ ] **Step 5: Compile a minimal synthetic effect and read it back**

Build one texture, one part, two matrices, a 12-tick loop and one sound cue. Unit tests must decode the emitted raw-deflate AMF3 and compare the entire normalized tree to expected IR.

- [ ] **Step 6: Create and install only a disposable golden effect**

Build a fixed no-damage canary variant of character `129999` with temporary skill key/program `seris_dragon_king_flatomo_canary`. Its ActionDsl contains one `ShowEffect` command whose effect selector is `SpecifyEffectDirectly("battle/effect/skill_unique/seris_flatomo_canary/seris_flatomo_canary_loop")`, label is `seris_flatomo_probe`, anchor is `ForesideOfCharacter`, lifetime is `UntilTargetTerminates`, and hit-area lifetime is 60 ticks; a final `HideEffectFromOwner("seris_flatomo_probe")` cleans it up. It must contain no attack or condition command.

The effect's `neutral` sequence is a 12-tick loop with four visibly different ring quadrants at ticks 1, 4, 7 and 10, plus one original short cue at tick 3 using logical path `sound_effect/unique/se_flatomo_canary_tick` without extension. Expected repeats are ring start at ticks 1/13/25/37/49 and cue at ticks 3/15/27/39/51; the effect is absent after the 60-tick owner ends.

Use only the manifest-driven disposable MuMu target, never the production active release:

```powershell
python mod-tools/wf_seris_pack.py flatomo-canary build --profile cn --output work/character_packs/seris_dragon_king/canary/flatomo
python mod-tools/wf_seris_pack.py flatomo-canary install --package-dir work/character_packs/seris_dragon_king/canary/flatomo --device-config work/character_packs/seris_dragon_king/qa/device.json
python mod-tools/wf_seris_pack.py flatomo-canary verify --package-dir work/character_packs/seris_dragon_king/canary/flatomo --video work/character_packs/seris_dragon_king/qa/flatomo-golden.mp4
python mod-tools/wf_seris_pack.py flatomo-canary rollback --snapshot work/character_packs/seris_dragon_king/canary/flatomo/snapshot.json --device-config work/character_packs/seris_dragon_king/qa/device.json
```

`install` shows its complete direct-sync manifest before confirmation and never touches `sync_pending.json`; `rollback` verifies original hashes and restarts the game. Record compiler/build/store/APK hashes, tick observations and video hash in `qa/flatomo-golden.json`.

- [ ] **Step 7: Enforce the gate before Seris effect compilation**

Declare exact final effects:

| Key | Ticks | Loop |
|---|---:|---|
| `human_start` | 72 | no |
| `transform` | 60 | no |
| `dragon_loop` | 120 | yes |
| `dragon_attack` | 96 | no |
| `dragon_end` | 48 | no |

Use stable root `battle/effect/skill_unique/seris_dragon_king/`. `wf_seris_pack.py` must refuse to compile these five effects until the official fixture and current golden-effect evidence both pass.

- [ ] **Step 8: Run tests and commit**

```powershell
python -m unittest discover -s mod-tools/tests -p "test_flatomo.py" -v
python -m unittest mod-tools.tests.test_seris_pack.TestSerisEffectGate -v
git add -- mod-tools/wf_flatomo.py mod-tools/characters/seris_dragon_king/effects.json mod-tools/tests/test_flatomo.py mod-tools/wf_dsl.py mod-tools/wf_seris_pack.py
git commit -m "feat(mod-tools): compile original Flatomo effects"
```

---

### Task 9: Generic `dual_form_v1` AS3 presentation and continuation patch

**Files:**
- Create: `client-patch/dual-form-v1/patch-manifest.json`
- Create: `client-patch/dual-form-v1/as3/pinball/common/data/character/BattleCharacterLogic.as`
- Create: `client-patch/dual-form-v1/as3/pinball/common/data/battle/squadMember/CharacterBaseImpl.as`
- Create: `client-patch/dual-form-v1/as3/pinball/common/data/battle/restore/BattleContinuationData.as`
- Create: `client-patch/dual-form-v1/as3/pinball/scene/battle/battle/squad/SquadManagerImpl.as`
- Create: `client-patch/dual-form-v1/as3/pinball/scene/battle/battle/squad/SquadImpl.as`
- Create: `client-patch/dual-form-v1/as3/pinball/scene/battle/battle/squad/member/MemberImpl.as`
- Create: `client-patch/dual-form-v1/as3/pinball/scene/battle/battle/squad/member/MemberPeek.as`
- Create: `client-patch/dual-form-v1/as3/pinball/scene/battle/battle/squad/member/MemberView.as`
- Create: `client-patch/dual-form-v1/as3/pinball/scene/battle/battle/squad/member/DualFormPresentationController.as`
- Create: `client-patch/dual-form-v1/as3/pinball/scene/battle/battle/squad/member/DualFormState.as`
- Create: `client-patch/dual-form-v1/as3/pinball/config/core/DevConfig.as`
- Create: `client-patch/dual-form-v1/as3/pinball/config/core/DualFormRuntimeMarker.as`
- Create: `client-patch/dual-form-v1/patch_dual_form.py`
- Create: `client-patch/dual-form-v1/verify_dual_form.py`
- Create: `client-patch/tests/test_dual_form_patch.py`
- Create: `client-patch/tests/test_dual_form_pcode.py`

- [ ] **Step 1: Freeze the baseline anchors and write failing patch tests**

For every modified class, assert one exact baseline anchor, idempotent second application, and hard failure on zero or multiple anchors. Use a fixture exported from the explicitly selected baseline APK; never pick the first APK in a directory.

- [ ] **Step 2: Run the focused tests and confirm the unimplemented patch failure**

```powershell
python -m unittest discover -s client-patch/tests -p "test_dual_form_patch.py" -v
```

Expected: fail because the patch manifest/classes and four-playhead/continuation hooks do not exist. A missing baseline fixture is a distinct hard error, not a skipped pass.

- [ ] **Step 3: Add generic capability detection and path derivation**

The controller supports a member only when: its character has tag `ModDualForm`, source is `CalculatedBattleCharacterLogic`, native switching is `ConditionExist`, and deletional kind resolves to `DCUnique`. Derive matched pixel, special, cut-in, loop and end paths from the runtime code name; do not store a Seris ID/code/Unique constant in AS3. For HpHigh, MultiballNumber, ChangeSkillFlag and IsUnison switching, log one “unsupported by dual_form_v1” diagnostic per character and keep standard pixels while leaving native skill switching untouched.

- [ ] **Step 4: Preload every optional matched resource before battle**

Extend `BattleCharacterLogic.resolvePathCollection()` to collect standard assets plus:

```text
character/{code_name}/pixelart_matched/pixelart
character/{code_name}/pixelart_matched/special
character/{code_name}/ui/skill_cutin_matched_{evolution}
battle/effect/skill_unique/{code_name}/{code_name}_dragon_loop
battle/effect/skill_unique/{code_name}/{code_name}_dragon_end
```

Asset decode/load must complete before member creation. Missing optional resources are recorded once and keep standard human visuals; they never alter condition or skill selection.

- [ ] **Step 5: Implement the five-state presentation controller**

Implement `Human → TransformIn → Dragon`, `Dragon → TransformOutPending` while a dragon skill is busy, and `Dragon/TransformOutPending → TransformOut → Human` once idle. Sample `MemberImpl.resolveConditionalKind()` immediately after `conditionSlot.update`; do not calculate a duration. `form_in`/`form_out` play once per true edge, missing sequences cut directly, and semantic action falls back to same-form `neutral` when absent. `TransformOutPending` delays only pixels/effects: Unique-gated ATK/skill-damage bonuses disappear immediately through the native condition result.

- [ ] **Step 6: Bind four animations in `MemberView` and preserve view state**

Construct four playheads up front: human standard, human special, dragon standard and dragon special. `form_in` runs on human special, `matched_skill` and `form_out` run on dragon special; completion returns to the appropriate standard semantic action. Switching must preserve world position, rotation, scale, color transform, alpha, visibility, collision semantics, `unit_body` and `hp_gauge` anchors. Draw only the selected playhead. Dispose all four playheads, loop/end effects and listeners. Death forces human before `into_coffin`; ghost/revive remain human.

The v1 patch changes only the in-field member animation and skill cut-in; persistent HUD, party, roster and status portraits keep their native base/evolution image behavior.

- [ ] **Step 7: Lock cut-in and skill presentation at cast start**

In `SquadManagerImpl.invokeActionSkill`, use the already resolved matched boolean when choosing `skill_cutin_matched_{evolution}` and start dragon-special `matched_skill` when the visible main caster is matched. On missing matched cut-in, use the standard `skill_cutin_0/1` at the same evolution index. Compute unison matched cut-in before double-cutin construction, but never replace the visible main member's pixel for a sub/unison caster. A dragon skill that outlives Unique completes its selected DSL/cut-in and only delays visual exit.

- [ ] **Step 8: Add minimal continuation payload for the actual switching Unique**

`BattleContinuationData.next()` must capture only the condition selected by the generic switching predicate:

```text
member index
source slot: member or squad
condition map key
id, _originalTimeLimit, restFlipLimit, restPowerFlipLimit, restEndPowerFlipLimit
endPowerFlipAcceptedLevels, maxAccumulation
content tag/index/params (including the runtime Unique ID)
cancelable, isEternal, statsBattleId, originMemberIndex, shouldCountForMission
isFromHostile, extensionId, magnificationFromPrimary, magnificationFromOther
linkedTrialId, discriminationKey, isQuestInitial, consumedCount
remainingFrames = addedTime + timeLimit - currentFrame
```

Reject a target with non-null `hitCountCheck` rather than serializing a wider subsystem. Restore member-slot data in `MemberImpl.setContinuationData()` and squad-slot data exactly once in `SquadImpl.setContinuationData()`. Reconstruct the native `Condition`, set `addedTime` to that slot's restored frame count, set `timeLimit` to captured remaining frames, restore `consumedCount`, then insert with `ConditionSlot.setCondition()` plus `addRefreshCount()`. Do not call `applyConditionChange()`, `copyFrom()` or `addFrom()`. A remaining value `< 0` is not inserted; `0` is inserted and remains valid for the native boundary frame. P-code assertions plus Task-10 instrumentation must prove no condition-change handler or ability event is emitted; call avoidance alone is not acceptance proof.

- [ ] **Step 9: Make zone restoration visually edge-free**

Restored active Unique builds the first view frame directly as `Dragon`, without `form_in`; restored expired/missing Unique builds `Human`. The controller still reads the restored native condition and owns no restoration timer.

- [ ] **Step 10: Wire an executed runtime marker**

Patch the baseline startup path in `pinball/config/core/DevConfig.as` to call `DualFormRuntimeMarker.emit()` exactly once. The marker includes patch version and immutable build ID; `wf_client_base.py` independently hashes the installed main SWF. P-code tests must prove the startup caller reaches the marker, not merely that the marker class exists.

- [ ] **Step 11: Add source and exported P-code assertions**

Tests must cover no tag, each unsupported switching kind, malformed switching, missing matched pixel/special/cut-in/effect independently, four-playhead routing, single entry/exit, expiry while idle/busy, zone restore, remaining `1/0/-1`, death/revive, unison visibility and dispose cleanup. P-code verification must find the actual branches/calls for `ModDualForm`, `DCUnique`, matched paths, `setCondition`, `addRefreshCount`, member-versus-squad restoration, special-playhead selection, cut-in selection and same-evolution fallback; source text or an FFDec success exit alone is insufficient.

- [ ] **Step 12: Run patch tests and commit**

```powershell
python -m unittest discover -s client-patch/tests -p "test_dual_form_patch.py" -v
python -m unittest discover -s client-patch/tests -p "test_dual_form_pcode.py" -v
git add -- client-patch/dual-form-v1 client-patch/tests/test_dual_form_patch.py client-patch/tests/test_dual_form_pcode.py
git commit -m "feat(client): add generic dual-form presentation"
```

---

### Task 10: Reproducible APK build, capability verification, install, and rollback

**Files:**
- Create: `mod-tools/wf_client_base.py`
- Create: `mod-tools/tests/test_client_base.py`
- Create: `client-patch/dual-form-v1/README.md`
- Modify: `client-patch/dual-form-v1/patch-manifest.json`
- Runtime only: `work/character_packs/seris_dragon_king/qa/continuation-evidence.json`

- [ ] **Step 1: Write fail-closed tool and certificate tests**

Require explicit baseline APK, FFDec, zipalign, apksigner, signing keystore and MuMu config. Test refusal of ambiguous APKs, missing class export, mismatched baseline hash, altered final SWF, certificate mismatch, failed install, absent/stale runtime marker when one is expected, an unvalidated ADB serial and an unverified rollback package. Tests also cover an unpatched previous build whose correct expected marker state is absent.

- [ ] **Step 2: Run the focused tests and confirm the missing module failure**

```powershell
python -m unittest mod-tools.tests.test_client_base -v
```

Expected: fail because `wf_client_base` and its fail-closed build/install records do not exist.

- [ ] **Step 3: Implement build records and explicit tool discovery**

Expose:

```python
@dataclass(frozen=True)
class ClientBaseBuild:
    patch_version: str
    build_id: str
    baseline_apk_sha256: str
    output_apk_sha256: str
    main_swf_sha256: str
    certificate_sha256: str
    pcode_report_sha256: str
    capabilities: tuple[str, ...]

def build_client_base(config: ClientBaseConfig) -> ClientBaseBuild: ...
def install_client_base(build: ClientBaseBuild, device: DeviceTarget) -> InstallRecord: ...
def rollback_client_base(previous: ClientBaseBuild, device: DeviceTarget) -> InstallRecord: ...
```

Read MuMu's current `vm_config.json` for the ADB port, connect it, and bind all commands to the validated `DeviceTarget.serial`; do not hardcode 16384 or the presently observed 16416.

- [ ] **Step 4: Build the SWF and validate the final ABC/P-code**

Extract `assets/worldflipper_android_release.swf`, apply the idempotent AS3 patch, import scripts using FFDec `-importScript`, re-export target classes and inspect final ABC/P-code. Verify every manifest assertion against the SWF that will actually enter the APK, then hash it.

- [ ] **Step 5: Repack, align, sign, and compare certificates**

Replace only the APK main SWF, run zipalign, sign with the fixed project key, and run `apksigner verify --print-certs`. Compare the candidate certificate with the currently installed package before attempting replacement. The known baseline and prior patched APK have different certificate hashes, so a mismatch must stop and request user-directed backup/uninstall; never uninstall automatically.

- [ ] **Step 6: Cover-install and verify the installed artifact**

Use exactly:

```text
adb -s $env:WF_ADB_SERIAL install -r --no-incremental $env:WF_DUAL_FORM_APK
```

Only after success: force-stop, remove AIR `cache/app/`, clear the marker log tag or record a new time cursor, restart, read a marker newer than that cursor, pull/extract the installed APK, hash its main SWF, and require marker patch version/build ID plus SWF hash to match the build record before writing capability `dual_form_v1`.

- [ ] **Step 7: Implement verified same-certificate rollback**

Retain the previous verified APK and build record. If post-install marker/SWF verification fails, immediately attempt same-certificate cover-rollback to that previous build. If rollback verifies, report the candidate install as failed and restored; if rollback also fails, record that the device is changed but unverified, stop all later actions, and print both raw failures.

A deliberate rollback repeats certificate/SWF verification. When the previous build has no `dual_form_v1` capability, absence of the marker is expected after a clean log window; successful hash/certificate verification clears the stored capability instead of treating marker absence as failure.

- [ ] **Step 8: Run unit and dry build validation**

```powershell
python -m unittest mod-tools.tests.test_client_base -v
python mod-tools/wf_client_base.py inspect --apk $env:WF_BASELINE_APK --patch client-patch/dual-form-v1/patch-manifest.json
```

Expected: unit tests pass; inspect is read-only and prints baseline hash, certificate, tools, package name and intended output. Do not install in this step.

- [ ] **Step 9: Run the continuation and no-event device canary**

After a verified local install, use an instrumented gauge/condition-event trace to prove: member-slot and squad-slot restores happen at most once; remaining frames `1` and `0` restore exactly while `-1` does not insert; zone restore does not replay `form_in`; condition-change listeners and ability 6 receive zero restore events; matched pixel/effect rebuild adds no gauge; a later real expiry→cast edge still adds the next valid 30%. Hash the trace, P-code report, APK/SWF and data-canary inputs into `qa/continuation-evidence.json`. Any failure returns to Task 0/9 and blocks release-ready assembly.

- [ ] **Step 10: Commit client tooling and documentation**

```powershell
git add -- mod-tools/wf_client_base.py mod-tools/tests/test_client_base.py client-patch/dual-form-v1/README.md client-patch/dual-form-v1/patch-manifest.json
git commit -m "feat(mod-tools): build and verify dual-form client base"
```

---

### Task 11: Generate three identity-locked masters and all UI/ATF assets

**Files:**
- Create: `mod-tools/characters/seris_dragon_king/art-direction.md`
- Create: `mod-tools/wf_character_art.py`
- Create: `mod-tools/tests/test_character_art.py`
- Modify: `mod-tools/wf_seris_pack.py`
- Runtime only: `work/character_packs/seris_dragon_king/authoring/art/`
- Runtime only: `work/character_packs/seris_dragon_king/build/roots/medium/`
- Runtime only: `work/character_packs/seris_dragon_king/build/roots/android/`

- [ ] **Step 1: Write derivative and inventory tests before generating images**

Require three transparent approved masters (`human_base`, `human_evolved`, `dragon`), exactly 27 UI PNGs, four cut-in ATFs, one 48×48 Unique icon, correct dimensions/alpha, stable identity hashes in the build report, and no story/expression files.

The exact PNG inventory is:

```text
full_shot_1440_1920_0.png       full_shot_1440_1920_1.png
skill_cutin_0.png                skill_cutin_1.png
illustration_setting_sprite_sheet.png
square_0.png                     square_1.png
square_132_132_0.png             square_132_132_1.png
square_round_95_95_0.png         square_round_95_95_1.png
square_round_136_136_0.png       square_round_136_136_1.png
thumb_level_up_0.png             thumb_level_up_1.png
thumb_party_main_0.png           thumb_party_main_1.png
thumb_party_unison_0.png         thumb_party_unison_1.png
battle_control_board_0.png       battle_control_board_1.png
battle_member_status_0.png       battle_member_status_1.png
cutin_skill_chain_0.png          cutin_skill_chain_1.png
skill_cutin_matched_0.png        skill_cutin_matched_1.png
```

- [ ] **Step 2: Run the art tests and confirm derivative APIs are missing**

```powershell
python -m unittest mod-tools.tests.test_character_art -v
```

Expected: fail because `wf_character_art` and its identity, derivative, inventory and alpha validators do not exist yet. Run this before any image generation.

- [ ] **Step 3: Freeze art direction from the two supplied references**

Use these references through the image-generation skill:

```text
E:/sora——picture/OC/角色设计/狼骑士/赛瑞斯/ChatGPT Image 2026年6月3日 04_37_48.png
E:/sora——picture/OC/角色设计/狼骑士/赛瑞斯/ChatGPT Image 2026年6月7日 18_22_21.png
```

The invariant checklist requires silver-white scales/armor, cobalt/deep-blue mane and cloth, luminous blue eyes, regal masculine dragon identity, same horns/face/armor language across forms, transparent background, and no black wolf/canary/Kyle features.

- [ ] **Step 4: Generate and separately approve the three masters**

Generate the human base full-body, human evolved full-body and dragon full-body/cutin master. After each generation inspect face, eye color, horn topology, armor motifs, body plan, hand/claw count, tail/wing continuity and alpha edges. Reject the master rather than repairing identity through unrelated UI crops.

- [ ] **Step 5: Implement deterministic UI derivatives**

`wf_character_art.py` derives the approved human master pair into the 25 standard UI PNGs and derives the dragon master into:

```text
skill_cutin_matched_0.png
skill_cutin_matched_1.png
```

It rebuilds `illustration_setting_sprite_sheet.atlas.amf3.deflate` for `seris_dragon_king`, writes all normal/matched logical paths, and uses no separately generated faces for thumbnails.

For both full shots, regenerate and read back `generated/character_image`, `full_shot_image_attribute` and `generated/trimmed_image`; for all four normal/matched cut-ins, regenerate and read back `generated/trimmed_image`. Tests compare actual PNG width/height, non-transparent content bounds and trim canvas/offsets so an existing-but-misaligned image cannot pass.

- [ ] **Step 6: Build the Unique icon and four ATFs**

Create `battle/common/unique_condition/unique_seris_dragon_king.png` as a legible 48×48 blue-silver dragon-crown sigil. Encode:

```text
skill_cutin_0.atf.deflate
skill_cutin_1.atf.deflate
skill_cutin_matched_0.atf.deflate
skill_cutin_matched_1.atf.deflate
```

Decode each ATF back to RGBA and compare dimensions, alpha occupancy and perceptual error against its PNG source.

- [ ] **Step 7: Generate and inspect contact sheets**

Create one UI sheet showing all 27 outputs at native aspect and one PNG-versus-decoded-ATF sheet. Reject clipped ears/wings, distorted faces, opaque backgrounds, wrong cut-in form, donor atlas keys, or any black-wolf residue.

- [ ] **Step 8: Run tests and commit reproducible sources only**

```powershell
python -m unittest mod-tools.tests.test_character_art -v
python mod-tools/wf_seris_pack.py validate-art --work-root work/character_packs/seris_dragon_king
git add -- mod-tools/characters/seris_dragon_king/art-direction.md mod-tools/wf_character_art.py mod-tools/tests/test_character_art.py mod-tools/wf_seris_pack.py
git commit -m "feat(mod-tools): derive Seris character art"
```

Do not stage generated PNG/ATF files under `work/`.

---

### Task 12: Author and compile both fully original pixel forms

**Files:**
- Modify: `mod-tools/characters/seris_dragon_king/pixel-sequences.json`
- Modify: `mod-tools/wf_pixelart.py`
- Modify: `mod-tools/tests/test_pixelart.py`
- Modify: `mod-tools/wf_seris_pack.py`
- Runtime only: `work/character_packs/seris_dragon_king/authoring/pixel/`
- Runtime only: `work/character_packs/seris_dragon_king/build/roots/common/character/seris_dragon_king/`

- [ ] **Step 1: Build a new two-form pose rig from the approved masters**

Create original human and dragon part guides with named pivots for torso, head, limbs, tail, mane/cape and wings. Do not trace or recolor an existing character's atlas, frames, silhouette or motion curves. Keep a common 256×256 stage and the shared `unit_body`/`hp_gauge` anchors.

- [ ] **Step 2: Author every declared frame and clean it at native resolution**

Produce all frames in Task 7's exact inventory. Human `form_in` must visibly transition silver dragon-man into the winged dragon without swapping to a black silhouette; dragon `matched_skill` must stage water rise, wing brace, thunder breath and recovery; `form_out` reverses identity cleanly. Check every frame for blue eyes, silver-white body, cobalt accents, stable volume and unbroken limbs/wings/tail.

- [ ] **Step 3: Bake the custom motion into client frame/timeline data**

Use the new compiler to emit exactly 16 files: eight under `pixelart/`, eight under `pixelart_matched/`. Standard and special timelines use the declared inclusive ticks; no runtime resampling or smoothing is allowed.

- [ ] **Step 4: Verify semantics and fallback compatibility**

Assert human has nine standard sequences plus `form_in`; dragon has five standard sequences plus `matched_skill` and `form_out`. Confirm common-name actions keep their semantic phase when switching, missing actions fall back to same-form `neutral`, and human death/ghost/revive sequences remain available after a dragon death.

- [ ] **Step 5: Inspect frame-by-frame previews**

Review contact sheets and animations at 1× and integer nearest-neighbor zoom. Reject black/opaque backgrounds, empty frames, anchor jumps, mixed identities, accidental donor pixels, excessive subpixel shimmer, cut wings/tail, or sequence-end pops.

- [ ] **Step 6: Run compiler/readback tests and commit declarations**

```powershell
python -m unittest mod-tools.tests.test_pixelart -v
python mod-tools/wf_seris_pack.py validate-pixel --work-root work/character_packs/seris_dragon_king
git add -- mod-tools/characters/seris_dragon_king/pixel-sequences.json mod-tools/wf_pixelart.py mod-tools/tests/test_pixelart.py mod-tools/wf_seris_pack.py
git commit -m "feat(mod-tools): author Seris dual-form pixel motion"
```

Do not stage generated pixel binaries under `work/`.

---

### Task 13: Author five Flatomo effects and six original SFX

**Files:**
- Modify: `mod-tools/characters/seris_dragon_king/effects.json`
- Modify: `mod-tools/wf_flatomo.py`
- Modify: `mod-tools/wf_audio.py`
- Modify: `mod-tools/wf_seris_pack.py`
- Modify: `mod-tools/tests/test_flatomo.py`
- Modify: `mod-tools/tests/test_audio.py`
- Runtime only: `work/character_packs/seris_dragon_king/authoring/effects/`
- Runtime only: `work/character_packs/seris_dragon_king/authoring/audio/sfx/`

- [ ] **Step 1: Require current compiler-gate evidence**

Before authoring, rerun the official fixture test and validate `qa/flatomo-golden.json` against the current compiler hash. Any compiler change invalidates the golden evidence and requires the disposable effect to be replayed on device.

- [ ] **Step 2: Author the five effects from a shared blue-silver texture atlas**

Create these distinct visual sequences under `battle/effect/skill_unique/seris_dragon_king/`:

- `human_start`: concentric sea sigils with six water-hit markers followed by four thunder-hit markers, 72 ticks;
- `transform`: royal seal fracture, cobalt lightning and dragon silhouette reveal, 60 ticks;
- `dragon_loop`: restrained wing/scale current aura, seamless 120-tick loop;
- `dragon_attack`: five tidal impacts followed by five blue-thunder impacts and final breath, 96 ticks;
- `dragon_end`: lightning collapse and sea mist withdrawal, 48 ticks.

Keep hit readability aligned with the ActionDsl order; visuals must not imply a damage element different from the explicit command element.

- [ ] **Step 3: Compile and validate the common effect files**

With one shared texture, emit at least 12 files: one PNG, one atlas, five parts and five timelines. Validate every image/part/matrix reference, texture bound, sequence range, marker, sound cue and loop. Read back all emitted AMF3 and compare normalized trees.

- [ ] **Step 4: Create six original SFX**

Produce exactly:

```text
se_seris_water_rise.mp3
se_seris_thunder_crack.mp3
se_seris_transform.mp3
se_seris_dragon_roar.mp3
se_seris_dragon_breath.mp3
se_seris_form_end.mp3
```

Store them under common-root logical directory `sound_effect/unique/`. Encode at 44.1 kHz, mono, 96 kbps CBR, true peak ≤ -1 dBTP. The single `se_seris_thunder_crack.mp3` is referenced by both `human_start` and `dragon_attack`; do not duplicate the file under a second name.

- [ ] **Step 5: Bind effects and sounds to the correct owners**

Human ActionDsl triggers `human_start` then `transform`; dragon ActionDsl triggers `dragon_attack`; the presentation controller alone starts/stops `dragon_loop` and triggers `dragon_end` on a real exit edge. Every timeline sound path omits `.mp3` and must match this exact contract:

| Logical sound path | Effect | Begin | End | Loop | Volume |
|---|---|---:|---:|---|---:|
| `sound_effect/unique/se_seris_water_rise` | `human_start` | 12 | 71 | false | 0.85 |
| `sound_effect/unique/se_seris_thunder_crack` | `human_start` | 54 | 71 | false | 0.90 |
| `sound_effect/unique/se_seris_transform` | `transform` | 8 | 59 | false | 0.90 |
| `sound_effect/unique/se_seris_dragon_roar` | `transform` | 42 | 59 | false | 0.82 |
| `sound_effect/unique/se_seris_dragon_breath` | `dragon_attack` | 18 | 95 | false | 0.95 |
| `sound_effect/unique/se_seris_thunder_crack` | `dragon_attack` | 72 | 95 | false | 0.90 |
| `sound_effect/unique/se_seris_form_end` | `dragon_end` | 6 | 47 | false | 0.75 |

Tests assert all seven references, ranges, loop flags and volumes, and also assert `dragon_loop` has no stale one-shot sound after release.

- [ ] **Step 6: Inspect combined timing on device without publishing the final character**

Use a reversible visual canary to confirm effect tick duration, water→thunder ordering, loop cleanup, transform synchronization and no residual effect after death/zone/dispose. Record video and hashes, then roll the canary back.

- [ ] **Step 7: Run validation and commit source declarations**

```powershell
python -m unittest mod-tools.tests.test_flatomo mod-tools.tests.test_audio -v
python mod-tools/wf_seris_pack.py validate-effects --work-root work/character_packs/seris_dragon_king
git add -- mod-tools/characters/seris_dragon_king/effects.json mod-tools/wf_flatomo.py mod-tools/wf_audio.py mod-tools/wf_seris_pack.py mod-tools/tests/test_flatomo.py mod-tools/tests/test_audio.py
git commit -m "feat(mod-tools): author Seris battle effects"
```

---

### Task 14: Generate, direct, and master 22 Japanese game voices

**Files:**
- Create: `mod-tools/wf_voice.py`
- Modify: `mod-tools/wf_audio.py`
- Modify: `mod-tools/characters/seris_dragon_king/voice-lines.json`
- Modify: `mod-tools/tests/test_audio.py`
- Modify: `mod-tools/tests/test_seris_pack.py`
- Runtime only: `work/character_packs/seris_dragon_king/authoring/audio/voice/`
- Runtime only: `work/character_packs/seris_dragon_king/build/roots/common/character/seris_dragon_king/voice/`

- [ ] **Step 1: Write synthesis-adapter and line-completeness tests**

Define a provider boundary that accepts Japanese text, delivery direction, form and destination WAV. Tests use a fake adapter and require one synthesis request per manifest row, no shell interpolation, retry records by line ID, deterministic output paths and refusal to overwrite an approved take without `--replace-take`.

- [ ] **Step 2: Implement a credential-external synthesis CLI**

Expose:

```python
class VoiceSynthesisAdapter(Protocol):
    def synthesize(self, text_ja: str, direction: VoiceDirection,
                   destination_wav: Path) -> SynthesisRecord: ...

def synthesize_manifest(manifest: Path, adapter: VoiceSynthesisAdapter,
                        output_root: Path) -> list[SynthesisRecord]: ...
```

Provide an OpenAI Audio API adapter whose model and voice are required runtime config fields and whose API key is read only from the environment. At implementation time, verify the current official endpoint/model contract before coding the adapter. Store engine/model/voice/request ID in private QA metadata, never the API key. Also support `--engine command` with an argument-array config for an approved local synthesizer; never execute a shell-formatted string.

If no authorized engine configuration is available, stop this task rather than creating silence or substitute files. The QA metadata must cite the engine/voice project's license or commercial-use grant applicable to this build.

- [ ] **Step 3: Generate the human identity takes**

Generate six Home, Join, Evolution, battle start, power flip, outhole, normal skill, win and ready lines as a restrained, ancient, calm male middle-low register with apparent age 35–45. Keep Japanese game timing concise and preserve every approved Japanese line exactly.

Force the approved skill readings in the synthesis request and validation record:

```text
蒼海雷獄・龍王顕現 = そうかいらいごく・りゅうおうけんげん
天穹万潮・王龍雷息 = てんきゅうばんちょう・おうりゅうらいそく
```

- [ ] **Step 4: Generate the dragon identity takes separately**

Generate `matched_skill_ready`, `matched_skill_0` and `matched_skill_1` as the same speaker identity performed with stronger chest resonance, a slight formant lowering and a short low roar tail. Do not derive them by a crude pitch shift and do not imitate a named real actor.

- [ ] **Step 5: Select takes and perform deterministic mastering**

For each line, inspect pronunciation, mora timing, clipping, breaths, identity continuity and emotional direction. Normalize the selected source through `wf_audio.py` to 44.1 kHz mono MP3 96 kbps CBR, about -16 LUFS, true peak ≤ -1 dBTP. Run full-frame decode validation and preserve selected-take hashes.

- [ ] **Step 6: Validate the exact 22-file inventory**

Require eight non-battle paths from `character_speech` and these 14 combat paths:

```text
battle/battle_start_0.mp3  battle/battle_start_1.mp3
battle/power_flip_0.mp3    battle/power_flip_1.mp3
battle/outhole_0.mp3       battle/outhole_1.mp3
battle/skill_ready.mp3     battle/skill_0.mp3     battle/skill_1.mp3
battle/matched_skill_ready.mp3
battle/matched_skill_0.mp3 battle/matched_skill_1.mp3
battle/win_0.mp3           battle/win_1.mp3
```

Reject extra login/story/`words`/expression audio and reject any speech row whose path includes `.mp3`.

- [ ] **Step 7: Perform in-game voice routing QA**

Check base/evolved human ready/skill, dragon matched ready/skill, Join, Evolution and all Home rows. Ensure skill-start routing is locked with the chosen form and a mid-skill Unique expiry does not switch the playing voice.

- [ ] **Step 8: Run tests and commit generation code/line manifest**

```powershell
python -m unittest mod-tools.tests.test_audio mod-tools.tests.test_seris_pack.TestSerisVoiceContract -v
python mod-tools/wf_seris_pack.py validate-voice --work-root work/character_packs/seris_dragon_king
git add -- mod-tools/wf_voice.py mod-tools/wf_audio.py mod-tools/characters/seris_dragon_king/voice-lines.json mod-tools/tests/test_audio.py mod-tools/tests/test_seris_pack.py
git commit -m "feat(mod-tools): generate Seris Japanese voices"
```

Do not commit source WAVs, final MP3s, API metadata or credentials.

---

### Task 15: Assemble and fully validate the release-ready Seris character pack

**Files:**
- Modify: `mod-tools/wf_seris_pack.py`
- Modify: `mod-tools/wf_character_pack.py`
- Modify: `mod-tools/tests/test_seris_pack.py`
- Modify: `mod-tools/tests/test_character_pack.py`
- Runtime only: `work/character_packs/seris_dragon_king/package/manifest.json`
- Runtime only: `work/character_packs/seris_dragon_king/package/qa/`

- [ ] **Step 1: Write failing full-inventory tests**

The package must contain and hash:

- server: exactly four JSON files;
- common: all required orderedmaps/ActionDsl, 22 voices, illustration atlas, Unique icon, 16 pixel files, at least 12 Flatomo files and six SFX;
- medium: exactly 27 UI PNGs;
- android: exactly four cut-in ATFs.

Require every manifest file to exist once in the correct root, and every staged file to be declared. Reject donor path/string/image references and any black-wolf/canary/Kyle identifiers in decoded tables, atlas trees, filenames or generated metadata.

For the 16 pixel files, assert the eight exact filenames from Task 7 appear once under `character/seris_dragon_king/pixelart/` and once under `character/seris_dragon_king/pixelart_matched/`; a `.parts.amf3.deflate` substitute is invalid.

- [ ] **Step 2: Run the focused inventory tests and confirm assembly is missing**

```powershell
python -m unittest mod-tools.tests.test_seris_pack.TestSerisFullPackInventory mod-tools.tests.test_character_pack.TestFullPackManifest -v
```

Expected: fail because clean assembly, complete root inventory and hard-gate manifest validation do not exist yet.

- [ ] **Step 3: Require all hard-gate evidence and base-capability status**

Release-ready assembly requires current mixed-element, ability-6 edge, continuation/no-event, official Flatomo fixture, golden effect, art, pixel, audio and client P-code reports. Record whether `dual_form_v1` is installed. A package lacking current continuation evidence is never release-ready. A separately labeled data-only package may be published only through an explicit degraded-data confirmation and must state “human/dragon skills and matched voice valid; pixel/cut-in stay human and cross-zone Unique persistence is not guaranteed”; it never satisfies this plan's final completion criteria.

- [ ] **Step 4: Assemble from an empty package directory**

```powershell
python mod-tools/wf_seris_pack.py build --profile cn --release-ready --clean --work-root work/character_packs/seris_dragon_king --output work/character_packs/seris_dragon_king/package
```

The command builds into a sibling temporary directory, reads back every table/AMF3/ATF/MP3, computes SHA-256/size, writes manifest and QA index, then atomically renames the completed directory. It must not touch live stores or CDN.

- [ ] **Step 5: Validate the manifest identity and dependency contract**

Require `package_id=seris_dragon_king`, character `129999`, code name, package version, `requires_client_base=dual_form_v1`, required capabilities, Unique/skill keys, generator version, reference provenance, four root lists, every hash, QA report hashes, snapshot ID and rollback package ID.

- [ ] **Step 6: Run dry-run against the live CN profile**

```powershell
python mod-tools/wf_seris_pack.py validate --package-dir work/character_packs/seris_dragon_king/package --profile cn
python mod-tools/wf_seris_pack.py preflight-live --package-dir work/character_packs/seris_dragon_king/package --profile cn --report work/character_packs/seris_dragon_king/qa/live-dry-run.json
```

Expected: no write, no collision, explicit table/file diff, root totals and capability state. Any live hash drift invalidates the prepared plan.

- [ ] **Step 7: Run the complete offline verification suite**

```powershell
python -m unittest discover -s mod-tools/tests -p "test_*.py" -v
python mod-tools/wf_selftest.py --sample 200
```

Expected: all tests pass and selftest reports no CN schema/round-trip failures.

- [ ] **Step 8: Commit assembly logic only**

```powershell
git add -- mod-tools/wf_seris_pack.py mod-tools/wf_character_pack.py mod-tools/tests/test_seris_pack.py mod-tools/tests/test_character_pack.py
git commit -m "feat(mod-tools): assemble Seris character package"
```

---

### Task 16: Atomic three-root release and server-visible active manifest

**Files:**
- Create: `mod-tools/wf_release.py`
- Create: `mod-tools/tests/test_release.py`
- Modify: `mod-tools/wf_publish.py`
- Create: `src/lib/cn-character-release.ts`
- Create: `src/tests/cn-character-release.test.ts`
- Modify: `src/routes/cn/asset.ts`
- Modify: `src/lib/version.ts`
- Runtime only: `.cdn/cn/character-releases/active.json`

- [ ] **Step 1: Write server scanner tests before changing runtime routes**

In a temporary CDN tree, test:

- legacy zip names continue to be scanned as before;
- any filename containing `-charpkg-` is invisible unless referenced by the active manifest;
- a release is visible only when common, medium and android archives all exist, sizes/hashes match and `from_version → version` is continuous;
- the first release `from_version` equals the canonical validated legacy/asset-patch tail, so a self-consistent but detached character chain is rejected;
- a missing/hash-bad archive hides that release and all descendants while retaining the longest valid prefix;
- every relative path is normalized, non-absolute, contains no `..` or backslash, and lands in the diff directory corresponding to its root;
- effective version and route diff output use the same validated chain;
- rollback is a new forward version containing reverse data, never a client downgrade.

- [ ] **Step 2: Run TypeScript compilation and confirm the missing release helper**

```powershell
npx tsc
```

Expected: fail because `src/lib/cn-character-release.ts` and its imports do not exist.

- [ ] **Step 3: Define the active release contract**

Use `.cdn/cn/character-releases/active.json`:

```typescript
interface ActiveCharacterReleaseManifest {
  schema_version: 1;
  base_version: string;
  releases: Array<{
    release_id: string;
    package_id: string;
    from_version: string;
    version: string;
    package_manifest_sha256: string;
    archives: Array<{
      root: "common" | "medium" | "android";
      relative_path: string;
      size: number;
      sha256: string;
    }>;
  }>;
}
```

Every release has exactly one archive per root, 64-lowercase-hex hashes, positive sizes, and filenames matching `pinball-{from_version}-{version}-{sequence}-charpkg-{package_id}-{release_id}-{root}.zip`. `base_version` must equal the validated non-character chain tail and the first release must start there.

The manifest keeps the full active history so clients at any supported `res_ver` retain a continuous diff chain.

- [ ] **Step 4: Implement a shared validated release reader**

Export from `cn-character-release.ts`:

```typescript
export function resolveCnCdnDir(): string;
export function readActiveCharacterReleases(
  cdnDir: string, canonicalBaseVersion: string
): ValidatedReleaseChain;
export function mergeLegacyAndCharacterDiffs(
  legacy: DiffGroup[], chain: ValidatedReleaseChain, baseUrl: string
): DiffGroup[];
export function maxCharacterReleaseVersion(
  cdnDir: string, canonicalBaseVersion: string
): string | null;
```

`asset.ts` and `version.ts` must call `resolveCnCdnDir()` and these helpers rather than independently resolving `.cdn/cn` or rescanning character zips. Both must honor absolute/relative `CDN_DIR` identically. Cache stamps include the active manifest and all three diff directories.

- [ ] **Step 5: Write Python transaction failure-injection tests**

Inject failure after each server JSON replacement, after each archive move, after temporary-manifest fsync but before replace, immediately after active-manifest replace, and during journal cleanup. Before `os.replace(active.json)` succeeds, recovery restores server JSON, deletes only unreferenced new zips, keeps the previous manifest byte-identical and releases the lock. Once replace succeeds, the release is committed: recovery completes journal/cleanup and never rewinds the manifest in place. Concurrent publisher tests must allow only one writer.

- [ ] **Step 6: Run the Python tests and confirm the missing publisher**

```powershell
python -m unittest mod-tools.tests.test_release -v
```

Expected: fail because `wf_release` and the commit/recovery state machine do not exist.

- [ ] **Step 7: Implement staging and the single visibility commit point**

`wf_release.py` must:

1. acquire a project release lock;
2. revalidate prepared live hashes and require the CN server to be offline for the current four static JSONs; if it is online, return `SERVER_RESTART_REQUIRED` without writing;
3. write all server JSON, common/medium/android payloads and three zips outside watched directories;
4. read back tables, verify every staged file/hash and inspect zip contents;
5. atomically replace the four server JSON files while the server is offline, so no process can observe a mixed four-file set;
6. move the three verified zips into their separate diff directories using `-charpkg-` names;
7. fsync the temporary manifest and atomically replace `active.json` last; this successful replace is the commit point;
8. write a completion journal, release the lock and return `server_restart_required=true`.

Until step 7, the server scanner must expose none of the new character archives. After commit, start the CN server and health-check its newly loaded JSON; a start failure leaves a committed release with the server offline and must be reported honestly, not silently rewound.

Root mapping tests are exact: common=`production/upload`, medium=`production/medium_upload`, android=`production/android_upload`, server=`assets/`.

- [ ] **Step 8: Implement forward-only rollback publication**

Rollback restores the package snapshot into new staging, creates a new version whose diffs reverse the character changes, and appends it to active history. It must not delete old archives or tell clients to reduce `res_ver`.

- [ ] **Step 9: Run Python, TypeScript, and typecheck verification**

```powershell
python -m unittest mod-tools.tests.test_release -v
npx tsc
node --test out/tests/cn-character-release.test.js
npm run typecheck
```

Expected: all tests, TypeScript compilation and typecheck pass; incomplete or detached character releases never appear in route output or effective version. Do not run `npm run build` in this branch because it writes the protected legacy `web/public/tailwind.css`.

- [ ] **Step 10: Commit the release chain**

```powershell
git add -- mod-tools/wf_release.py mod-tools/tests/test_release.py mod-tools/wf_publish.py src/lib/cn-character-release.ts src/tests/cn-character-release.test.ts src/routes/cn/asset.ts src/lib/version.ts
git commit -m "feat(cn): publish atomic character releases"
```

---

### Task 17: Add thin Mod GUI pages for client base and character packages

**Files:**
- Modify: `mod-tools/wf_gui.py`
- Modify: `mod-tools/wf_gui.html`
- Modify: `mod-tools/wf_assets.py`
- Create: `mod-tools/tests/test_gui_character_pack.py`

- [ ] **Step 1: Write adapter tests with all side effects mocked**

Test API handlers for status, validate, dry-run, build, stage, publish and rollback. Require raw errors and structured records to pass through unchanged; GUI handlers must not directly write stores, launch FFDec, invoke ADB or edit active manifests.

- [ ] **Step 2: Run the adapter test and confirm the endpoints are missing**

```powershell
python -m unittest mod-tools.tests.test_gui_character_pack -v
```

Expected: fail because the client-base/character-pack endpoints and side-effect-free adapters do not exist yet.

- [ ] **Step 3: Finish generic switching and Unique editors**

Add `condition_parameter: 11` to `_SWITCH_COLS`; validate that `ConditionExist` plus condition master kind `28` has a valid Unique ID. Support create/delete of the switched outer key and exact Unique flags `false,true,0,0,true`. Character snapshot/restore/delete may call package transactions but cannot be the package authority.

- [ ] **Step 4: Add the “客户端基座” page**

Display explicit baseline APK, patch version, target device/API, MuMu-discovered port, tool paths, certificate digest, build hash and installed runtime marker. Actions are inspect, build, P-code verify, local ADB cover-install and verified rollback. Label the install action “本机 ADB 安装”, never “服务端推送”. Certificate/install failure stops and shows raw output; no uninstall button is automated.

- [ ] **Step 5: Add the “角色包” page**

Display package ID/version, key conflicts, required capability, 27 UI/1 icon/4 ATF/16 pixel/5 effect/22 voice/6 SFX inventory, DSL hit table, per-sequence tick preview, QA gates and four-root diff. Actions are validate, dry-run, prepare isolated staging, publish and forward rollback, each with explicit confirmation and result record. “Prepare staging” cannot write production; “Publish” alone invokes the locked Task-16 transaction.

Before Publish, show whether every server JSON is hot-reloadable. For the current character/mana set, require the CN server to be stopped and label the result “restart required”; after activation, expose a health-check action and do not claim server data is live until a restarted process has loaded all four files.

- [ ] **Step 6: Make data-only degradation explicit**

When `dual_form_v1` is missing, default publish is blocked. The user may explicitly choose degraded data-only publication only after a warning that native human/dragon skills and matched voice work, in-battle pixel/cut-in remain human, and cross-zone Unique persistence is not guaranteed. The UI must never mark visual installation or full dual-form behavior complete in this state.

- [ ] **Step 7: Remove implicit use of the stale pending queue**

The new pages construct pending lists only from the current prepared package manifest. They show the generated list before any action and do not merge or reconstruct the unknown preexisting `sync_pending.json` state.

- [ ] **Step 8: Run adapter/UI contract tests**

```powershell
python -m unittest mod-tools.tests.test_gui_character_pack -v
python -m unittest discover -s mod-tools/tests -p "test_*.py" -v
```

Manually load the GUI and verify the two pages render, but do not press build/install/stage/publish during this test step.

- [ ] **Step 9: Commit the GUI adapters**

```powershell
git add -- mod-tools/wf_gui.py mod-tools/wf_gui.html mod-tools/wf_assets.py mod-tools/tests/test_gui_character_pack.py
git commit -m "feat(mod-tools): add character package workflow UI"
```

---

### Task 18: MuMu end-to-end validation, rollback proof, and handoff

**Files:**
- Create: `docs/mod-tools/seris-character-pack.md`
- Modify only if verification finds a defect: files owned by Tasks 1–17 and their focused tests
- Runtime only: `work/character_packs/seris_dragon_king/qa/final/`

- [ ] **Step 1: Re-establish a known device and release baseline**

Read the current installed package, certificate, APK/SWF hash, AIR cache state, server effective version and active release manifest. Treat the cleared `sync_pending.json` as unknown history; do not reconstruct it. Save this new baseline record before any device or live-store change.

- [ ] **Step 2: Run all offline verification from a clean process**

```powershell
python -m unittest discover -s mod-tools/tests -p "test_*.py" -v
python -m unittest discover -s client-patch/tests -p "test_dual_form_*.py" -v
python mod-tools/wf_selftest.py --sample 200
npm run typecheck
```

Expected: every command exits 0. Record exact pass counts and build hashes; do not summarize unrun checks as passing.

- [ ] **Step 3: Build and install the verified client base locally**

Build from `$env:WF_BASELINE_APK`, verify final P-code/ABC, zipalign, signature and certificate, then cover-install through the MuMu port discovered from config. Confirm runtime marker `dual_form_v1` and installed main-SWF hash. No server/CDN action may claim to install the base.

- [ ] **Step 4: Re-run both battle canaries on the final client/runtime**

The final source/data hashes must match the evidence. Repeat mixed-element resistance measurement, ability-2 first-hit timing and all ability-6 transition/restoration cases. Any failure stops publication and returns to the owning task/design review.

- [ ] **Step 5: Build, dry-run, and atomically publish the final package**

Start from an empty `work/character_packs/seris_dragon_king/package/` while preserving approved `authoring/` and `qa/`, rebuild all generated outputs, validate manifest, snapshot live values, materialize isolated staging, build and verify all three archives, stop the CN server and then invoke the single locked Task-16 activation. No production JSON/store write occurs before all three zips pass. After the active manifest commit, restart and health-check the CN server, then confirm the route exposes one complete three-root group and a continuous version chain.

- [ ] **Step 6: Grant and inspect the character in game**

Grant `129999` through mail, claim it, and inspect: name/title, water/Dragon/male/attack metadata, Lv100 stats, skill energy, leader, six abilities, base/evolved art, roster/detail/mana board/party UI and all eight `character_speech` routes.

- [ ] **Step 7: Execute the complete battle matrix**

Record evidence for:

1. human skill 6 water + 4 thunder hits, debuffs after hit 10, then one 1800-frame Unique;
2. dragon skill 5 water + 5 thunder hits, paralysis after hit 10, no Unique refresh;
3. exactly 1800 native frames and at least three complete human→dragon→human cycles;
4. ability 2 and 6 three-trigger limits and no zone/rebuild/restore duplication;
5. expiry while moving, outhole, colliding, mid-dragon-skill, dead, revived, zone-changing and battle-ending;
6. base/evolved matched cut-in, names, ready/skill voices and effects;
7. main versus unison casting, with no visible-main pixel swap for unison;
8. all human and dragon pixel sequences, no black wolf, black background, flash, empty frame or anchor jump;
9. missing matched pixel/cutin/effect fallback with identical gameplay result;
10. unpatched client gameplay/damage/matched voice compatibility with human visual fallback.

Also verify Unique 22 cannot be removed by ordinary cleanse, is not blocked by debuff resistance, is removed on death/encoffin, and is not restored by revive. In the mid-dragon-skill expiry case, capture numeric evidence that Unique-gated ATK/skill-damage bonuses disappear immediately while the already selected dragon DSL, voice and cut-in complete and only the pixel/effect exit waits for skill-idle.

- [ ] **Step 8: Prove both rollback paths**

First rollback the client base using the prior same-certificate APK and verify its certificate/SWF hash. If that prior APK is unpatched, require a clean-window absence of the marker and clear `dual_form_v1`; if it is patched, verify its recorded marker. Reinstall the final base. Then publish a new forward character rollback release, confirm server tables/assets return to the snapshot without reducing client `res_ver`, and finally republish the final package as another continuous release if acceptance requires it.

- [ ] **Step 9: Verify incremental-update behavior**

On a client with baseline data, supported `res_ver` and continuous chain, confirm only the new common/medium/android diffs download. State explicitly that new install, cleared data or broken chain is outside the no-full-redownload guarantee.

- [ ] **Step 10: Write the durable operator handoff**

Document package build, voice engine config, image/pixel/effect inputs, client-base build/install, canary evidence, transactional publish, GUI actions, live verification, data-only fallback, certificate mismatch handling, forward rollback and exact locations of QA records. Include no credentials or generated binary payloads.

- [ ] **Step 11: Run final scope and integrity checks**

```powershell
git diff --check
git status --short -- .gitignore mod-tools client-patch src docs/mod-tools docs/superpowers
git diff --name-only -- web/pages src/routes/web web/public
```

Expected: no whitespace errors; only planned source/test/docs paths are changed; the legacy admin command prints no paths; generated work/store/APK files are untracked only under ignored/runtime roots.

- [ ] **Step 12: Commit the handoff documentation**

```powershell
git add -- docs/mod-tools/seris-character-pack.md
git commit -m "docs(mod-tools): document Seris character workflow"
```

Record the final commit range, package manifest hash, client-base build ID, active release ID, rollback release IDs and all verification outputs in the handoff.
