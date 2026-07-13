# Abyss Gauntlet Arsenal, Mode Gate, and Shop Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Deliver 15 original, deliberately overpowered abyss weapons; make the weapon and same-ID ability-soul effects load only in Rush Event `700099`, Challenge Dungeon `2001`, and Practice `1`–`97`; and sell all 15 weapons through a native Rush Event exchange shop paid with item `2370099`.

**Architecture:** Keep CN master-data generation deterministic in `mod-tools`, enforce the quest whitelist at the single existing client ability-loading call site, and reuse the native `EVENT_ITEM` shop. Build and re-decompile the patched APK before allowing the powerful data release. Publish an explicit allowlist of table and image logical paths so unrelated global pending files and dirty-worktree changes cannot enter the diff package.

**Tech Stack:** Python 3 standard library, Pillow and existing `wf_*` helpers, CN orderedmap data, ActionScript 3, JPEXS FFDec, Android `zipalign`/`apksigner`, TypeScript/Fastify validation, MuMu ADB.

## Global Constraints

- Treat `D:\WF\wf-re-workspace\decompile\scripts` as the client-behavior authority. Read from it, but do not edit or commit it.
- Preserve all unrelated working-tree changes. Inspect and stage only explicit paths; never run `git add -A`, `git add .`, destructive reset/checkout, or a broad cleanup.
- Do not modify `web/pages/`, `src/routes/web/`, or `web/public/`. Do not stage `.cdn/`, `web/dist/`, `admin/node_modules/`, `out/`, orderedmap backups, or the local reverse-engineering directories.
- Use the resolved CN profile/store only. Do not fall back to Global data.
- Keep generated source and text files LF. Do not rewrite existing unrelated files mechanically.
- Weapon IDs are exactly `8000101`–`8000115`; shop item IDs are exactly `9700101`–`9700115`; token ID is `2370099`; Rush Event ID is `700099`.
- The only allowed runtime quest shapes are:
  - `QuestIdGroupKind.Single` plus `SingleQuestIdKind.RushEvent` index `17`, where `floor(questId / 1000) == 700099`.
  - `QuestIdGroupKind.Single` plus `SingleQuestIdKind.ChallengeDungeonEvent` index `8`, where `questId == 2001`.
  - `QuestIdGroupKind.Single` plus `SingleQuestIdKind.Practice` index `10`, where `1 <= questId <= 97`.
- Fail closed. `wf_rogue_rewards.py --publish` must refuse to invoke the publisher unless all generated data, all 15 PNGs, the signed APK hash, and the class re-exported from the compiled SWF pass validation.
- The source PNGs are 15 distinct `1024x1024` RGBA files with real transparency. Equipment rows reference paths without `.png`; stored and published logical paths include `.png`.
- Low and high strength endpoints are identical. Raw fixed-point strengths are `3_000_000` for `3000%`, `5_000_000` for `5000%`, and `1_000_000` for `1000%` or `100%` gauge.

Canonical weapon contract:

| ID | Name | Element/group | Image | Effects |
|---|---|---|---|---|
| `8000101` | 灰烬巨剑 | fire / `Red` | `fire_01` | attack `3_000_000`; power-flip `5_000_000` |
| `8000102` | 熔核法杖 | fire / `Red` | `fire_02` | skill damage `5_000_000`; starting gauge `1_000_000` |
| `8000103` | 深潮长枪 | water / `Blue` | `water_01` | attack `3_000_000`; direct damage `5_000_000` |
| `8000104` | 冻海战锚 | water / `Blue` | `water_02` | HP `1_000_000`; healing `1_000_000`; starting gauge `1_000_000` |
| `8000105` | 雷鸣双刃 | thunder / `Yellow` | `thunder_01` | attack `3_000_000`; direct damage `5_000_000` |
| `8000106` | 轰电战锤 | thunder / `Yellow` | `thunder_02` | skill damage `5_000_000`; starting gauge `1_000_000` |
| `8000107` | 裂空战镰 | wind / `Green` | `wind_01` | attack `3_000_000`; direct damage `5_000_000` |
| `8000108` | 苍岚长弓 | wind / `Green` | `wind_02` | skill damage `5_000_000`; starting gauge `1_000_000` |
| `8000109` | 晨星圣剑 | light / `White` | `light_01` | attack `3_000_000`; ability damage `5_000_000` |
| `8000110` | 辉环法器 | light / `White` | `light_02` | HP `1_000_000`; healing `1_000_000`; skill damage `3_000_000` |
| `8000111` | 蚀月大剑 | dark / `Black` | `dark_01` | attack `5_000_000`; skill damage `5_000_000` |
| `8000112` | 冥灯魔杖 | dark / `Black` | `dark_02` | ability damage `5_000_000`; starting gauge `1_000_000` |
| `8000113` | 深渊征服者 | universal / empty | `universal_01` | attack `3_000_000`; HP `1_000_000` |
| `8000114` | 深渊轮转核 | universal / empty | `universal_02` | skill damage `5_000_000`; starting gauge `1_000_000` |
| `8000115` | 深渊万象铳 | universal / empty | `universal_03` | direct, power-flip, and ability damage `3_000_000` each |

The ability-soul template notation in the approved design means the first CSV line of each listed key: attack `3020006`, HP `3040003`, starting gauge `3050010`, skill damage `4020013`, direct damage `5070035`, power-flip `5050009`, ability damage `5090029`, and healing `3010013`. Never clone the remaining lines from those keys.

---

## Task 1: Replace placeholder cloning with a canonical arsenal row builder

**Files:**

- Modify: `mod-tools/wf_rogue_rewards.py`
- Create: `mod-tools/tests/test_rogue_rewards.py`

- [ ] **Step 1: Write failing contract and row-generation tests**

Add tests that assert all IDs, names, donor IDs, element values, group tokens, image logical paths, and effects in the global contract. Build synthetic 123-column template rows so the test is independent of the real upload store.

```python
def template_row(effect_kind: str) -> list[str]:
    row = [""] * 123
    row[0], row[1], row[2] = "9", "9", "9"
    row[44], row[45], row[46] = effect_kind, "1", "Donor"
    row[48], row[49] = "100", "200"
    return row

class TestSoulGeneration(unittest.TestCase):
    def test_fire_greatsword_uses_only_requested_template_lines(self):
        leaf = rewards.build_soul_leaf(fake_templates(), rewards.WEAPONS[0])
        rows = core.read_csv_lines(leaf)
        self.assertEqual(2, len(rows))
        self.assertEqual(["32", "55"], [r[44] for r in rows])
        self.assertEqual(["5", "5"], [r[45] for r in rows])
        self.assertEqual(["Red", "Red"], [r[46] for r in rows])
        self.assertEqual(["3000000", "5000000"], [r[48] for r in rows])
        self.assertEqual([r[48] for r in rows], [r[49] for r in rows])
```

Also assert that equipment generation sets columns `c0`, `c1`, `c6`, `c7`, `c8=5`, `c9=true`, `c10=self ID`, and `c11=5`, and that `equipment_status` is a deep copy of the donor's complete level map.

- [ ] **Step 2: Run the focused test and confirm it fails**

Run:

```powershell
python -X utf8 mod-tools/tests/test_rogue_rewards.py -v
```

Expected: failure because `WEAPONS`, `build_soul_leaf`, and the deterministic builders do not yet exist.

- [ ] **Step 3: Define immutable weapon and effect specifications**

Replace `PLACEHOLDERS` with dataclasses and the exact 15-entry contract.

```python
@dataclass(frozen=True)
class EffectSpec:
    template_id: str
    effect_kind: str
    strength: int

@dataclass(frozen=True)
class WeaponSpec:
    id: str
    name: str
    donor: str
    element: int
    group: str
    image_slug: str
    effects: tuple[EffectSpec, ...]

MODE_DESCRIPTION = "【测试版·连战专属】仅在深渊连战、宝物域连战 2001 与木桩假人生效。"
IMAGE_PREFIX = "item/equipment/mod/abyss"
```

Keep the already selected donor sequence: `5010060`, `5020042`, `5010075`, `5020031`, `5010077`, `5020038`, `5010068`, `5020026`, `5017716`, `5020039`, `5010078`, `5020040`, `5010057`, `5020010`, `5090045`.

- [ ] **Step 4: Implement pure row builders**

Use `wf_mod_tool.read_csv_lines`, `write_csv_lines`, and `normalize_row_length`. For every effect, copy only `read_csv_lines(template_leaf)[0]`, normalize to 123 columns, and overwrite:

```python
row[0], row[1], row[2] = str(slot), "1", "0"
row[44] = effect.effect_kind
row[45] = "5"
row[46] = spec.group
row[48] = row[49] = str(effect.strength)
```

Use effect kinds `32`, `205`, `211`, `34`, `33`, `55`, `388`, and `195` exactly as fixed in the approved template mapping. Use `copy.deepcopy(status_table[spec.donor])` for base HP/ATK; do not synthesize or multiply status.

- [ ] **Step 5: Run the focused test**

Run:

```powershell
python -X utf8 mod-tools/tests/test_rogue_rewards.py -v
```

Expected: all contract, equipment-row, ability-soul-row, and equipment-status tests pass.

- [ ] **Step 6: Commit the row-builder slice**

```powershell
git add -- mod-tools/wf_rogue_rewards.py mod-tools/tests/test_rogue_rewards.py
git diff --cached --check
git commit -m "feat(mod): define abyss arsenal data"
```

---

## Task 2: Make reward writes deterministic, collision-safe, and server-complete

**Files:**

- Modify: `mod-tools/wf_rogue_rewards.py`
- Modify: `mod-tools/tests/test_rogue_rewards.py`
- Modify when materialized: `assets/equipment_max_level.json`
- Modify when materialized: `assets/equipment_element.json`
- Modify when materialized: `assets/equipment_lookup.json`
- Modify when materialized: `assets/equipment_ids.json`
- Modify when materialized: `assets/item_ids.json`

- [ ] **Step 1: Add failing idempotence, collision, and mirror tests**

Test the following in temporary dictionaries and temporary JSON files:

- A first run creates exactly 15 equipment keys, 15 status keys, and 15 soul keys.
- A second run produces byte-for-byte identical rows and JSON.
- A reserved equipment key whose row does not have `c0 == "mod_abyss_" + equipment ID` raises `ValueError` before any save.
- Existing recognized abyss placeholder rows may be replaced.
- `equipment_lookup` uses the canonical name, rarity string `"5"`, and the donor category.
- Element values are `[0,0,1,1,2,2,3,3,4,4,5,5,-1,-1,-1]`.
- `equipment_ids` and `item_ids` are sorted unique integer arrays.
- The item row for `2370099` is cloned from `2370007` and renamed `深渊代币`.
- `rush_event[700099]` column `c10` becomes `2370099` without touching the other columns.

- [ ] **Step 2: Run and observe the expected failures**

```powershell
python -X utf8 mod-tools/tests/test_rogue_rewards.py -v
```

Expected: failures for missing `equipment_status`, collision guards, sorted mirrors, and Rush token patching.

- [ ] **Step 3: Add the missing tables and pure apply functions**

Add these constants and functions:

```python
EQUIP_STATUS_T = "master/item/equipment_status.orderedmap"
RUSH_EVENT_T = "master/quest/event/rush_event.orderedmap"
EVENT_ID = "700099"

def assert_reserved_ownership(equipment: dict[str, object]) -> None: ...
def build_master_changes(tables: MasterTables) -> MasterChanges: ...
def apply_server_mirrors(mirrors: ServerMirrors) -> ServerMirrors: ...
def patch_rush_token(leaf: bytes | str) -> bytes | str: ...
```

Build every changed structure in memory and validate it before the first `q.save_table` or JSON write. Preserve bytes-versus-string leaf type. Do not accept an unknown occupant in the reserved range.

- [ ] **Step 4: Implement dry-run and write behavior**

The default invocation prints the full planned ID/name/effect/image summary and changes no files. `--write` saves:

1. `master/item/item.orderedmap`
2. `master/item/equipment.orderedmap`
3. `master/item/equipment_status.orderedmap`
4. `master/ability/ability_soul.orderedmap`
5. `master/quest/event/rush_event.orderedmap`
6. the five server mirror JSON files listed above

After each save, reload and assert the generated keys and Rush token field. If any readback differs, exit nonzero and do not offer publication.

- [ ] **Step 5: Add ability description readback**

Use `wf_describe.describe_rows(core.read_csv_lines(leaf), "ability_soul")` and print every generated weapon's descriptions. Tests should assert the raw columns, while the integration validator added in Task 8 will reject empty descriptions.

- [ ] **Step 6: Run tests and a real-store dry-run**

```powershell
python -X utf8 mod-tools/tests/test_rogue_rewards.py -v
python -X utf8 mod-tools/wf_rogue_rewards.py
```

Expected: tests pass; dry-run reports 15 weapons, token `2370099`, five client tables, and five server mirrors, with no write confirmation.

- [ ] **Step 7: Commit the deterministic writer**

```powershell
git add -- mod-tools/wf_rogue_rewards.py mod-tools/tests/test_rogue_rewards.py
git diff --cached --check
git commit -m "feat(mod): generate abyss equipment data"
```

Do not stage generated JSON in this task; Task 9 stages the reviewed materialized output separately.

---

## Task 3: Generate, validate, and install 15 original weapon PNGs

**Files:**

- Modify: `mod-tools/wf_rogue_rewards.py`
- Modify: `mod-tools/tests/test_rogue_rewards.py`
- Create: `mod-tools/assets/abyss-equipment/fire_01.png`
- Create: `mod-tools/assets/abyss-equipment/fire_02.png`
- Create: `mod-tools/assets/abyss-equipment/water_01.png`
- Create: `mod-tools/assets/abyss-equipment/water_02.png`
- Create: `mod-tools/assets/abyss-equipment/thunder_01.png`
- Create: `mod-tools/assets/abyss-equipment/thunder_02.png`
- Create: `mod-tools/assets/abyss-equipment/wind_01.png`
- Create: `mod-tools/assets/abyss-equipment/wind_02.png`
- Create: `mod-tools/assets/abyss-equipment/light_01.png`
- Create: `mod-tools/assets/abyss-equipment/light_02.png`
- Create: `mod-tools/assets/abyss-equipment/dark_01.png`
- Create: `mod-tools/assets/abyss-equipment/dark_02.png`
- Create: `mod-tools/assets/abyss-equipment/universal_01.png`
- Create: `mod-tools/assets/abyss-equipment/universal_02.png`
- Create: `mod-tools/assets/abyss-equipment/universal_03.png`

- [ ] **Step 1: Add failing asset validator/installer tests**

Use Pillow to create temporary fixtures. Assert rejection of wrong dimensions, RGB-without-alpha, fully opaque images, fully transparent images, edge-clipped visible bounds, duplicate SHA-256 content, missing source names, and non-PNG input. Assert that a valid RGBA source is written to `q.hashed_rel(logical + ".png")` after `wf_assets.png_encode`, and decode/readback retains its PNG bytes.

- [ ] **Step 2: Run the focused tests and confirm failure**

```powershell
python -X utf8 mod-tools/tests/test_rogue_rewards.py -v
```

Expected: failures for missing `validate_source_assets` and `install_source_assets`.

- [ ] **Step 3: Implement strict image validation and store installation**

Add:

```python
def validate_source_assets(asset_dir: Path, specs: tuple[WeaponSpec, ...]) -> dict[str, Path]: ...
def install_source_assets(store: Path, sources: dict[str, Path], specs: tuple[WeaponSpec, ...]) -> list[str]: ...
```

Validation requires real PNG signature, Pillow format `PNG`, size `(1024, 1024)`, mode `RGBA`, alpha minimum `0`, alpha maximum above `0`, a nontransparent bounding box with at least 24 pixels of margin on every edge, and 15 distinct SHA-256 values. Installation reads the source bytes unchanged, applies only `wf_assets.png_encode`, writes the hashed upload path, and returns the 15 hashed relative paths. Read the stored bytes back through `wf_assets.png_decode` and compare exactly to the source bytes.

- [ ] **Step 4: Generate the sources with the `imagegen` skill**

Generate one independent image per filename. Every prompt ends with: “single weapon centered, transparent background, no text, no letters, no character, no logo, original game equipment icon, strong readable silhouette, 1024x1024 RGBA.” Use these subjects:

| File | Prompt subject |
|---|---|
| `fire_01.png` | Massive obsidian greatsword split by a molten orange core, red-orange flame crest, broad asymmetric blade |
| `fire_02.png` | Slender volcanic mage staff with a floating magma sphere, forked black-metal crown, ember trails |
| `water_01.png` | Long blue-cyan abyssal lance with a tidal trident tip, transparent water fins, pearl core |
| `water_02.png` | Heavy frozen-sea battle anchor, cyan ice edge, dark navy chain ring, compact brutal silhouette |
| `thunder_01.png` | Paired short blades crossing around a violet-yellow lightning crystal, jagged conductive edges |
| `thunder_02.png` | Oversized thunder war hammer, square gold-violet coil head, bright electrical fractures |
| `wind_01.png` | Crescent wind scythe, green-cyan aerodynamic blade, hollow vortex hub, long swept handle |
| `wind_02.png` | Elegant longbow made of two floating green-cyan wing blades, taut luminous wind string |
| `light_01.png` | White-gold sacred longsword, radiant star-shaped guard, clean broad blade, soft prism highlights |
| `light_02.png` | Floating white-gold halo catalyst with concentric rings and a central sun crystal, no hand grip |
| `dark_01.png` | Black-purple eclipse greatsword, crescent void cutout, dense violet edge glow, imposing slab blade |
| `dark_02.png` | Black iron lantern staff containing a purple ghost flame, crooked crescent crown, long thin shaft |
| `universal_01.png` | Black-silver abyss conqueror poleblade, deep-purple core, angular crown-like guard, neutral element |
| `universal_02.png` | Floating black-silver rotation core made of nested mechanical rings, deep-purple singularity center |
| `universal_03.png` | Heavy black-silver abyss hand cannon, short wide barrel, restrained iridescent energy veins |

Visually inspect all 15 at original detail. Regenerate any image with visible background residue, accidental typography, duplicate silhouette, clipped edges, or a mismatched weapon type. Do not edit the generated artwork with Python.

- [ ] **Step 5: Validate and dry-run install**

```powershell
python -X utf8 mod-tools/wf_rogue_rewards.py --validate-assets
```

Expected: `15/15 valid`, exact dimensions/mode for each file, 15 distinct hashes, and the fixed logical path list.

- [ ] **Step 6: Run tests and commit source artwork plus installer**

```powershell
python -X utf8 mod-tools/tests/test_rogue_rewards.py -v
git add -- mod-tools/wf_rogue_rewards.py mod-tools/tests/test_rogue_rewards.py mod-tools/assets/abyss-equipment/fire_01.png mod-tools/assets/abyss-equipment/fire_02.png mod-tools/assets/abyss-equipment/water_01.png mod-tools/assets/abyss-equipment/water_02.png mod-tools/assets/abyss-equipment/thunder_01.png mod-tools/assets/abyss-equipment/thunder_02.png mod-tools/assets/abyss-equipment/wind_01.png mod-tools/assets/abyss-equipment/wind_02.png mod-tools/assets/abyss-equipment/light_01.png mod-tools/assets/abyss-equipment/light_02.png mod-tools/assets/abyss-equipment/dark_01.png mod-tools/assets/abyss-equipment/dark_02.png mod-tools/assets/abyss-equipment/universal_01.png mod-tools/assets/abyss-equipment/universal_02.png mod-tools/assets/abyss-equipment/universal_03.png
git diff --cached --check
git commit -m "feat(mod): add abyss equipment artwork"
```

---

## Task 4: Build the dedicated Rush Event exchange shop

**Files:**

- Create: `mod-tools/wf_rogue_shop.py`
- Create: `mod-tools/tests/test_rogue_shop.py`
- Modify when materialized: `assets/event_item_shop.json`
- Modify when materialized: `assets/event_item_shop_id_map.json`

- [ ] **Step 1: Write failing client/server shop tests**

Create a synthetic 51-column row for official template key `310200`. Assert:

- Client key `700099` is removed before generation.
- Keys `9700101`–`9700115` are present in ascending order and no other reserved keys are added.
- Every row has exactly 51 columns.
- `c0=6`, `c1=700099`, `c2=11`, `c8=shop ID`, `c9=1`, and `c10=1..15`.
- `c18=2370099`; `c19=10` for elemental weapons and `15` for universal weapons.
- `c26=2000-01-01 00:00:00`, `c27=2099-12-31 23:59:59`, `c28=0`, `c29=5`, `c30=5`, `c31=(None)`, `c32=4`, `c33=equipment ID`, `c34=1`.
- Server JSON is exactly `event_item_shop["11"]["700099"][shop_id]`, and ID-map entries are `{ "eventType": 11, "eventId": 700099 }`.
- Stale server entries under product key `700099` and stale `event_item_shop_id_map["700099"]` are removed.
- The total stock cost is `825`.
- Re-running the transformation is idempotent; foreign occupants in `9700101`–`9700115` fail before writes.

- [ ] **Step 2: Run the test and confirm import failure**

```powershell
python -X utf8 mod-tools/tests/test_rogue_shop.py -v
```

Expected: failure because `wf_rogue_shop.py` does not exist.

- [ ] **Step 3: Implement pure shop transformations**

```python
SHOP_T = "master/shop/event_item_shop.orderedmap"
SHOP_TEMPLATE = "310200"

def build_client_shop(table: dict[str, object], weapons: tuple[WeaponSpec, ...]) -> dict[str, object]: ...
def build_server_shop(shop: dict, id_map: dict, weapons: tuple[WeaponSpec, ...]) -> tuple[dict, dict]: ...
def validate_shop(client: dict, shop: dict, id_map: dict) -> list[str]: ...
```

Clone `310200`, normalize to 51 columns, overwrite every field listed above, and preserve only unrelated option sentinels from the official row. Set `c7` to the weapon name, `c11` to the mode-exclusive description, `c13` to the weapon image logical path, and `c14=5`.

Build each server product without carrying stale reward fields:

```python
{
    "costs": [{"id": 2370099, "amount": price}],
    "rewards": [{"type": 4, "id": int(spec.id), "count": 1}],
    "availableFrom": "2000-01-01 00:00:00",
    "availableUntil": "2099-12-31 23:59:59",
    "stock": 5,
}
```

- [ ] **Step 4: Add dry-run/write CLI and readback**

Default to dry-run. `--write` saves the client table through `q.save_table`, writes both server JSON files with deterministic numeric-key order, reloads all three outputs, and runs `validate_shop`. Do not publish from this script; publication is centralized behind Task 8's gate.

- [ ] **Step 5: Run tests and real-store dry-run**

```powershell
python -X utf8 mod-tools/tests/test_rogue_shop.py -v
python -X utf8 mod-tools/wf_rogue_shop.py
```

Expected: tests pass; dry-run reports 15 products, `12 * 10 * 5 + 3 * 15 * 5 = 825`, and removal of stale key `700099`.

- [ ] **Step 6: Commit the shop generator**

```powershell
git add -- mod-tools/wf_rogue_shop.py mod-tools/tests/test_rogue_shop.py
git diff --cached --check
git commit -m "feat(mod): add abyss event exchange shop"
```

---

## Task 5: Prevent Rush Event regeneration from restoring the old token

**Files:**

- Modify: `mod-tools/wf_rogue_build.py`
- Create: `mod-tools/tests/test_rogue_build.py`

- [ ] **Step 1: Add a failing regression test**

```python
class TestRushEventMetadata(unittest.TestCase):
    def test_abyss_event_always_uses_abyss_token(self):
        row = [""] * 18
        row[10] = "2370007"
        actual = rogue_build.patch_event_metadata(row)
        self.assertEqual("2370099", actual[10])
```

Also assert that the helper leaves every other column unchanged.

- [ ] **Step 2: Run and observe failure**

```powershell
python -X utf8 mod-tools/tests/test_rogue_build.py -v
```

Expected: missing `patch_event_metadata` or wrong token.

- [ ] **Step 3: Implement and use the helper**

Add `TOKEN_ID = "2370099"`, set `row[10] = TOKEN_ID`, and call the helper while building `rush_event[700099]`. Keep banner columns and all schedule columns untouched. This ensures a future normal `wf_rogue_build.py --write` run cannot regress the exchange currency.

- [ ] **Step 4: Run tests and commit**

```powershell
python -X utf8 mod-tools/tests/test_rogue_build.py -v
git add -- mod-tools/wf_rogue_build.py mod-tools/tests/test_rogue_build.py
git diff --cached --check
git commit -m "fix(mod): persist abyss rush token"
```

---

## Task 6: Add the fail-closed ActionScript quest gate

**Files:**

- Create: `client-patch/abyss-mode-equipment/patch.py`
- Create: `client-patch/abyss-mode-equipment/README.md`
- Create: `mod-tools/tests/test_abyss_mode_patch.py`

- [ ] **Step 1: Write failing whitelist and patcher tests**

The test imports `patch.py` by file path and checks this truth table through a pure helper `allowed_quest(group_index, single_index, quest_id)`:

```python
ALLOWED = [(0, 17, 700099001), (0, 17, 700099099), (0, 8, 2001), (0, 10, 1), (0, 10, 97)]
DENIED = [(1, 17, 700099001), (0, 17, 700098001), (0, 8, 2002), (0, 8, 2006),
          (0, 10, 0), (0, 10, 98), (0, 10, 1001), (0, 0, 110101),
          (0, 3, 1), (0, 11, 1)]
```

For text patching, assert one exact insertion, byte-identical second application, CRLF preservation, no change outside `getAvailableAbilities`, and a raised error with no output when the method or anchor count differs from one.

- [ ] **Step 2: Run and confirm import failure**

```powershell
python -X utf8 mod-tools/tests/test_abyss_mode_patch.py -v
```

Expected: failure because the patch module does not exist.

- [ ] **Step 3: Implement scoped, idempotent patching**

Limit search to the text from:

```actionscript
public function getAvailableAbilities(param1:BattlePartyLogic, param2:int, param3:QuestIdGroupKind, param4:Array) : BattleAbilitySource
```

through the next `public function getActionSkills`. Insert immediately after the one line:

```actionscript
_loc14_ = Boolean(_loc5_(_loc13_.questKind));
```

The injected block reuses existing `_loc12_:AbilitySoulAbilityLogic` and `_loc15_:int` locals, so it needs no import or new local declarations:

```actionscript
// WF_ABYSS_MODE_EQUIPMENT_GATE_V1_BEGIN
if(_loc13_ is AbilitySoulAbilityLogic)
{
   _loc12_ = _loc13_ as AbilitySoulAbilityLogic;
   if(_loc12_.id >= 8000101 && _loc12_.id <= 8000115)
   {
      _loc14_ = false;
      if(param3.index == 0)
      {
         _loc15_ = int(param3.params[0].params[0]);
         switch(param3.params[0].index)
         {
            case 8:
               _loc14_ = _loc15_ == 2001;
               break;
            case 10:
               _loc14_ = _loc15_ >= 1 && _loc15_ <= 97;
               break;
            case 17:
               _loc14_ = int(Math.floor(_loc15_ / 1000 + 1e-10)) == 700099;
         }
      }
   }
}
// WF_ABYSS_MODE_EQUIPMENT_GATE_V1_END
```

This override runs after the original quest-condition result, so reserved souls are false outside the whitelist while every non-reserved ability retains official behavior.

- [ ] **Step 4: Implement semantic verification**

`verify_text(text, require_markers)` checks one method, the ID bounds, `param3.index == 0`, the three inner indices, all ID bounds, and absence of a similar block in `getAvailableAbilitiesWithCond`. `require_markers=False` is used for FFDec re-export because source comments may not survive recompilation.

CLI:

```text
python patch.py --source SOURCE_AS --output PATCHED_AS
python patch.py --verify PATCHED_OR_REEXPORTED_AS
```

Write through a temporary sibling and `os.replace` only after verification. On any error, remove the temporary file and leave an existing output untouched.

- [ ] **Step 5: Document apply, verification, and rollback**

The README records the authoritative class, exact whitelist, source/output commands, FFDec class name `pinball.common.data.character.BattleCharacterLogic`, binary re-export verification, and rollback by reinstalling the prior signed APK. It explicitly warns that powerful data publication is blocked until Task 7's report exists.

- [ ] **Step 6: Run tests and patch an out-of-tree copy**

```powershell
python -X utf8 mod-tools/tests/test_abyss_mode_patch.py -v
python -X utf8 client-patch/abyss-mode-equipment/patch.py --source D:\WF\wf-re-workspace\decompile\scripts\pinball\common\data\character\BattleCharacterLogic.as --output out\abyss-client-patch\BattleCharacterLogic.as
python -X utf8 client-patch/abyss-mode-equipment/patch.py --verify out\abyss-client-patch\BattleCharacterLogic.as
```

Expected: tests pass, patch reports one insertion, and verify reports the exact three allowed quest classes.

- [ ] **Step 7: Commit the reusable gate**

```powershell
git add -- client-patch/abyss-mode-equipment/patch.py client-patch/abyss-mode-equipment/README.md mod-tools/tests/test_abyss_mode_patch.py
git diff --cached --check
git commit -m "feat(client-patch): gate abyss equipment by quest"
```

---

## Task 7: Build, sign, and re-decompile a verified client APK

**Files:**

- Create: `client-patch/abyss-mode-equipment/build_apk.py`
- Create: `mod-tools/tests/test_abyss_apk_builder.py`
- Modify: `client-patch/abyss-mode-equipment/README.md`

- [ ] **Step 1: Write failing APK-repack and report tests**

Use tiny temporary ZIP files and mocked subprocess calls. Test that:

- `assets/worldflipper_android_release.swf` is replaced while its compression method is retained.
- Top-level `META-INF/MANIFEST.MF`, `.SF`, `.RSA`, `.DSA`, and `.EC` signatures are removed, while `META-INF/AIR/**` remains.
- A failed FFDec replace, failed class re-export, failed semantic verification, failed zipalign, or failed apksigner verification leaves no final APK or verification report.
- A success report contains SHA-256 for patched AS, injected SWF, signed APK, and re-exported AS, plus the exact class name and absolute paths.
- Re-hashing any artifact makes `validate_verification_report` fail.

- [ ] **Step 2: Run and observe import failure**

```powershell
python -X utf8 mod-tools/tests/test_abyss_apk_builder.py -v
```

Expected: failure because `build_apk.py` does not exist.

- [ ] **Step 3: Implement the transactional builder**

Expose pure helpers `is_signature_member`, `rewrite_apk`, `sha256_file`, and `validate_verification_report`. The CLI takes:

```text
--base --battle-logic-as --out --report --work
--ffdec --java --zipalign --apksigner --ks --ks-pass-env
```

Use this external sequence inside a temporary work directory:

```text
java -jar ffdec.jar -air -onerror abort -replace orig.swf inj.swf pinball.common.data.character.BattleCharacterLogic BattleCharacterLogic.as
java -jar ffdec.jar -onerror abort -selectclass pinball.common.data.character.BattleCharacterLogic -export script verify_export inj.swf
zipalign.exe -p -f 4 unsigned.apk aligned.apk
apksigner.bat sign --v4-signing-enabled false --ks KEYSTORE --ks-pass env:WF_APK_KS_PASS --out signed.apk aligned.apk
apksigner.bat verify --verbose --print-certs signed.apk
```

Locate the one re-exported `BattleCharacterLogic.as`, call `patch.verify_text(..., require_markers=False)`, then atomically move the APK and JSON report to their requested destinations. Never put the password in the report or command log.

- [ ] **Step 4: Run unit tests**

```powershell
python -X utf8 mod-tools/tests/test_abyss_apk_builder.py -v
```

Expected: all ZIP, failure-cleanup, hash, and report tests pass.

- [ ] **Step 5: Build against the local CN client toolchain**

Set `WF_APK_KS_PASS` in the current process without writing it to disk, then run:

```powershell
python -X utf8 client-patch/abyss-mode-equipment/build_apk.py --base D:\WF\starview-windows\patched.apk --battle-logic-as out\abyss-client-patch\BattleCharacterLogic.as --out out\abyss-client-patch\wf_abyss_gate.apk --report out\abyss-client-patch\gate-verification.json --work out\abyss-client-patch\work --ffdec D:\WF\starview-windows\ffdec\ffdec.jar --java "C:\Program Files (x86)\Common Files\Oracle\Java\java8path\java.exe" --zipalign D:\WF\starview-windows\build-tools\zipalign.exe --apksigner D:\WF\starview-windows\build-tools\apksigner.bat --ks D:\WF\startpoint-cn\弹国服\instrument\wf_new.keystore --ks-pass-env WF_APK_KS_PASS
```

Expected: FFDec replace succeeds, the class re-export passes semantic verification, `apksigner verify` succeeds, and both `wf_abyss_gate.apk` and `gate-verification.json` exist under `out/`.

- [ ] **Step 6: Commit the builder, not its outputs**

```powershell
git add -- client-patch/abyss-mode-equipment/build_apk.py client-patch/abyss-mode-equipment/README.md mod-tools/tests/test_abyss_apk_builder.py
git diff --cached --check
git commit -m "feat(client-patch): build verified abyss client"
```

---

## Task 8: Add the end-to-end validator and gated explicit release

**Files:**

- Create: `mod-tools/wf_rogue_validate.py`
- Create: `mod-tools/tests/test_rogue_validate.py`
- Modify: `mod-tools/wf_rogue_rewards.py`
- Modify: `mod-tools/tests/test_rogue_rewards.py`

- [ ] **Step 1: Write failing release-validator tests**

Build an in-memory/temporary complete fixture, then independently corrupt each boundary and assert a named error:

- Missing equipment, status, soul, shop, item, or Rush row.
- Wrong weapon name, rarity, max level, element, image path, description, ability column, or status donor map.
- Empty ability description.
- Missing/invalid/duplicate PNG or wrong hashed store bytes.
- Wrong shop cost, stock, reward, ordering, server nesting, or ID map.
- `rush_event[700099].c10 != 2370099`.
- Missing, stale, or tampered client verification report/APK/re-exported AS.
- Report re-export no longer passes semantic gate verification.

Mock `subprocess.run` and assert it is never called when any error exists. On a valid fixture, assert the only publisher command is an explicit allowlist.

- [ ] **Step 2: Run and observe import failure**

```powershell
python -X utf8 mod-tools/tests/test_rogue_validate.py -v
```

Expected: failure because the validator does not exist.

- [ ] **Step 3: Implement comprehensive validation**

```python
@dataclass(frozen=True)
class ValidationResult:
    errors: tuple[str, ...]
    descriptions: tuple[str, ...]

def validate_release(store: Path, assets_dir: Path, report_path: Path) -> ValidationResult: ...
def require_release_ready(store: Path, assets_dir: Path, report_path: Path) -> None: ...
def release_logicals() -> list[str]: ...
```

`release_logicals()` returns exactly these six tables plus 15 image paths with `.png`:

```python
[ITEM_T, EQUIP_T, EQUIP_STATUS_T, SOUL_T, RUSH_EVENT_T,
 "master/shop/event_item_shop.orderedmap"] +
[f"{spec.image_logical}.png" for spec in WEAPONS]
```

The validator imports pure contract/build helpers instead of duplicating constants. It prints all 15 ability-description readbacks and returns every error in one run.

- [ ] **Step 4: Gate `--publish` in the reward CLI**

Add required option `--client-verification` whenever `--publish` is present. After `--write` and all readbacks:

```python
require_release_ready(store, asset_dir, Path(args.client_verification))
cmd = [sys.executable, str(ROOT / "mod-tools" / "wf_publish.py"),
       "--tables", ",".join(release_logicals())]
subprocess.run(cmd, cwd=ROOT, check=True)
```

Passing full logical paths is intentional: `wf_publish.py --tables` hashes unknown aliases as logical paths, so tables and PNGs enter the same diff while unrelated `mod-tools/work/sync_pending.json` contents remain untouched.

Reject `--publish` without `--write`. A publisher nonzero exit propagates as a nonzero reward command.

- [ ] **Step 5: Run focused and full Python tests**

```powershell
python -X utf8 mod-tools/tests/test_rogue_validate.py -v
python -X utf8 mod-tools/tests/test_rogue_rewards.py -v
python -X utf8 -m unittest discover -s mod-tools/tests -p "test_*.py" -v
```

Expected: all tests pass; no real store, CDN, or APK is mutated by tests.

- [ ] **Step 6: Commit the release gate**

```powershell
git add -- mod-tools/wf_rogue_validate.py mod-tools/tests/test_rogue_validate.py mod-tools/wf_rogue_rewards.py mod-tools/tests/test_rogue_rewards.py
git diff --cached --check
git commit -m "feat(mod): fail closed abyss release"
```

---

## Task 9: Materialize, publish, deploy to MuMu, and run the live matrix

**Files:**

- Modify: `assets/equipment_max_level.json`
- Modify: `assets/equipment_element.json`
- Modify: `assets/equipment_lookup.json`
- Modify: `assets/equipment_ids.json`
- Modify: `assets/item_ids.json`
- Modify: `assets/event_item_shop.json`
- Modify: `assets/event_item_shop_id_map.json`
- Runtime-only: resolved CN upload store, `.cdn/cn/archive-common-diff/`, `out/abyss-client-patch/`, disposable test save, MuMu installation

- [ ] **Step 1: Capture a path-scoped pre-write snapshot**

```powershell
git status --short -- assets/equipment_max_level.json assets/equipment_element.json assets/equipment_lookup.json assets/equipment_ids.json assets/item_ids.json assets/event_item_shop.json assets/event_item_shop_id_map.json mod-tools/wf_rogue_rewards.py mod-tools/wf_rogue_shop.py mod-tools/wf_rogue_build.py client-patch/abyss-mode-equipment
git diff -- assets/equipment_lookup.json assets/equipment_ids.json assets/item_ids.json assets/event_item_shop.json assets/event_item_shop_id_map.json
```

Record the existing path-specific state in the execution notes. Do not discard pre-existing changes; the generated transforms must preserve unrelated keys.

- [ ] **Step 2: Run the full static verification suite before writes**

```powershell
python -X utf8 -m unittest discover -s mod-tools/tests -p "test_*.py" -v
npm run typecheck
python -X utf8 mod-tools/wf_rogue_shop.py
python -X utf8 mod-tools/wf_rogue_rewards.py --validate-assets
python -X utf8 mod-tools/wf_rogue_rewards.py
```

Expected: all tests and TypeScript checks pass; both generators remain dry-run; asset count is `15/15`.

- [ ] **Step 3: Ensure the verified client report is current**

Re-run Task 6's patch command and Task 7's APK build command if any patch, builder, base APK, or patched AS hash changed. Then run:

```powershell
python -X utf8 client-patch/abyss-mode-equipment/patch.py --verify out\abyss-client-patch\work\verify_export\pinball\common\data\character\BattleCharacterLogic.as
```

Expected: semantic verification passes on the class re-exported from the injected SWF, not merely on the input source.

- [ ] **Step 4: Materialize the shop, rewards, images, and token without publishing**

```powershell
python -X utf8 mod-tools/wf_rogue_shop.py --write
python -X utf8 mod-tools/wf_rogue_rewards.py --write
python -X utf8 mod-tools/wf_rogue_validate.py --client-verification out\abyss-client-patch\gate-verification.json
```

Expected: orderedmap backup paths are printed; 15 equipment/status/soul/image records and 15 shop products read back; server JSON maps match; Rush token is `2370099`; validation exits zero.

- [ ] **Step 5: Review and commit only tracked/generated server artifacts**

```powershell
git diff --check -- assets/equipment_max_level.json assets/equipment_element.json assets/equipment_lookup.json assets/equipment_ids.json assets/item_ids.json assets/event_item_shop.json assets/event_item_shop_id_map.json
git diff --stat -- assets/equipment_max_level.json assets/equipment_element.json assets/equipment_lookup.json assets/equipment_ids.json assets/item_ids.json assets/event_item_shop.json assets/event_item_shop_id_map.json
git add -- assets/equipment_max_level.json assets/equipment_element.json assets/equipment_lookup.json assets/equipment_ids.json assets/item_ids.json assets/event_item_shop.json assets/event_item_shop_id_map.json
git diff --cached --check
git commit -m "data(mod): materialize abyss arsenal and shop"
```

Before committing, inspect the cached diff and confirm no unrelated keys were removed. Do not stage the CN upload store, backups, CDN diff, or `out/`.

- [ ] **Step 6: Publish the exact allowlist behind the client gate**

```powershell
python -X utf8 mod-tools/wf_rogue_rewards.py --write --publish --client-verification out\abyss-client-patch\gate-verification.json
```

Expected: validation passes first; publisher lists exactly six master tables and 15 PNG hashed files; one new common diff version is created; global `sync_pending.json` is neither read nor cleared.

- [ ] **Step 7: Restart the CN server safely**

Because `equipment_ids.json`, `item_ids.json`, and the shop JSON are statically imported, a hot asset reload is insufficient. Reuse the existing user-approved CN-server launch method if one is active; otherwise launch `npm run dev:cn` in a hidden background process and record its PID. Wait for:

```powershell
Invoke-RestMethod -Uri http://127.0.0.1:8001/api/server/currentTime -Headers @{Accept='application/json'}
```

Expected: HTTP 200 JSON. Do not stop or replace an unrelated process bound to port 8001.

- [ ] **Step 8: Install the signed gate APK and restart the game**

```powershell
$adb = 'D:\WF\MuMuPlayer\nx_main\adb.exe'
& $adb connect 127.0.0.1:16384
& $adb -s 127.0.0.1:16384 install -r --no-incremental out\abyss-client-patch\wf_abyss_gate.apk
& $adb -s 127.0.0.1:16384 shell am force-stop com.leiting.wf
& $adb -s 127.0.0.1:16384 shell monkey -p com.leiting.wf 1
```

Expected: ADB connects, install prints `Success`, and the client pulls the new diff on launch without a full resource redownload.

- [ ] **Step 9: Prepare a disposable live-test save**

Query `GET /api/server/accounts` and choose or clone a disposable save. Store its numeric ID in `$playerId`, then grant the exact graduation cost for shop testing:

```powershell
$body = @{id=2370099; count=825} | ConvertTo-Json
Invoke-RestMethod -Method Post -Uri "http://127.0.0.1:8001/api/player/$playerId/item" -Headers @{Accept='application/json'} -ContentType 'application/json' -Body $body
```

Expected: `{ ok: true, itemId: 2370099, count: 825 }`. Keep all test mutations on this disposable save.

- [ ] **Step 10: Verify the native shop flow**

In MuMu, enter Rush Event `700099` and its exchange page. Capture evidence under `out/abyss-live-qa/` for:

1. Fifteen products in ascending weapon ID/name order with the new images.
2. Deep Abyss token balance and correct 10/15 prices.
3. Insufficient-balance rejection after temporarily reducing balance on the disposable save.
4. One successful purchase, inventory arrival, and stock decreasing from 5 to 4.
5. Leaving/re-entering preserves stock.
6. Buying through stock 0 blocks another purchase.

- [ ] **Step 11: Verify the quest-effect matrix**

Equip at least one obvious gauge weapon and one damage/HP weapon or their same-ID souls. Use the same team and record starting gauge, displayed HP, and one repeatable damage number in each scene:

| Scene | Expected |
|---|---|
| Rush `700099` | effects on |
| Challenge Dungeon `2001` | effects on |
| Practice IDs `1` and a second elemental dummy within `2`–`97` | effects on |
| Challenge Dungeon `2002` | effects off |
| Practice `1001` | effects off |
| One normal story quest | effects off |

Repeat one allowed and one denied scene with the corresponding ability soul instead of the weapon to prove the soul cannot bypass the gate. Save screenshots and a compact JSON/Markdown record in `out/abyss-live-qa/`; do not commit runtime evidence unless requested.

- [ ] **Step 12: Final verification and frozen-directory check**

```powershell
python -X utf8 -m unittest discover -s mod-tools/tests -p "test_*.py" -v
npm run typecheck
python -X utf8 mod-tools/wf_rogue_validate.py --client-verification out\abyss-client-patch\gate-verification.json
git diff --name-only 07ca6ff8129af90a9e9cfacd95b7867b28474d9b -- web/pages src/routes/web web/public
git status --short -- docs/superpowers mod-tools/wf_rogue_rewards.py mod-tools/wf_rogue_shop.py mod-tools/wf_rogue_build.py mod-tools/wf_rogue_validate.py mod-tools/tests mod-tools/assets/abyss-equipment client-patch/abyss-mode-equipment assets/equipment_max_level.json assets/equipment_element.json assets/equipment_lookup.json assets/equipment_ids.json assets/item_ids.json assets/event_item_shop.json assets/event_item_shop_id_map.json
```

Expected: tests, typecheck, and release validation pass; frozen-directory diff is empty; only intentional task paths appear. Report the new CDN version, APK SHA-256, validation matrix, live evidence paths, commits, and any remaining balance-only follow-up.

---

## Plan Self-Review Checklist

- [ ] Every approved weapon ID, name, donor, element, image slug, and effect appears in the canonical contract and tests.
- [ ] Equipment base status is copied through `equipment_status`, not omitted or amplified.
- [ ] Ability-soul generation takes only the first row of each fixed template key.
- [ ] Weapon and same-ID soul share the same client gate.
- [ ] The positive and negative quest matrix exactly matches the approved design.
- [ ] Shop client table, server shop JSON, ID map, stale-key deletion, stock, and total cost are all tested.
- [ ] `rush_event[700099].c10` is fixed both in current reward writes and future Rush builder runs.
- [ ] All 15 images are original, distinct, transparent RGBA, exact-size, path-stable, and losslessly stored.
- [ ] Publication proves the gate by re-exporting the compiled class and uses an explicit allowlist that includes images.
- [ ] APK repacking, signing, deployment, server restart, shop QA, and all six combat scenes have executable steps.
- [ ] Old admin files and local reverse workspaces remain untouched.
