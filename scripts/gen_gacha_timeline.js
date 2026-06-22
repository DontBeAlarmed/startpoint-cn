/**
 * Generate gacha_timeline.{csv,json} from server assets data.
 */
const fs = require("fs");
const path = require("path");

const SRV = path.join(__dirname, "..", "assets");
const OM = path.resolve(__dirname, "..", "..", "wf-assets-cn", "orderedmap");
const OUT = path.join(__dirname, "..", "docs", "generated");

const gacha = JSON.parse(fs.readFileSync(path.join(SRV, "gacha.json"), "utf8"));
const texts = JSON.parse(fs.readFileSync(path.join(OM, "character", "character_text.json"), "utf8"));
const chars = JSON.parse(fs.readFileSync(path.join(OM, "character", "character.json"), "utf8"));
const elem = ["火", "水", "雷", "风", "光", "暗"];

function charName(id) {
  const t = texts[String(id)];
  if (t && t[0] && t[0][0]) return t[0][0];
  return "?";
}

const rows = [];
for (const [gid, g] of Object.entries(gacha)) {
  const name = g.name || gid;
  const start = g.startDate || "";
  const end = g.endDate || "";

  // Extract featured characters from pool
  const upChars = [];
  if (g.pool) {
    for (const [, pool] of Object.entries(g.pool)) {
      for (const c of pool) {
        if (c.isRateUp) {
          const ch = chars[String(c.id)] ? chars[String(c.id)][0] : null;
          const el = ch ? (elem[ch[3]] || "?") : "?";
          const rar = ch ? ch[2] : "?";
          upChars.push(`${charName(c.id)}(${el}${rar}★${c.odds}%)`);
        }
      }
    }
  }
  const upStr = upChars.length > 0 ? upChars.join("，") : "";

  rows.push({ id: Number(gid), name, start, end, up: upStr });
}

rows.sort((a, b) => a.start.localeCompare(b.start) || a.id - b.id);

// Write CSV
const csvHeader = "id,名称,开始,结束,UP角色\n";
const csvLines = rows.map(
  (r) => `${r.id},"${r.name}","${r.start}","${r.end}","${r.up}"`
).join("\n");
fs.writeFileSync(path.join(OUT, "gacha_timeline.csv"), csvHeader + csvLines);

// Write JSON
fs.writeFileSync(path.join(OUT, "gacha_timeline.json"), JSON.stringify(rows, null, 2));

console.log(`Generated ${rows.length} gacha entries`);
console.log(`  ${path.join(OUT, "gacha_timeline.csv")}`);
console.log(`  ${path.join(OUT, "gacha_timeline.json")}`);
