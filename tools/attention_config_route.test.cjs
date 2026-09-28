"use strict"

require("ts-node/register/transpile-only")

const assert = require("node:assert/strict")
const { randomUUID } = require("node:crypto")
const fs = require("node:fs")
const os = require("node:os")
const path = require("node:path")
const test = require("node:test")

const Fastify = require("fastify")
const { unpack } = require("msgpackr")

const databaseDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "attention-config-route-"))
const previousDataDirectory = process.env.DATA_DIR
process.env.DATA_DIR = databaseDirectory

const data = require("../src/data")
const { insertAccountSync } = require("../src/data/domains/account")
const { insertDefaultPlayerSync } = require("../src/data/domains/player")
const { insertSessionWithToken } = require("../src/data/domains/session")
const { SessionType } = require("../src/data/types")
const { registerCnMsgpackOnSend } = require("../src/routes/cn/msgpack")
const attentionRoutes = require("../src/routes/api/attention").default
const { installBundledGameplaySnapshot } = require("./helpers/install-bundled-gameplay-snapshot.cjs")

// Every field the CN client's shared early-success transformer strictly
// validates whenever a response carries data.config (RealRemoteService).
const CLIENT_VALIDATED_CONFIG_FIELDS = [
    "attention_animation_time_seconds",
    "attention_log_interval_seconds",
    "attention_polling_interval_seconds_battle",
    "attention_polling_interval_seconds_normal",
    "attention_recruitment_interval_seconds",
    "attention_recruitment_redeliver_limit",
    "contribution_score_rate_to_parasite",
    "disable_decline_count_limit",
    "disable_decline_count_seconds",
    "disable_decline_duration_seconds",
    "disable_expire_count_limit",
    "disable_expire_duration_seconds",
    "disable_finish_duration_seconds",
    "disable_intent_disconnect_duration_seconds",
    "disable_remote_error_duration_seconds",
    "disable_unintent_disconnect_duration_seconds",
    "multi_attention_lifetime_seconds",
    "polling_delay_battle_seconds_range_max",
    "polling_delay_battle_seconds_range_min",
    "polling_delay_normal_seconds_range_max",
    "polling_delay_normal_seconds_range_min",
    "return_attention_max_num",
    "summon_com_seconds",
]

let app
let restoreContentSnapshot

test.before(async () => {
    restoreContentSnapshot = installBundledGameplaySnapshot()
    data.initializeDatabase()
    const account = insertAccountSync({
        appId: "wf_cn",
        idpAlias: "",
        idpCode: "test",
        idpId: `attention-config-${randomUUID()}`,
        status: "normal",
    })
    const playerId = insertDefaultPlayerSync(account.id).id
    const viewerId = 920000001
    await insertSessionWithToken({
        token: String(viewerId),
        accountId: account.id,
        expires: new Date("2099-01-01T00:00:00.000Z"),
        type: SessionType.VIEWER,
    })
    app = Fastify({ logger: false })
    registerCnMsgpackOnSend(app)
    app.register(attentionRoutes, { prefix: "/api/index.php/attention" })
    await app.ready()
})

test.after(async () => {
    await app.close()
    data.closeDatabase()
    restoreContentSnapshot()
    fs.rmSync(databaseDirectory, { recursive: true, force: true })
    if (previousDataDirectory === undefined) delete process.env.DATA_DIR
    else process.env.DATA_DIR = previousDataDirectory
})

test("attention/check config carries every client-validated field", async () => {
    const response = await app.inject({
        method: "POST",
        url: "/api/index.php/attention/check",
        payload: { viewer_id: 920000001 },
    })
    assert.equal(response.statusCode, 200, response.body)
    const config = unpack(Buffer.from(response.body, "base64")).data.config
    for (const field of CLIENT_VALIDATED_CONFIG_FIELDS) {
        assert.notEqual(config[field], undefined, `config.${field} must be present`)
        assert.equal(typeof config[field], "number", `config.${field} must be numeric`)
    }
    // CDN attention_config column 23 fixes the official summon_com_seconds.
    assert.equal(config.summon_com_seconds, 20)
})
