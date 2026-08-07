"use strict"

const assert = require("node:assert/strict")
const fs = require("node:fs")
const path = require("node:path")
const test = require("node:test")

require("ts-node/register/transpile-only")

const projectRoot = path.resolve(__dirname, "..")
const {
    productionContentSnapshotProvider,
} = require("../src/content/runtime/content-snapshot")

const previousSnapshot = productionContentSnapshotProvider.snapshot
productionContentSnapshotProvider.snapshot = null

// These imports intentionally happen before any ContentSnapshot is installed.
const { getActiveCampaignRate } = require("../src/lib/stamina-campaign")
const { getRuntimeExAbilityPools } = require("../src/routes/api/exBoost")
const { isValidCharacterId } = require("../src/routes/web_api/validation")
const mailRoutes = require("../src/routes/web_api/mail").default

function staminaRow(rate, questId) {
    return [[
        "0",
        "2024-01-01 00:00:00",
        "2024-12-31 23:59:59",
        "",
        "",
        String(rate),
        "0",
        "(None)",
        "",
        String(questId),
    ]]
}

function exAbilityRow(name) {
    return [[name]]
}

function snapshot(targetVersion, tables) {
    return Object.freeze({
        cdn: Object.freeze({ targetVersion }),
        repository: Object.freeze({
            table(tableName) {
                if (!Object.hasOwn(tables, tableName)) {
                    throw new Error(`missing release table: ${tableName}`)
                }
                return tables[tableName]
            },
        }),
    })
}

function abilityIds(pools) {
    return [...Object.values(pools.A), ...Object.values(pools.B)]
        .flat()
        .sort((left, right) => left - right)
}

async function captureMailSendHandler() {
    let sendHandler
    await mailRoutes({
        post(route, handler) {
            if (route === "/send") sendHandler = handler
        },
        get() {},
    })
    assert.equal(typeof sendHandler, "function")
    return sendHandler
}

function jsonReply() {
    return {
        statusCode: 200,
        status(code) {
            this.statusCode = code
            return this
        },
        send(payload) {
            return { statusCode: this.statusCode, payload }
        },
        redirect(location) {
            return { statusCode: 302, location }
        },
    }
}

test("runtime endpoint tables follow the installed ContentSnapshot release", async t => {
    t.after(() => {
        productionContentSnapshotProvider.snapshot = previousSnapshot
    })

    const bundledPools = getRuntimeExAbilityPools()
    assert.equal(typeof getActiveCampaignRate(1, 1, new Date("2024-06-01T00:00:00Z")), "number")
    assert.ok(abilityIds(bundledPools).length > 0)
    assert.equal(isValidCharacterId(1), true)

    const releaseA = Object.freeze({
        "stamina_campaign.json": Object.freeze({
            release_a: staminaRow(0.5, 77),
        }),
        "ex_ability.json": Object.freeze({
            101: exAbilityRow("atk_self_r5"),
            102: exAbilityRow("heal_self_r4"),
        }),
        "character.json": Object.freeze({
            201: Object.freeze({ name: "release-a" }),
        }),
    })
    const releaseB = Object.freeze({
        "stamina_campaign.json": Object.freeze({
            release_b: staminaRow(0.25, 77),
        }),
        "ex_ability.json": Object.freeze({
            301: exAbilityRow("atk_party_r4"),
            302: exAbilityRow("heal_party_r5"),
        }),
        "character.json": Object.freeze({
            401: Object.freeze({ name: "release-b" }),
        }),
    })

    productionContentSnapshotProvider.snapshot = snapshot("release-a", releaseA)
    assert.equal(getActiveCampaignRate(1, 77, new Date("2024-06-01T00:00:00Z")), 0.5)
    assert.deepEqual(abilityIds(getRuntimeExAbilityPools()), [101, 102])
    assert.equal(isValidCharacterId(201), true)
    assert.equal(isValidCharacterId(401), false)

    productionContentSnapshotProvider.snapshot = snapshot("release-b", releaseB)
    assert.equal(getActiveCampaignRate(1, 77, new Date("2024-06-01T00:00:00Z")), 0.25)
    assert.deepEqual(abilityIds(getRuntimeExAbilityPools()), [301, 302])
    assert.equal(isValidCharacterId(201), false)
    assert.equal(isValidCharacterId(401), true)

    const mailSend = await captureMailSendHandler()
    const rejected = await mailSend({
        body: { type: "5", type_id: "201", number: "1" },
        headers: { accept: "application/json" },
    }, jsonReply())
    assert.equal(rejected.statusCode, 400)
    assert.match(rejected.payload.error, /角色 ID 201 不存在/)

    productionContentSnapshotProvider.snapshot = snapshot("damaged", Object.freeze({}))
    assert.throws(
        () => getActiveCampaignRate(1, 77, new Date("2024-06-01T00:00:00Z")),
        /missing release table: stamina_campaign\.json/,
    )
    assert.throws(
        () => getRuntimeExAbilityPools(),
        /missing release table: ex_ability\.json/,
    )
    assert.throws(
        () => isValidCharacterId(1),
        /missing release table: character\.json/,
    )
    await assert.rejects(
        () => mailSend({
            body: { type: "5", type_id: "1", number: "1" },
            headers: { accept: "application/json" },
        }, jsonReply()),
        /missing release table: character\.json/,
    )
})

test("mail and player use request-time character validation", () => {
    const mailSource = fs.readFileSync(path.join(projectRoot, "src/routes/web_api/mail.ts"), "utf8")
    const playerSource = fs.readFileSync(path.join(projectRoot, "src/routes/web_api/player.ts"), "utf8")
    const validationSource = fs.readFileSync(path.join(projectRoot, "src/routes/web_api/validation.ts"), "utf8")

    assert.match(mailSource, /isValidCharacterId\(typeId\)/)
    assert.match(playerSource, /isValidCharacterId\(code\)/)
    assert.doesNotMatch(mailSource, /CDN_CHAR_IDS/)
    assert.doesNotMatch(validationSource, /VALID_CHARACTER_IDS/)
})
