"use strict"
// 从 wf-assets-cn 全量行生成开局块窄行资产（[trigger, kind, power1, first_max]）。
// 用法: node tools/gen_opening_assets.cjs <WF_ASSETS_CN_ROOT> <OUT_DIR>
const fs = require("node:fs")
const path = require("node:path")

require("./test-workflow/bootstrap.cjs").bootstrap()
const { extractOpeningRow } = require("../src/content/converters/opening-ability")

const [root, outDir] = process.argv.slice(2)
if (!root || !outDir) {
    console.error("usage: node tools/gen_opening_assets.cjs <WF_ASSETS_CN_ROOT> <OUT_DIR>")
    process.exit(1)
}

for (const name of ["ability.json", "leader_ability.json", "ability_soul.json"]) {
    const full = JSON.parse(fs.readFileSync(path.join(root, "orderedmap", "ability", name), "utf8"))
    const narrow = {}
    for (const [id, rows] of Object.entries(full)) {
        narrow[id] = rows.map(row => {
            // 全量行 JSON 数组：trigger=c5/c3/c2 由表名决定，opening 取行末 3 列
            const triggerIndex = name === "ability.json" ? 5 : name === "leader_ability.json" ? 3 : 2
            const trigger = row[triggerIndex]
            const kind = Number(row[row.length - 3])
            const power1 = Number(row[row.length - 2])
            const firstMax = Number(row[row.length - 1])
            return [
                String(trigger),
                Number.isFinite(kind) ? kind : null,
                Number.isFinite(power1) ? power1 : null,
                Number.isFinite(firstMax) ? firstMax : null,
            ]
        })
    }
    fs.writeFileSync(path.join(outDir, name), JSON.stringify(narrow))
    console.log(`${name}: ${Object.keys(narrow).length} ids`)
}
