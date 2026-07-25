require("ts-node/register/transpile-only")

const assert = require("node:assert/strict")
const { convertSkillEffects } = require("../src/content/converters/skill-effects")

function rowText(size, values) {
    const row = Array.from({ length: size }, () => "")
    for (const [index, value] of Object.entries(values)) row[Number(index)] = value
    return row.join(",")
}

function characterRow(stringId, switchedSkill = "") {
    return {
        key: stringId === "depraved_monk" ? "321007" : stringId === "compliment_oiran" ? "111006" : "111117",
        text: rowText(37, { 0: stringId, 14: switchedSkill }),
    }
}

function actionRow(stringId, path, unisonable = "true") {
    return {
        key: stringId,
        rows: [{ key: "1", text: rowText(8, { 3: unisonable, 7: path }) }],
    }
}

function switchedRow(stringId, path) {
    return {
        key: stringId,
        rows: [{ key: "1", text: rowText(1, { 0: path }) }],
    }
}

const astByPath = new Map([
    ["battle/action/skill/action/rare3/depraved_monk$depraved_monk_1.action.dsl.amf3.deflate", [
        "ACToleranceOfElement", [{ min: 900, max: 900 }], 254, [{ min: -1, max: -1 }], "CreateRatioHeal",
    ]],
    ["battle/action/skill/action/rare5/compliment_oiran$compliment_oiran_1.action.dsl.amf3.deflate", [
        "CreateRatioHeal",
    ]],
    ["battle/action/skill/action/rare5/megumin$megumin_1.action.dsl.amf3.deflate", [
        "CreateNormalHeal",
    ]],
    ["battle/action/skill/action/rare5/megumin$matched_megumin_1.action.dsl.amf3.deflate", [
        "CreateNormalHeal",
    ]],
])
const allowedDynamicPaths = []

;(async () => {
const result = await convertSkillEffects({
    characterRows: [
        characterRow("depraved_monk"),
        characterRow("compliment_oiran"),
        characterRow("megumin", "megumin"),
        { key: "1", text: rowText(37, { 0: "alk" }) },
    ],
    actionSkillRows: [
        actionRow("depraved_monk", "battle/action/skill/action/rare3/depraved_monk$depraved_monk_1"),
        actionRow("compliment_oiran", "battle/action/skill/action/rare5/compliment_oiran$compliment_oiran_1"),
        actionRow("megumin", "battle/action/skill/action/rare5/megumin$megumin_1"),
        actionRow("alk", "missing/alk_1"),
    ],
    switchedActionSkillRows: [
        switchedRow("megumin", "battle/action/skill/action/rare5/megumin$matched_megumin_1"),
    ],
    async readDynamic(logicalPath) {
        if (logicalPath.endsWith("missing/alk_1.action.dsl.amf3.deflate")) {
            throw new Error(`missing ${logicalPath}`)
        }
        const ast = astByPath.get(logicalPath)
        if (!ast) throw new Error(`unexpected ${logicalPath}`)
        return Buffer.from(JSON.stringify(ast))
    },
    allowDynamic(paths) {
        allowedDynamicPaths.push(...paths)
    },
    decodeActionDsl(bytes) {
        return JSON.parse(bytes.toString("utf8"))
    },
})

assert.deepEqual(result["cdndata/active_mission_skill_effects.json"].characters, {
    "111006": {
        stringId: "compliment_oiran",
        unisonable: true,
        effects: ["CreateRatioHeal"],
    },
    "111117": {
        stringId: "megumin",
        unisonable: true,
        effects: ["CreateNormalHeal"],
    },
    "321007": {
        stringId: "depraved_monk",
        unisonable: true,
        effects: ["ACToleranceOfElement_Down", "CreateRatioHeal"],
    },
})
assert.deepEqual(result["cdndata/active_mission_skill_effects.json"].unresolved, {
    "1": {
        stringId: "alk",
        reason: "skill_dsl_unreadable",
        programPaths: ["missing/alk_1"],
    },
})
assert.deepEqual([...allowedDynamicPaths].sort(), [
    "battle/action/skill/action/rare3/depraved_monk$depraved_monk_1.action.dsl.amf3.deflate",
    "battle/action/skill/action/rare5/compliment_oiran$compliment_oiran_1.action.dsl.amf3.deflate",
    "battle/action/skill/action/rare5/megumin$matched_megumin_1.action.dsl.amf3.deflate",
    "battle/action/skill/action/rare5/megumin$megumin_1.action.dsl.amf3.deflate",
    "missing/alk_1.action.dsl.amf3.deflate",
].sort())

console.log("content skill effects converter tests passed")
})().catch(error => {
    console.error(error)
    process.exitCode = 1
})
