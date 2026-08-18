"use strict"

const {
    createNonMultiMixedHttpHarness,
} = require("./non_multi_mixed_http.cjs")

function loadRuntime() {
    const data = require("../../src/data")
    const { getDb } = require("../../src/data/db")
    const { insertAccountSync } = require("../../src/data/domains/account")
    const { insertMailSync } = require("../../src/data/domains/mail")
    const { insertDefaultPlayerSync } = require("../../src/data/domains/player")
    const { insertDeviceBindingSync } = require("../../src/data/domains/session")
    const { SessionType } = require("../../src/data/types")
    const cnToolRoutes = require("../../src/routes/cn/tool").default
    const cnLoadRoutes = require("../../src/routes/cn/load").default
    const { registerCnMsgpackOnSend } = require("../../src/routes/cn/msgpack")
    const missionRoutes = require("../../src/routes/api/mission").default
    const singleBattleRoutes = require("../../src/routes/api/singleBattleQuest").default
    const shopRoutes = require("../../src/routes/api/shop").default
    const gachaRoutes = require("../../src/routes/api/gacha").default
    const mailRoutes = require("../../src/routes/api/mail").default
    const { getTimeOffset, setServerTimeOffset } = require("../../src/utils")
    const { resolveRuntimeDataPaths } = require("../../src/runtime/data-paths")
    const {
        installBundledGameplaySnapshot,
    } = require("../helpers/install-bundled-gameplay-snapshot.cjs")
    return {
        ...data,
        getDb,
        insertAccountSync,
        insertMailSync,
        insertDefaultPlayerSync,
        insertDeviceBindingSync,
        SessionType,
        cnToolRoutes,
        cnLoadRoutes,
        registerCnMsgpackOnSend,
        missionRoutes,
        singleBattleRoutes,
        shopRoutes,
        gachaRoutes,
        mailRoutes,
        getTimeOffset,
        setServerTimeOffset,
        resolveRuntimeDataPaths,
        installBundledGameplaySnapshot,
    }
}

function loadScenarioDependencies() {
    const { executeScenario } = require("./non_multi_mixed_scenarios.cjs")
    const {
        createActiveQuestSentinel,
        prepareSingleBattleIdentity,
    } = require("./non_multi_mixed_battle.cjs")
    const {
        prepareActiveQuests,
        restoreActiveQuests,
    } = require("./non_multi_mixed_active_quests.cjs")
    return {
        createActiveQuestSentinel,
        executeScenario,
        prepareActiveQuests,
        prepareSingleBattleIdentity,
        restoreActiveQuests,
    }
}

async function createRouteApp(runtime) {
    return createNonMultiMixedHttpHarness({
        registerMsgpackOnSend: runtime.registerCnMsgpackOnSend,
        routePlugins: [
            { plugin: runtime.cnToolRoutes, prefix: "/api/index.php/tool" },
            {
                plugin: runtime.cnLoadRoutes,
                prefix: "/api/index.php",
                options: {
                    assetProvider: { mode: "client-owned" },
                    multiMode: "client",
                    multiRecoveryVerifier: {
                        async inspect() {
                            throw new Error("non-multi load attempted multi recovery")
                        },
                    },
                },
            },
            { plugin: runtime.missionRoutes, prefix: "/api/index.php/mission" },
            { plugin: runtime.singleBattleRoutes, prefix: "/api/index.php/single_battle_quest" },
            { plugin: runtime.shopRoutes, prefix: "/api/index.php/shop" },
            { plugin: runtime.gachaRoutes, prefix: "/api/index.php/gacha" },
            { plugin: runtime.mailRoutes, prefix: "/api/index.php/mail" },
        ],
    })
}

module.exports = { createRouteApp, loadRuntime, loadScenarioDependencies }
