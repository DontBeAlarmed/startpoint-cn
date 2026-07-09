/**
 * Fix gacha_feature_content.json: patch missing/(None) images for all 584 gacha IDs.
 *
 * Fix types:
 *   Type A: Existing entries with (None)/empty image → fill with generic defaults
 *   Type B1: Missing entries with counterpart (same base stringId) → deep-copy section 1
 *   Type B2: Missing entries without counterpart → fill with default templates
 *
 * Usage: node tools/fix_feature_content.cjs
 */

const fs = require("fs");
const path = require("path");

const ROOT = path.resolve(__dirname, "..");
const FC_PATH = path.join(ROOT, "assets", "cdndata", "gacha_feature_content.json");
const GACHA_PATH = path.join(ROOT, "assets", "cdndata", "gacha.json");

const CHARACTER_DEFAULT = "gacha/feature_movie/release_gacha/top/feature";
const EQUIPMENT_DEFAULT = "dynamic/gacha_banner/equipment_gacha";

const CHAR_TEMPLATE = { "1": [["0", "", CHARACTER_DEFAULT, "", "", "", "(None)", "", ""]] };
const EQUIP_TEMPLATE = { "1": [["1", EQUIPMENT_DEFAULT, "", "", "", "", "(None)", "", ""]] };

// ── helpers ──────────────────────────────────────────────────────────

function getStringId(gid, gacha) {
  const entry = gacha[gid];
  if (!entry || !Array.isArray(entry) || !entry[0] || !Array.isArray(entry[0])) return null;
  return entry[0][0];
}

function getPrizeKind(gid, gacha) {
  const entry = gacha[gid];
  if (!entry || !Array.isArray(entry) || !entry[0] || !Array.isArray(entry[0])) return null;
  return String(entry[0][13]);
}

/** Extract base stringId: remove trailing _N or _N_N suffix. */
function getBase(sid) {
  return sid.replace(/_\d+$/, "").replace(/_\d+_\d+$/, "");
}

// ── main ─────────────────────────────────────────────────────────────

function main() {
  console.log("=== Fix Gacha Feature Content Images ===\n");

  const fc = JSON.parse(fs.readFileSync(FC_PATH, "utf8"));
  const gacha = JSON.parse(fs.readFileSync(GACHA_PATH, "utf8"));

  console.log(`  fc entries before: ${Object.keys(fc).length}`);
  console.log(`  gacha entries:      ${Object.keys(gacha).length}\n`);

  let fixedA = 0;
  let fixedB1 = 0;
  let fixedB2 = 0;

  // ── Step 1: Build base-stringId → fc-entry lookup ──────────────────

  const fcByBase = {};
  for (const [fcId, fcVal] of Object.entries(fc)) {
    const s1 = fcVal["1"];
    if (!s1 || !s1[0]) continue;
    const sid = getStringId(fcId, gacha);
    if (!sid) continue;
    const base = getBase(sid);
    if (!fcByBase[base]) {
      fcByBase[base] = { fcId, s1: fcVal["1"] };
    }
  }
  console.log(`  base-stringId lookup: ${Object.keys(fcByBase).length} bases\n`);

  // ── Step 2: Type A — fix (None)/empty images in existing entries ──

  for (const [fcId, fcVal] of Object.entries(fc)) {
    const s1 = fcVal["1"];
    if (!s1 || !s1[0]) continue;
    const row = s1[0];
    const pk = getPrizeKind(fcId, gacha);

    if (pk === "0" && (!row[2] || row[2] === "(None)" || row[2] === "")) {
      row[2] = CHARACTER_DEFAULT;
      fixedA++;
    }
    if (pk === "1" && (!row[1] || row[1] === "(None)" || row[1] === "")) {
      row[1] = EQUIPMENT_DEFAULT;
      fixedA++;
    }
  }
  console.log(`  Type A ((None) images fixed): ${fixedA}`);

  // ── Step 3: Type B — add missing entries ───────────────────────────

  const gachaIds = new Set(Object.keys(gacha));
  const fcIds = new Set(Object.keys(fc));
  const missing = [...gachaIds].filter((id) => !fcIds.has(id));
  // sort numerically for deterministic output ordering
  missing.sort((a, b) => parseInt(a, 10) - parseInt(b, 10));

  for (const gid of missing) {
    const sid = getStringId(gid, gacha);
    if (!sid) {
      // No stringId — use default based on prizeKind
      const pk = getPrizeKind(gid, gacha);
      fc[gid] = JSON.parse(
        JSON.stringify(pk === "1" ? EQUIP_TEMPLATE : CHAR_TEMPLATE)
      );
      fixedB2++;
      continue;
    }

    const base = getBase(sid);
    const match = fcByBase[base];

    if (match) {
      // Type B1: copy section 1 from counterpart
      fc[gid] = { "1": JSON.parse(JSON.stringify(match.s1)) };
      fixedB1++;
    } else {
      // Type B2: use default template
      const pk = getPrizeKind(gid, gacha);
      fc[gid] = JSON.parse(
        JSON.stringify(pk === "1" ? EQUIP_TEMPLATE : CHAR_TEMPLATE)
      );
      fixedB2++;
    }
  }
  console.log(`  Type B1 (copied from counterpart): ${fixedB1}`);
  console.log(`  Type B2 (default template):        ${fixedB2}`);
  console.log(`  Total fixed:                       ${fixedA + fixedB1 + fixedB2}`);

  // ── Step 4: Write output ───────────────────────────────────────────

  fs.writeFileSync(FC_PATH, JSON.stringify(fc, null, 2), "utf8");
  console.log(`\n  Wrote ${Object.keys(fc).length} entries to ${FC_PATH}`);

  // ── Step 5: Verify ─────────────────────────────────────────────────

  let charNone = 0;
  let equipNone = 0;
  const missingInGacha = [...fcIds].filter((id) => !gachaIds.has(id));

  for (const [fcId, fcVal] of Object.entries(fc)) {
    const s1 = fcVal["1"];
    if (!s1 || !s1[0]) continue;
    const row = s1[0];
    const pk = getPrizeKind(fcId, gacha);

    if (pk === "0" && (!row[2] || row[2] === "(None)" || row[2] === "")) {
      charNone++;
    }
    if (pk === "1" && (!row[1] || row[1] === "(None)" || row[1] === "")) {
      equipNone++;
    }
  }

  console.log(`\n=== Verification ===`);
  console.log(`  Total entries:                      ${Object.keys(fc).length}`);
  console.log(`  Gacha entries (target):             ${Object.keys(gacha).length}`);
  console.log(`  FC-only entries (not in gacha):     ${missingInGacha.length}`);
  console.log(`  Remaining character (None)/empty:   ${charNone}`);
  console.log(`  Remaining equipment (None)/empty:   ${equipNone}`);
  console.log(`  All clear:                          ${charNone === 0 && equipNone === 0 ? "YES ✓" : "NO — some (None) remain"}`);

  if (charNone > 0 || equipNone > 0) {
    process.exit(1);
  }
}

main();
