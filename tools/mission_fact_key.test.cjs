"use strict"

const assert = require("node:assert/strict")
const { spawnSync } = require("node:child_process")
const fs = require("node:fs")
const os = require("node:os")
const path = require("node:path")
const test = require("node:test")

require("ts-node/register/transpile-only")

const mission = require("../src/lib/mission")
const { getFactKeyId, normalizeFactKey } = require("../src/lib/mission/facts/fact-key")
const { buildFactLoadPlan } = require("../src/lib/mission/facts/load-plan")

function assertDeepFrozen(value, seen = new Set()) {
    if (value === null || typeof value !== "object" || seen.has(value)) return
    seen.add(value)
    assert.equal(Object.isFrozen(value), true)
    for (const child of Object.values(value)) assertDeepFrozen(child, seen)
}

function assertInvalid(key, kind, field) {
    assert.throws(
        () => normalizeFactKey(key),
        error => error instanceof TypeError
            && error.message.includes(kind)
            && error.message.includes(field),
    )
}

function assertRejectedByAllApis(key, validateError = error => error instanceof TypeError) {
    const operations = [
        () => normalizeFactKey(key),
        () => getFactKeyId(key),
        () => buildFactLoadPlan([key]),
    ]
    for (const operation of operations) assert.throws(operation, validateError)
}

function assertUnexpectedField(key, kind, field) {
    assertRejectedByAllApis(
        key,
        error => error instanceof TypeError
            && error.message.includes(kind)
            && error.message.includes(field),
    )
}

function assertInvalidSelection(selection, kind = "collectedItems", field = "itemIds") {
    const key = kind === "collectedItems"
        ? { kind, itemIds: selection }
        : { kind, sections: selection }
    assertRejectedByAllApis(
        key,
        error => error instanceof TypeError
            && error.message.includes(kind)
            && error.message.includes(field),
    )
}

function permutations(values) {
    if (values.length <= 1) return [values]
    return values.flatMap((value, index) => permutations([
        ...values.slice(0, index),
        ...values.slice(index + 1),
    ]).map(rest => [value, ...rest]))
}

test("exports fact key APIs from the mission barrel", () => {
    assert.equal(mission.normalizeFactKey, normalizeFactKey)
    assert.equal(mission.getFactKeyId, getFactKeyId)
    assert.equal(mission.buildFactLoadPlan, buildFactLoadPlan)
})

test("creates the specified ID for every FactKey kind", () => {
    const cases = [
        [{ kind: "player" }, "player"],
        [{ kind: "characters" }, "characters"],
        [{ kind: "characterManaNodes" }, "characterManaNodes"],
        [{ kind: "characterManaNodeAwakeLevels" }, "characterManaNodeAwakeLevels"],
        [{ kind: "equipment" }, "equipment"],
        [{ kind: "items" }, "items"],
        [{ kind: "collectedItems", itemIds: "all" }, "collectedItems:all"],
        [{ kind: "collectedItems", itemIds: [2, 1, 2] }, "collectedItems:1,2"],
        [{ kind: "questProgress", sections: "all" }, "questProgress:all"],
        [{ kind: "questProgress", sections: [21, 7, 7] }, "questProgress:7,21"],
        [
            { kind: "categoryMissionProgress", category: 3, missionIds: [1454, 1448, 1454] },
            "categoryMissionProgress:3:1448,1454",
        ],
        [{ kind: "missionBattleCounters" }, "missionBattleCounters"],
        [{ kind: "degreeBattleStats" }, "degreeBattleStats"],
        [{ kind: "characterClearCounters" }, "characterClearCounters"],
        [{ kind: "partyCoClearCounters" }, "partyCoClearCounters"],
        [{ kind: "partyGroups", category: 3 }, "partyGroups:3"],
        [{ kind: "shopPurchases", shopType: 2 }, "shopPurchases:2"],
        [{ kind: "periodicSnapshot", snapshotKind: "daily" }, "periodicSnapshot:daily"],
        [{ kind: "periodicSnapshot", snapshotKind: "weekly" }, "periodicSnapshot:weekly"],
        [{ kind: "periodicSnapshot", snapshotKind: "passWeek", eventId: 9 }, "periodicSnapshot:passWeek:9"],
        [{ kind: "passState", eventId: 9 }, "passState:9"],
        [{ kind: "awakeEligibility" }, "awakeEligibility"],
    ]

    for (const [key, expected] of cases) assert.equal(getFactKeyId(key), expected)
})

test("normalizes arrays without changing caller-owned input", () => {
    const itemIds = [5, 2, 5]
    const key = { kind: "collectedItems", itemIds }
    const normalized = normalizeFactKey(key)

    assert.deepEqual(normalized, { kind: "collectedItems", itemIds: [2, 5] })
    assert.deepEqual(key, { kind: "collectedItems", itemIds: [5, 2, 5] })
    assert.notEqual(normalized, key)
    assert.notEqual(normalized.itemIds, itemIds)
    assertDeepFrozen(normalized)
})

test("accepts only dense plain arrays with enumerable own data elements", () => {
    let getterReads = 0
    const getterSelection = []
    Object.defineProperty(getterSelection, "0", {
        configurable: true,
        enumerable: true,
        get() {
            getterReads++
            return 1
        },
    })
    const setterSelection = []
    Object.defineProperty(setterSelection, "0", {
        configurable: true,
        enumerable: true,
        set(_value) {},
    })
    const extraProperty = [1]
    extraProperty.extra = true
    const extraSymbol = [1]
    extraSymbol[Symbol("identity")] = true
    class Selection extends Array {}
    const subclass = Selection.of(1)
    const tamperedPrototype = [1]
    Object.setPrototypeOf(tamperedPrototype, null)

    const invalidSelections = [
        new Array(1),
        [1, , 3],
        getterSelection,
        setterSelection,
        extraProperty,
        extraSymbol,
        subclass,
        tamperedPrototype,
    ]
    for (const selection of invalidSelections) assertInvalidSelection(selection)
    assert.equal(getterReads, 0)
    assert.equal(getFactKeyId({ kind: "collectedItems", itemIds: [1] }), "collectedItems:1")
})

test("rejects inherited selection elements without reading them", () => {
    const inheritedIndex = "2048"
    const selection = new Array(Number(inheritedIndex) + 1)
    Object.defineProperty(Array.prototype, inheritedIndex, {
        configurable: true,
        enumerable: true,
        value: 1,
        writable: true,
    })
    try {
        assertInvalidSelection(selection, "questProgress", "sections")
    } finally {
        delete Array.prototype[inheritedIndex]
    }
})

test("accepts a legal null-prototype FactKey", () => {
    const key = Object.assign(Object.create(null), {
        kind: "questProgress",
        sections: [21, 7, 7],
    })

    assert.deepEqual(normalizeFactKey(key), {
        kind: "questProgress",
        sections: [7, 21],
    })
    assert.equal(getFactKeyId(key), "questProgress:7,21")
})

test("requires a plain object with an own enumerable string kind", () => {
    class PlayerFactKey {
        constructor() {
            this.kind = "player"
        }
    }

    const date = new Date(0)
    date.kind = "player"
    const inheritedKind = Object.create({ kind: "player" })
    const nonEnumerableKind = {}
    Object.defineProperty(nonEnumerableKind, "kind", { value: "player" })

    for (const key of [
        inheritedKind,
        date,
        new PlayerFactKey(),
        nonEnumerableKind,
        { kind: 1 },
    ]) {
        assertRejectedByAllApis(key)
    }
})

test("rejects unexpected own string and symbol fields across every public API", () => {
    const identity = Symbol("identity")
    const cases = [
        [{ kind: "player", eventId: 9 }, "player", "eventId"],
        [{ kind: "passState", eventId: 9, extra: true }, "passState", "extra"],
        [{ kind: "periodicSnapshot", snapshotKind: "passWeek", eventId: 9, extra: true }, "periodicSnapshot", "extra"],
        [{ kind: "collectedItems", itemIds: [1], extra: true }, "collectedItems", "extra"],
        [{ kind: "player", [identity]: 9 }, "player", "Symbol(identity)"],
    ]

    for (const [key, kind, field] of cases) assertUnexpectedField(key, kind, field)
})

for (const [label, createCase] of [
    ["non-enumerable eventId", () => {
        const key = { kind: "passState" }
        Object.defineProperty(key, "eventId", { value: 9 })
        return { key, kind: "passState", field: "eventId", reads: () => 0 }
    }],
    ["non-enumerable itemIds", () => {
        const key = { kind: "collectedItems" }
        Object.defineProperty(key, "itemIds", { value: [1] })
        return { key, kind: "collectedItems", field: "itemIds", reads: () => 0 }
    }],
    ["getter eventId", () => {
        let getterReads = 0
        const key = { kind: "passState" }
        Object.defineProperty(key, "eventId", {
            enumerable: true,
            get() {
                getterReads++
                return 9
            },
        })
        return { key, kind: "passState", field: "eventId", reads: () => getterReads }
    }],
    ["getter itemIds", () => {
        let getterReads = 0
        const key = { kind: "collectedItems" }
        Object.defineProperty(key, "itemIds", {
            enumerable: true,
            get() {
                getterReads++
                return [1]
            },
        })
        return { key, kind: "collectedItems", field: "itemIds", reads: () => getterReads }
    }],
]) {
    test(`rejects ${label} root fields without invoking accessors`, () => {
        const { key, kind, field, reads } = createCase()
        try {
            assertRejectedByAllApis(
                key,
                error => error instanceof TypeError
                    && error.message.includes(`${kind}.${field}`),
            )
        } finally {
            assert.equal(reads(), 0)
        }
    })
}

test("deduplicates singleton keys, merges local arrays, and lets all cover locals", () => {
    const plan = buildFactLoadPlan([
        { kind: "player" },
        { kind: "player" },
        { kind: "collectedItems", itemIds: [5, 2, 5] },
        { kind: "collectedItems", itemIds: [7, 2] },
        { kind: "questProgress", sections: [21, 7, 7] },
        { kind: "questProgress", sections: "all" },
        { kind: "questProgress", sections: [99] },
    ])

    assert.deepEqual(plan.keys, [
        { kind: "collectedItems", itemIds: [2, 5, 7] },
        { kind: "player" },
        { kind: "questProgress", sections: "all" },
    ])
    assert.deepEqual(plan.keyIds, [
        "collectedItems:2,5,7",
        "player",
        "questProgress:all",
    ])
})

test("merges category mission progress selections only within the same category", () => {
    const plan = buildFactLoadPlan([
        { kind: "categoryMissionProgress", category: 3, missionIds: [1454, 1448] },
        { kind: "categoryMissionProgress", category: 3, missionIds: [1450, 1448] },
        { kind: "categoryMissionProgress", category: 9, missionIds: [14] },
    ])

    assert.deepEqual(plan.keys, [
        { kind: "categoryMissionProgress", category: 3, missionIds: [1448, 1450, 1454] },
        { kind: "categoryMissionProgress", category: 9, missionIds: [14] },
    ])
})

test("keeps parameterized keys isolated by their complete identity", () => {
    const plan = buildFactLoadPlan([
        { kind: "categoryMissionProgress", category: 2, missionIds: [5] },
        { kind: "categoryMissionProgress", category: 1, missionIds: [4] },
        { kind: "partyGroups", category: 3 },
        { kind: "partyGroups", category: 4 },
        { kind: "shopPurchases", shopType: 2 },
        { kind: "shopPurchases", shopType: 1 },
        { kind: "periodicSnapshot", snapshotKind: "daily" },
        { kind: "periodicSnapshot", snapshotKind: "weekly" },
        { kind: "periodicSnapshot", snapshotKind: "passWeek", eventId: 2 },
        { kind: "periodicSnapshot", snapshotKind: "passWeek", eventId: 1 },
        { kind: "passState", eventId: 2 },
        { kind: "passState", eventId: 1 },
    ])

    assert.deepEqual(plan.keyIds, [
        "categoryMissionProgress:1:4",
        "categoryMissionProgress:2:5",
        "partyGroups:3",
        "partyGroups:4",
        "passState:1",
        "passState:2",
        "periodicSnapshot:daily",
        "periodicSnapshot:passWeek:1",
        "periodicSnapshot:passWeek:2",
        "periodicSnapshot:weekly",
        "shopPurchases:1",
        "shopPurchases:2",
    ])
})

test("returns a deterministic deeply frozen plan without cross-call identity caching", () => {
    const input = [
        { kind: "questProgress", sections: [21, 7, 7] },
        { kind: "characters" },
        { kind: "collectedItems", itemIds: "all" },
    ]
    const before = structuredClone(input)
    const first = buildFactLoadPlan(input)
    const second = buildFactLoadPlan([...input].reverse())

    assert.deepEqual(input, before)
    assert.deepEqual(first, second)
    assertDeepFrozen(first)
    assert.notEqual(first, second)
    assert.notEqual(first.keys, second.keys)
    assert.notEqual(first.keyIds, second.keyIds)
    for (let index = 0; index < first.keys.length; index++) {
        assert.notEqual(first.keys[index], second.keys[index])
    }
})

test("returns the same plan for all 120 permutations of five keys", () => {
    const keys = [
        { kind: "collectedItems", itemIds: [5, 2] },
        { kind: "collectedItems", itemIds: [7] },
        { kind: "questProgress", sections: [21, 7] },
        { kind: "player" },
        { kind: "partyGroups", category: 3 },
    ]
    const expected = buildFactLoadPlan(keys)
    const orders = permutations(keys)

    assert.equal(orders.length, 120)
    for (const order of orders) assert.deepEqual(buildFactLoadPlan(order), expected)
})

test("builds a deeply frozen empty plan", () => {
    const plan = buildFactLoadPlan([])

    assert.deepEqual(plan, { keys: [], keyIds: [] })
    assertDeepFrozen(plan)
})

test("completes large local selection unions", () => {
    const size = 3_000
    const keys = []
    for (let value = size; value >= 1; value--) {
        keys.push({ kind: "collectedItems", itemIds: [value] })
        keys.push({ kind: "questProgress", sections: [value] })
    }

    const plan = buildFactLoadPlan(keys)
    assert.equal(plan.keys.length, 2)
    assert.deepEqual(plan.keys[0].itemIds, Array.from({ length: size }, (_, index) => index + 1))
    assert.deepEqual(plan.keys[1].sections, Array.from({ length: size }, (_, index) => index + 1))
})

test("rejects invalid numeric parameters and empty arrays with kind and field context", () => {
    const invalidNumbers = [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, Number.MAX_SAFE_INTEGER + 1, "1"]
    for (const value of invalidNumbers) {
        assertInvalid({ kind: "collectedItems", itemIds: [value] }, "collectedItems", "itemIds")
        assertInvalid({ kind: "questProgress", sections: [value] }, "questProgress", "sections")
        assertInvalid({
            kind: "categoryMissionProgress",
            category: value,
            missionIds: [1],
        }, "categoryMissionProgress", "category")
        assertInvalid({
            kind: "categoryMissionProgress",
            category: 3,
            missionIds: [value],
        }, "categoryMissionProgress", "missionIds")
        assertInvalid({ kind: "partyGroups", category: value }, "partyGroups", "category")
        assertInvalid({ kind: "shopPurchases", shopType: value }, "shopPurchases", "shopType")
        assertInvalid({ kind: "passState", eventId: value }, "passState", "eventId")
    }
    assertInvalid({ kind: "collectedItems", itemIds: [] }, "collectedItems", "itemIds")
    assertInvalid({ kind: "questProgress", sections: [] }, "questProgress", "sections")
    assertInvalid({
        kind: "categoryMissionProgress",
        category: 3,
        missionIds: [],
    }, "categoryMissionProgress", "missionIds")
})

test("rejects invalid periodic snapshot combinations", () => {
    assertInvalid({ kind: "periodicSnapshot", snapshotKind: "daily", eventId: 1 }, "periodicSnapshot", "eventId")
    assertInvalid({ kind: "periodicSnapshot", snapshotKind: "daily", eventId: undefined }, "periodicSnapshot", "eventId")
    assertInvalid({ kind: "periodicSnapshot", snapshotKind: "weekly", eventId: 1 }, "periodicSnapshot", "eventId")
    assertInvalid({ kind: "periodicSnapshot", snapshotKind: "passWeek" }, "periodicSnapshot", "eventId")
    assertInvalid({ kind: "periodicSnapshot", snapshotKind: "passWeek", eventId: 0 }, "periodicSnapshot", "eventId")
    assertInvalid({ kind: "periodicSnapshot", snapshotKind: "monthly" }, "periodicSnapshot", "snapshotKind")
})

test("rejects unknown runtime kinds", () => {
    assert.throws(
        () => normalizeFactKey({ kind: "futureFact" }),
        error => error instanceof TypeError && error.message.includes("futureFact"),
    )
    assert.throws(() => buildFactLoadPlan([{ kind: "futureFact" }]), TypeError)
})

test("facts modules have no data-layer imports", () => {
    const factsDirectory = path.resolve(__dirname, "../src/lib/mission/facts")
    const sources = fs.readdirSync(factsDirectory)
        .filter(fileName => fileName.endsWith(".ts"))
        .map(fileName => fs.readFileSync(path.join(factsDirectory, fileName), "utf8"))

    for (const source of sources) {
        assert.doesNotMatch(source, /(?:from\s+|require\s*\()["'][^"']*\/data(?:\/|["'])/)
    }
})

test("shop purchase FactKey value rejects index assignment at TypeScript compile time", t => {
    const projectRoot = path.resolve(__dirname, "..")
    const fixtureDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "mission-fact-types-"))
    const fixturePath = path.join(fixtureDirectory, "shop-purchases.ts")
    const factLoadersModule = path.join(
        projectRoot,
        "src/lib/mission/fact-loaders",
    ).replaceAll("\\", "/")
    const tscPath = path.join(projectRoot, "node_modules/typescript/bin/tsc")
    t.after(() => fs.rmSync(fixtureDirectory, { force: true, recursive: true }))

    const compile = source => {
        fs.writeFileSync(fixturePath, source, "utf8")
        return spawnSync(process.execPath, [
            tscPath,
            "--strict",
            "--noEmit",
            "--skipLibCheck",
            "--module", "commonjs",
            "--moduleResolution", "node",
            "--target", "es2016",
            "--esModuleInterop",
            "--resolveJsonModule",
            fixturePath,
        ], { cwd: projectRoot, encoding: "utf8" })
    }

    const readonlyResult = compile(`
import type { MissionFactValueByKind } from ${JSON.stringify(factLoadersModule)}

declare const purchases: MissionFactValueByKind["shopPurchases"]
const count: number = purchases[501]
// @ts-expect-error shop purchase fact maps are immutable
purchases[501] = 4
void count
`)
    assert.equal(readonlyResult.status, 0, `${readonlyResult.stdout}${readonlyResult.stderr}`)

    const mutableControl = compile(`
type MutablePurchaseMap = Record<number, number>
declare const purchases: MutablePurchaseMap
// @ts-expect-error mutable maps must make this directive fail as unused
purchases[501] = 4
`)
    assert.notEqual(mutableControl.status, 0)
    assert.match(`${mutableControl.stdout}${mutableControl.stderr}`, /TS2578|Unused '@ts-expect-error'/)
})

test("fact key types have a one-way dependency into load plan types", () => {
    const factsDirectory = path.resolve(__dirname, "../src/lib/mission/facts")
    const factKeySource = fs.readFileSync(path.join(factsDirectory, "fact-key.ts"), "utf8")
    const typesSource = fs.readFileSync(path.join(factsDirectory, "types.ts"), "utf8")

    assert.doesNotMatch(factKeySource, /from\s+["']\.\/types["']/)
    assert.match(typesSource, /import type \{ FactKey \} from ["']\.\/fact-key["']/)
})

test("fact key normalization avoids unchecked runtime casts", () => {
    const factsDirectory = path.resolve(__dirname, "../src/lib/mission/facts")
    const factKeySource = fs.readFileSync(path.join(factsDirectory, "fact-key.ts"), "utf8")
    const loadPlanSource = fs.readFileSync(path.join(factsDirectory, "load-plan.ts"), "utf8")

    assert.doesNotMatch(factKeySource, /as unknown as|as string/)
    assert.doesNotMatch(loadPlanSource, /\sas\s+(?!const\b)/)
    assert.match(factKeySource, /function getOwnEnumerableDataValue\(/)
})
