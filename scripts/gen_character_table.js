/**
 * Generate character_table.{csv,json} with correct elements.
 */
const fs = require("fs");
const path = require("path");

const OM = path.resolve(__dirname, "..", "..", "wf-assets-cn", "orderedmap");
const OUT = path.join(__dirname, "..", "docs", "generated");

const chars = JSON.parse(fs.readFileSync(path.join(OM, "character", "character.json"), "utf8"));
const texts = JSON.parse(fs.readFileSync(path.join(OM, "character", "character_text.json"), "utf8"));
const elem = { 0: "火", 1: "水", 2: "雷", 3: "风", 4: "光", 5: "暗" };
const gender = { 0: "不明", 1: "男性", 2: "女性", 3: "不明" };

const rows = [];
for (const [id, arr] of Object.entries(chars)) {
  const f = arr[0];
  const t = texts[id] ? texts[id][0] : null;
  const name = t ? t[0] : (f[9] || f[0] || "?");
  const el = elem[f[3]] || "?";
  const rar = f[2] ? f[2] + "★" : "?";
  const g = gender[f[6]] || f[6] || "?";
  const race = f[4] || "";

  rows.push({ id: Number(id), name, rarity: rar, element: el, gender: g, race });
}

rows.sort((a, b) => a.id - b.id);

// CSV
const csvHeader = "id,名称,稀有度,元素,性别,种族\n";
const csvLines = rows.map((r) => `${r.id},${r.name},${r.rarity},${r.element},${r.gender},${r.race}`).join("\n");
fs.writeFileSync(path.join(OUT, "character_table.csv"), csvHeader + csvLines);
fs.writeFileSync(path.join(OUT, "character_table.json"), JSON.stringify(rows, null, 2));

console.log(`Generated ${rows.length} character entries`);
// Verify elements
const elemCounts = {};
rows.forEach(r => { elemCounts[r.element] = (elemCounts[r.element] || 0) + 1; });
console.log("Element distribution:", JSON.stringify(elemCounts));
