/**
 * Generate quest_timeline.{csv,json} from orderedmap event quest data.
 * Each quest type has different time field positions — search for datetime strings.
 */
const fs = require("fs");
const path = require("path");

const OM = path.resolve(__dirname, "..", "..", "wf-assets-cn", "orderedmap");
const OUT = path.join(__dirname, "..", "docs", "generated");

function readJSON(p) {
  try { return JSON.parse(fs.readFileSync(path.join(OM, p), "utf8")); } catch { return null; }
}

// Walk nested quest objects to find quest arrays
function walk(obj, onQuest) {
  for (const [, val] of Object.entries(obj)) {
    if (Array.isArray(val) && val.length > 0) {
      // Direct quest array: val[0] might be inner array
      const inner = Array.isArray(val[0]) ? val[0] : val;
      if (typeof inner[0] === "string" && /^-?\d+$/.test(inner[0])) {
        onQuest(inner);
      }
    } else if (typeof val === "object" && !Array.isArray(val)) {
      walk(val, onQuest);
    }
  }
}

function isDateTime(s) {
  if (typeof s !== "string") return false;
  return /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(s);
}

function questName(q) {
  // Try common name positions
  for (const i of [2, 1, 0]) {
    if (q[i] && typeof q[i] === "string" && q[i].length > 0 && !/^\d+$/.test(q[i])) {
      return q[i].replace(/ ::quest_rank::/g, "");
    }
  }
  return "";
}

function findTimeField(q) {
  for (let i = q.length - 1; i >= 0; i--) {
    if (isDateTime(q[i])) return i;
  }
  return -1;
}

// Process all event quest files
const evDir = path.join(OM, "quest", "event");
const rows = [];

if (fs.existsSync(evDir)) {
  for (const file of fs.readdirSync(evDir).filter((f) => f.endsWith(".json"))) {
    const obj = readJSON(path.join("quest", "event", file));
    if (!obj) continue;
    const evType = file.replace(".json", "");
    walk(obj, (q) => {
      const qid = q[0];
      if (!qid || isNaN(Number(qid))) return;
      const name = questName(q);
      const timeIdx = findTimeField(q);
      const start = timeIdx >= 0 ? q[timeIdx] : "";
      // Check if there's a second datetime after the first
      let end = "";
      for (let i = timeIdx + 1; i < Math.min(q.length, timeIdx + 5); i++) {
        if (isDateTime(q[i])) { end = q[i]; break; }
      }
      rows.push({ questId: qid, name, type: evType, start, end });
    });
  }
}

console.log(`Found ${rows.length} quest entries from ${fs.readdirSync(evDir).filter(f=>f.endsWith('.json')).length} files`);

// Sort by type then quest id
rows.sort((a, b) => a.type.localeCompare(b.type) || Number(a.questId) - Number(b.questId));

// CSV
const csvHeader = "副本ID,名称,类型,开始,结束\n";
const csvLines = rows.map(r => `${r.questId},"${r.name}",${r.type},"${r.start}","${r.end}"`).join("\n");
fs.writeFileSync(path.join(OUT, "quest_timeline.csv"), csvHeader + csvLines);
fs.writeFileSync(path.join(OUT, "quest_timeline.json"), JSON.stringify(rows, null, 2));

console.log(`Written to ${OUT}`);
