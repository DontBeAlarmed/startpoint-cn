"use strict"

const assert = require("node:assert/strict")
const fs = require("node:fs")
const path = require("node:path")
const test = require("node:test")

require("ts-node/register/transpile-only")

const projectRoot = path.resolve(__dirname, "..")

function repository(tables, requestedTables = []) {
    return Object.freeze({
        info: () => Object.freeze({
            source: "release",
            assetVersion: "test-release",
            generatorVersion: 1,
            releaseDigest: null,
        }),
        table: tableName => {
            requestedTables.push(tableName)
            if (!(tableName in tables)) throw new Error(`unexpected content table: ${tableName}`)
            return tables[tableName]
        },
    })
}

function contentRow(fields) {
    return [fields]
}

function findTypeScriptFiles(directory) {
    return fs.readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
        const absolutePath = path.join(directory, entry.name)
        if (entry.isDirectory()) return findTypeScriptFiles(absolutePath)
        return entry.isFile() && entry.name.endsWith(".ts") ? [absolutePath] : []
    })
}

test("character lookup is built entirely from one repository snapshot", () => {
    const { buildCharacterLookup } = require("../src/lib/character-content")
    const firstContentFields = []
    firstContentFields[18] = "星之称号"
    const firstTextFields = ["星野"]
    const requestedTables = []
    const lookup = buildCharacterLookup(repository({
        "character.json": {
            "100001": { name: "", rarity: 5, element: 0, skill_count: 6 },
            "100002": { name: "元数据名", rarity: 4, element: 5, skill_count: 3 },
            "100003": { name: "", rarity: 3, element: 99, skill_count: 1 },
        },
        "cdndata/character.json": {
            "100001": contentRow(firstContentFields),
            "100002": "malformed-row",
            "100003": [null],
        },
        "cdndata/character_text.json": {
            "100001": contentRow(firstTextFields),
            "100002": [],
            "100003": "malformed-row",
        },
    }, requestedTables))

    assert.deepEqual(lookup, {
        "100001": { name: "星野", title: "星之称号", rarity: "5★", element: "火" },
        "100002": { name: "元数据名", title: "", rarity: "4★", element: "暗" },
        "100003": { name: "?", title: "", rarity: "3★", element: "未知" },
    })
    assert.deepEqual(requestedTables, [
        "character.json",
        "cdndata/character.json",
        "cdndata/character_text.json",
    ])
})

test("character races use current repository rows and normalize comma-separated values", () => {
    const {
        productionContentSnapshotProvider,
    } = require("../src/content/runtime/content-snapshot")
    const previousSnapshot = productionContentSnapshotProvider.snapshot
    const raceFields = []
    raceFields[4] = " Human, Beast, ,Mystery  "
    productionContentSnapshotProvider.snapshot = Object.freeze({
        cdn: Object.freeze({ targetVersion: "test-release" }),
        repository: repository({
            "cdndata/character.json": {
                "100001": contentRow(raceFields),
                "100002": "malformed-row",
            },
        }),
    })

    try {
        const { getCharacterRaces } = require("../src/lib/quest/finish/race-utils")
        assert.deepEqual(getCharacterRaces(100001), ["Human", "Beast", "Mystery"])
        assert.deepEqual(getCharacterRaces("100002"), [])
        assert.deepEqual(getCharacterRaces(999999), [])
    } finally {
        productionContentSnapshotProvider.snapshot = previousSnapshot
    }
})

test("character content is not read while adapter, race utilities, and routes are imported", async () => {
    const {
        productionContentSnapshotProvider,
    } = require("../src/content/runtime/content-snapshot")
    const previousSnapshot = productionContentSnapshotProvider.snapshot
    productionContentSnapshotProvider.snapshot = null

    try {
        for (const modulePath of [
            "../src/lib/character-content",
            "../src/lib/quest/finish/race-utils",
            "../src/routes/web_api/lookup",
        ]) {
            delete require.cache[require.resolve(modulePath)]
        }
        assert.doesNotThrow(() => require("../src/lib/character-content"))
        const raceUtils = require("../src/lib/quest/finish/race-utils")
        assert.throws(
            () => raceUtils.getCharacterRaces(100009),
            error => error.code === "CONTENT_SNAPSHOT_NOT_INITIALIZED",
        )
        const routeModule = require("../src/routes/web_api/lookup")
        const routes = routeModule.default || routeModule
        let charactersHandler = null
        await routes({
            get(routePath, handler) {
                if (routePath === "/characters") charactersHandler = handler
            },
        })
        assert.equal(typeof charactersHandler, "function")

        const requestedTables = []
        const fields = []
        fields[18] = "延迟称号"
        productionContentSnapshotProvider.snapshot = Object.freeze({
            cdn: Object.freeze({ targetVersion: "test-release" }),
            repository: repository({
                "character.json": {
                    "100009": { name: "", rarity: 2, element: 2, skill_count: 1 },
                },
                "cdndata/character.json": { "100009": contentRow(fields) },
                "cdndata/character_text.json": { "100009": contentRow(["延迟角色"]) },
            }, requestedTables),
        })
        const reply = { send: value => value }

        assert.deepEqual(await charactersHandler({}, reply), {
            "100009": { name: "延迟角色", title: "延迟称号", rarity: "2★", element: "雷" },
        })
        assert.deepEqual(requestedTables, [
            "character.json",
            "cdndata/character.json",
            "cdndata/character_text.json",
        ])

        const playerRouteSource = fs.readFileSync(
            path.join(projectRoot, "src/routes/web/player.ts"),
            "utf8",
        )
        assert(
            playerRouteSource.indexOf("getCharacterLookup()")
                > playerRouteSource.indexOf('fastify.get("/:playerId"'),
            "player route must read character content inside its request handler",
        )
    } finally {
        productionContentSnapshotProvider.snapshot = previousSnapshot
    }
})

test("production TypeScript has no external character data dependency", () => {
    const externalSourceDirectory = ["wf-assets", "-cn"].join("")
    const forbidden = new RegExp(["docs/generated", externalSourceDirectory].join("|"))
    const violations = findTypeScriptFiles(path.join(projectRoot, "src"))
        .filter(filePath => forbidden.test(fs.readFileSync(filePath, "utf8")))
        .map(filePath => path.relative(projectRoot, filePath))

    assert.deepEqual(violations, [])
})
