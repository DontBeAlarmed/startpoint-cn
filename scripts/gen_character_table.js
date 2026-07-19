/**
 * Generate character_table.{csv,json} with correct elements.
 */
const fs = require("fs");
const path = require("path");

const CDN = path.resolve(__dirname, "..", "assets", "cdndata");
const OUT = path.join(__dirname, "..", "docs", "generated");

const chars = JSON.parse(fs.readFileSync(path.join(CDN, "character.json"), "utf8"));
const texts = JSON.parse(fs.readFileSync(path.join(CDN, "character_text.json"), "utf8"));
const elem = { 0: "火", 1: "水", 2: "雷", 3: "风", 4: "光", 5: "暗" };
const gender = { Male: "男性", Female: "女性" }; // c7 原始串；其余(Unknown/Ririi 等)→不明。c6 是 speciality_type 不是性别

const rows = [];
for (const [id, arr] of Object.entries(chars)) {
  const f = arr[0];
  const t = texts[id] ? texts[id][0] : null;
  const name = t ? t[0] : (f[9] || f[0] || "?");
  const el = elem[f[3]] || "?";
  const rar = f[2] ? f[2] + "★" : "?";
  const g = gender[f[7]] || "不明";
  const race = f[4] || "";
  const title = f[18] || "";

  rows.push({ id: Number(id), name, title, rarity: rar, element: el, gender: g, race });
}

rows.sort((a, b) => a.id - b.id);

// CSV
const csvHeader = "id,名称,称号,稀有度,元素,性别,种族\n";
const csvLines = rows.map((r) => `${r.id},${r.name},${r.title},${r.rarity},${r.element},${r.gender},${r.race}`).join("\n");
fs.writeFileSync(path.join(OUT, "character_table.csv"), csvHeader + csvLines);
fs.writeFileSync(path.join(OUT, "character_table.json"), JSON.stringify(rows, null, 2));

console.log(`Generated ${rows.length} character entries`);
// Verify elements
const elemCounts = {};
rows.forEach(r => { elemCounts[r.element] = (elemCounts[r.element] || 0) + 1; });
console.log("Element distribution:", JSON.stringify(elemCounts));
