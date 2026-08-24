"use strict"

const SINGLE_REREAD_REASON = "earlier awake settlement precedes later authoritative reward, active-mission, response-state and active-quest writes"
const FRESH_REREAD_REASON = "no owner snapshot is injected; load the bounded post-write scope"

function wrapperObservation(explicit, characterLists, factSeeds = [], directMissionSeeds = []) {
    const characterSeeds = [...new Set([...explicit, ...characterLists])].sort((a, b) => a - b)
    return Object.freeze({
        kind: "publish-wrapper",
        explicitCharacterSeeds: Object.freeze([...explicit]),
        characterListSeeds: Object.freeze([...characterLists]),
        contextCandidateCharacterSeeds: Object.freeze([]),
        characterSeeds: Object.freeze(characterSeeds),
        factSeeds: Object.freeze([...factSeeds]),
        directMissionSeeds: Object.freeze([...directMissionSeeds]),
    })
}

function contextObservation(kind, characterSeeds, factSeeds = [], directMissionSeeds = []) {
    return Object.freeze({
        kind,
        explicitCharacterSeeds: Object.freeze([]),
        characterListSeeds: Object.freeze([]),
        contextCandidateCharacterSeeds: Object.freeze([...characterSeeds]),
        characterSeeds: Object.freeze([...characterSeeds]),
        factSeeds: Object.freeze([...factSeeds]),
        directMissionSeeds: Object.freeze([...directMissionSeeds]),
    })
}

const OWNER_CONTRACTS = Object.freeze({
    "single-finish": Object.freeze({
        owner: "single/finish",
        boundary: "best-effort-in-tx",
        observation: wrapperObservation([1], [1], ["passState:3", "player"]),
        seedNote: "runtime observes no direct mission IDs; the matrix separately proves the static channel expression",
    }),
    "multi-finish": Object.freeze({
        owner: "multi/finish",
        boundary: "best-effort-in-tx",
        observation: contextObservation("best-effort-context", [1], [
            "collectedItems:100000", "items", "passState:3", "player",
        ]),
    }),
    "active-mission-receive": Object.freeze({
        owner: "active_mission/receive",
        boundary: "best-effort-in-tx",
        observation: contextObservation("best-effort-context", [], ["player"]),
    }),
    "box-gacha-exec": Object.freeze({
        owner: "box_gacha/exec",
        boundary: "best-effort-post-commit",
        observation: wrapperObservation([], [], ["player"]),
    }),
    "character-town-grant": Object.freeze({
        owner: "character/add_character_from_town",
        boundary: "best-effort-post-commit",
        observation: wrapperObservation([512001], [512001]),
    }),
    "bond-success": Object.freeze({
        owner: "character/receive_bond_token",
        boundary: "best-effort-in-tx",
        observation: contextObservation("best-effort-context", [263002]),
    }),
    "learn-mana-final-node": Object.freeze({
        owner: "character/learn_mana_node",
        boundary: "strict-in-tx",
        observation: contextObservation("strict-context", [341005]),
    }),
    "exchange-star-crumb": Object.freeze({
        owner: "exchange/star_crumb",
        boundary: "best-effort-post-commit",
        observation: wrapperObservation([], []),
    }),
    "gacha-exchange-character": Object.freeze({
        owner: "gacha/exchange_character",
        boundary: "best-effort-post-commit",
        observation: wrapperObservation([151009], [151009]),
    }),
    "gacha-exec": Object.freeze({
        owner: "gacha/exec",
        boundary: "best-effort-post-commit",
        observation: wrapperObservation([], [111001]),
    }),
    "mana-item-sell": Object.freeze({
        owner: "item/sell",
        boundary: "best-effort-post-commit",
        observation: wrapperObservation([], [], ["player"]),
    }),
    "mail-receive": Object.freeze({
        owner: "mail/receive",
        boundary: "best-effort-in-tx",
        observation: contextObservation("best-effort-context", [], ["player"]),
    }),
    "mail-receive-all": Object.freeze({
        owner: "mail/receive_all",
        boundary: "best-effort-in-tx",
        observation: contextObservation("best-effort-context", [], ["player"]),
    }),
    "category9-update-progress": Object.freeze({
        owner: "mission/update_mission_progress",
        boundary: "best-effort-post-commit",
        observation: wrapperObservation([263002], []),
    }),
    "pass-card-receive-all": Object.freeze({
        owner: "pass_card/receive_all",
        boundary: "best-effort-post-commit",
        observation: wrapperObservation([], [], ["player"]),
    }),
    "raid-event-summary": Object.freeze({
        owner: "raid_event/summary",
        boundary: "best-effort-post-commit",
        observation: wrapperObservation([], [], ["player"]),
    }),
    "shop-buy": Object.freeze({
        owner: "shop/buy",
        boundary: "best-effort-post-commit",
        observation: wrapperObservation([341005], [341005]),
    }),
    "shop-bulk-buy": Object.freeze({
        owner: "shop/bulk_buy",
        boundary: "best-effort-post-commit",
        observation: wrapperObservation([341005, 341006], [341005, 341006]),
    }),
    "story-finish": Object.freeze({
        owner: "story_quest/finish",
        boundary: "best-effort-in-tx",
        observation: contextObservation("best-effort-context", [], ["questProgress:3"]),
    }),
    "tutorial-step-15": Object.freeze({
        owner: "tutorial/update_step:15",
        boundary: "best-effort-in-tx",
        observation: contextObservation("best-effort-context", [251001]),
    }),
    "tutorial-step-16": Object.freeze({
        owner: "tutorial/update_step:16",
        boundary: "best-effort-in-tx",
        observation: contextObservation("best-effort-context", [243001]),
    }),
})

const AWAKE_OWNER_FOCUSED_SCENARIO_KEYS = Object.freeze(Object.keys(OWNER_CONTRACTS))

const AWAKE_OWNER_RUNTIME_EVIDENCE_REGISTRY = Object.freeze(Object.fromEntries(
    Object.entries(OWNER_CONTRACTS).map(([scenarioName, contract]) => [
        scenarioName,
        Object.freeze({
            boundary: contract.boundary,
            owners: Object.freeze([contract.owner]),
            scenarios: Object.freeze([scenarioName]),
            seedContract: Object.freeze({
                characterSeeds: contract.observation.characterSeeds,
                factSeeds: contract.observation.factSeeds,
                directMissionSeeds: contract.observation.directMissionSeeds,
                ...(contract.seedNote === undefined ? {} : { runtimeNote: contract.seedNote }),
            }),
        }),
    ]),
))

const AWAKE_OWNER_SQL_UPPER_BOUND_REGISTRY = Object.freeze(Object.fromEntries(
    Object.entries(AWAKE_OWNER_RUNTIME_EVIDENCE_REGISTRY).map(([key, entry]) => [
        key,
        Object.freeze({ scenarios: entry.scenarios, seedContract: entry.seedContract }),
    ]),
))

function normalizeCharacterList(characterList) {
    return (characterList ?? []).map(character => ({
        characterId: character.character_id,
        ...(character.mana_board_awake === undefined
            ? {}
            : { manaBoardAwake: character.mana_board_awake }),
    })).sort((left, right) => left.characterId - right.characterId)
}

function commonState(runtime, playerId, extra = {}) {
    const player = runtime.playerDomain.getPlayerSync(playerId)
    const characters = runtime.characterDomain.getPlayerCharactersSync(playerId)
    const missions = runtime.missionDomain.getPlayerCategoryMissionsSync(playerId, 9)
    const unlocks = runtime.awakeDomain.getPlayerCharacterAwakeUnlocksSync(playerId)
    return {
        player: player === null ? null : {
            bondToken: player.bondToken,
            expPool: player.expPool,
            freeMana: player.freeMana,
            freeVmoney: player.freeVmoney,
            starCrumb: player.starCrumb,
            totalManaObtained: player.totalManaObtained,
            tutorialStep: player.tutorialStep,
            vmoney: player.vmoney,
        },
        characters: Object.entries(characters).map(([characterId, character]) => ({
            characterId: Number(characterId),
            evolutionLevel: character.evolutionLevel,
            exp: character.exp,
            stack: character.stack,
        })).sort((left, right) => left.characterId - right.characterId),
        items: Object.entries(runtime.itemDomain.getPlayerItemsSync(playerId))
            .map(([itemId, count]) => [Number(itemId), count])
            .sort((left, right) => left[0] - right[0]),
        category9: Object.entries(missions).map(([missionId, mission]) => [
            Number(missionId),
            mission.progress,
        ]).sort((left, right) => left[0] - right[0]),
        unlocks: [...unlocks.entries()].map(([characterId, levels]) => [
            Number(characterId),
            Object.entries(levels).map(([board, level]) => [Number(board), level])
                .sort((left, right) => left[0] - right[0]),
        ]).sort((left, right) => left[0] - right[0]),
        ...extra,
    }
}

function routeResult(result) {
    const data = result.body?.data ?? {}
    return {
        statusCode: result.response.statusCode,
        characterList: normalizeCharacterList(data.character_list),
    }
}

function addMail(runtime, playerId, type, number) {
    return runtime.mailDomain.insertMailSync(playerId, {
        reason_id: 0,
        subject: "owner focused evidence",
        description: null,
        type,
        type_id: null,
        number,
        receive_time: "0000-00-00 00:00:00",
        create_time: "2024-08-14 12:00:00",
        reward_period_limited: 0,
        reward_limit_time: null,
    })
}

function scenario(name, implementation) {
    const contract = OWNER_CONTRACTS[name]
    return Object.freeze({
        name,
        owner: contract.owner,
        boundary: contract.boundary,
        runtimeEvidenceKey: name,
        publicationObservation: contract.observation,
        characterSeeds: contract.observation.characterSeeds,
        factSeeds: contract.observation.factSeeds,
        directMissionSeeds: contract.observation.directMissionSeeds,
        snapshotSource: "none",
        freshPostWriteEvaluationRequired: true,
        rereadReason: name === "single-finish" ? SINGLE_REREAD_REASON : FRESH_REREAD_REASON,
        ...implementation,
    })
}

function createAwakeOwnerFocusedScenarios(runtime) {
    const fixture = runtime.fixture
    const awakeCharacterId = fixture.AWAKE_CHARACTER_ID
    const manaThreshold = fixture.AWAKE_MANA_THRESHOLD
    const post = (prefix, route, payload) => fixture.focused.post(prefix, route, payload)

    return [
        scenario("single-finish", {
            async prepare() {
                const player = await fixture.createPlayer("owner-focused-single")
                fixture.prepareForManaUnlock(player.playerId, manaThreshold - 1)
                const playId = "awake-owner-focused-single"
                fixture.insertActiveQuest(player.playerId, {
                    questId: fixture.MAIN_QUEST_ID, category: 1, useBossBoostPoint: false,
                    useBoostPoint: false, isAutoStartMode: false, isMulti: false,
                    coordinatorOrigin: null, playId, continueCount: 0,
                })
                return { ...player, playId }
            },
            request: value => fixture.singleFinishPayload(value.viewerId, value.playId, 1),
            execute: value => fixture.post("/single", "finish", fixture.singleFinishPayload(
                value.viewerId, value.playId, 1,
            )),
            response: (result, measured) => ({
                ...routeResult(result),
                activeQuestRemoved: measured.fixtureActiveQuestRemoved,
                category9Evaluations: measured.category9Evaluations,
            }),
            state: value => commonState(runtime, value.playerId, {
                activeQuestPresent: fixture.activeQuests[value.playerId] !== undefined,
            }),
        }),
        scenario("multi-finish", {
            async prepare() {
                const player = await fixture.createPlayer("owner-focused-multi")
                fixture.prepareForManaUnlock(player.playerId, manaThreshold - 1)
                return { ...player, playId: "awake-owner-focused-multi" }
            },
            request: value => ({ viewerId: value.viewerId, playId: value.playId, characterId: 1 }),
            execute: value => fixture.runMultiSettlement(
                value.playerId, value.viewerId, value.playId, 1,
            ),
            response: (result, measured) => ({
                characterList: normalizeCharacterList(result.characterList),
                activeQuestRemoved: measured.fixtureActiveQuestRemoved,
            }),
            state: value => commonState(runtime, value.playerId, {
                activeQuestPresent: fixture.activeQuests[value.playerId] !== undefined,
            }),
        }),
        scenario("active-mission-receive", {
            async prepare() {
                const player = await fixture.createPlayer("owner-focused-active")
                fixture.prepareForManaUnlock(player.playerId, manaThreshold - fixture.ACTIVE_MANA_REWARD)
                runtime.missionDomain.updatePlayerActiveMissionSync(
                    player.playerId, fixture.ACTIVE_MISSION_ID, 1,
                )
                runtime.missionDomain.updatePlayerActiveMissionStageSync(
                    player.playerId, 1, fixture.ACTIVE_MISSION_ID, false,
                )
                return player
            },
            request: value => ({
                viewer_id: value.viewerId,
                api_count: 1,
                active_mission_list: [{ mission_id: fixture.ACTIVE_MISSION_ID, stages: [1] }],
            }),
            execute: value => fixture.post("/active", "receive", {
                viewer_id: value.viewerId,
                api_count: 1,
                active_mission_list: [{ mission_id: fixture.ACTIVE_MISSION_ID, stages: [1] }],
            }),
            response: routeResult,
            state: value => commonState(runtime, value.playerId, {
                activeMission: runtime.missionDomain.getPlayerActiveMissionsSync(value.playerId)
                    [fixture.ACTIVE_MISSION_ID] ?? null,
            }),
        }),
        scenario("box-gacha-exec", {
            async prepare() {
                const player = await fixture.createPlayer("owner-focused-box")
                runtime.itemDomain.givePlayerItemSync(player.playerId, 999001, 10)
                return player
            },
            request: value => ({
                viewer_id: value.viewerId, box_gacha_id: 99001, box_id: 1,
                number: 1, stop_on_featured_rewards: false, api_count: 1,
            }),
            execute: value => post("/box-gacha", "exec", {
                viewer_id: value.viewerId, box_gacha_id: 99001, box_id: 1,
                number: 1, stop_on_featured_rewards: false, api_count: 1,
            }),
            response: routeResult,
            state: value => commonState(runtime, value.playerId, {
                boxDraws: runtime.getDb().prepare(`
                    SELECT box_id, reset_times, remaining_number, is_closed
                    FROM players_box_gacha
                    WHERE player_id = ? ORDER BY box_id
                `).all(value.playerId),
            }),
        }),
        scenario("character-town-grant", {
            async prepare() {
                const player = await fixture.createPlayer("owner-focused-town")
                const unlocked = await fixture.post("/story", "finish", {
                    category: 1, quest_id: 1008004, party_id: 1,
                    viewer_id: player.viewerId, api_count: 1,
                })
                if (unlocked.response.statusCode !== 200) throw new Error(unlocked.response.body)
                return player
            },
            request: value => ({ character_id: 512001, viewer_id: value.viewerId, api_count: 2 }),
            execute: value => post("/character", "add_character_from_town", {
                character_id: 512001, viewer_id: value.viewerId, api_count: 2,
            }),
            response: routeResult,
            state: value => commonState(runtime, value.playerId),
        }),
        scenario("bond-success", {
            async prepare() {
                const player = await fixture.createPlayer("owner-focused-bond")
                fixture.prepareForManaUnlock(player.playerId, manaThreshold)
                runtime.characterDomain.updatePlayerCharacterBondTokenSync(
                    player.playerId, awakeCharacterId, { manaBoardIndex: 1, status: 1 },
                )
                return player
            },
            request: value => ({
                viewer_id: value.viewerId, character_id: awakeCharacterId,
                mana_board_index: 1, api_count: 1,
            }),
            execute: value => post("/bond", "receive_bond_token", {
                viewer_id: value.viewerId, character_id: awakeCharacterId,
                mana_board_index: 1, api_count: 1,
            }),
            response: routeResult,
            state: value => commonState(runtime, value.playerId, {
                bondTokens: runtime.characterDomain.getPlayerCharacterSync(
                    value.playerId, awakeCharacterId,
                ).bondTokenList,
            }),
        }),
        scenario("learn-mana-final-node", {
            async prepare() {
                const player = await fixture.createPlayer("owner-focused-mana")
                const characterId = 341005
                runtime.characterDomain.insertDefaultPlayerCharacterSync(player.playerId, characterId)
                const character = runtime.assets.getCharacterDataSync(characterId)
                runtime.characterDomain.updatePlayerCharacterSync(player.playerId, characterId, {
                    exp: runtime.characterExpCaps[character.rarity][0],
                })
                const nodes = Object.keys(runtime.assets.getCharacterManaNodesSync(characterId, 1))
                    .map(Number).sort((a, b) => a - b)
                const finalNodeId = nodes.at(-1)
                runtime.characterDomain.insertPlayerCharacterManaNodesSync(
                    player.playerId, characterId, nodes.slice(0, -1),
                )
                for (const [missionId, progress] of [[3410051, 1], [3410052, 5], [3410053, 5]]) {
                    runtime.missionDomain.updatePlayerCategoryMissionSync(
                        player.playerId, 9, missionId, progress,
                    )
                }
                const node = runtime.assets.getCharacterManaNodesSync(characterId, 1)[finalNodeId]
                runtime.playerDomain.updatePlayerSync({
                    id: player.playerId, freeMana: node.manaCost, paidMana: 0,
                })
                for (const [itemId, amount] of Object.entries(node.items)) {
                    runtime.itemDomain.givePlayerItemSync(player.playerId, itemId, amount)
                }
                return { ...player, characterId, finalNodeId }
            },
            request: value => ({
                viewer_id: value.viewerId, character_id: value.characterId,
                mana_node_multiplied_id_list: [value.finalNodeId], api_count: 1,
            }),
            execute: value => post("/mana", "learn_mana_node", {
                viewer_id: value.viewerId, character_id: value.characterId,
                mana_node_multiplied_id_list: [value.finalNodeId], api_count: 1,
            }),
            response: routeResult,
            state: value => commonState(runtime, value.playerId, {
                learnedNodes: runtime.characterDomain.getPlayerCharacterManaNodesSync(
                    value.playerId, value.characterId,
                ),
            }),
        }),
        scenario("exchange-star-crumb", {
            async prepare() {
                const player = await fixture.createPlayer("owner-focused-exchange")
                runtime.playerDomain.updatePlayerSync({ id: player.playerId, starCrumb: 1000 })
                return player
            },
            request: value => ({ viewer_id: value.viewerId, exchange_id: 9000001, api_count: 1 }),
            execute: value => post("/exchange", "star_crumb", {
                viewer_id: value.viewerId, exchange_id: 9000001, api_count: 1,
            }),
            response: routeResult,
            state: value => commonState(runtime, value.playerId),
        }),
        scenario("gacha-exchange-character", {
            async prepare() {
                const player = await fixture.createPlayer("owner-focused-gacha-exchange")
                runtime.gachaDomain.insertPlayerGachaInfoSync(player.playerId, {
                    gachaId: 29, isAccountFirst: false, isDailyFirst: false,
                    gachaExchangePoint: 250,
                })
                return player
            },
            request: value => ({
                viewer_id: value.viewerId, gacha_id: 29, character_id: 151009, api_count: 1,
            }),
            execute: value => post("/gacha", "exchange_character", {
                viewer_id: value.viewerId, gacha_id: 29, character_id: 151009, api_count: 1,
            }),
            response: routeResult,
            state: value => commonState(runtime, value.playerId, {
                gacha: runtime.gachaDomain.getPlayerGachaInfoSync(value.playerId, 29),
            }),
        }),
        scenario("gacha-exec", {
            async prepare() {
                const player = await fixture.createPlayer("owner-focused-gacha-exec")
                runtime.playerDomain.updatePlayerSync({
                    id: player.playerId, freeVmoney: 1000, vmoney: 0,
                })
                return player
            },
            request: value => ({
                viewer_id: value.viewerId, gacha_id: 1, payment_type: 1,
                number_of_exec: 1, type: 1, api_count: 1,
            }),
            execute: value => post("/gacha", "exec", {
                viewer_id: value.viewerId, gacha_id: 1, payment_type: 1,
                number_of_exec: 1, type: 1, api_count: 1,
            }),
            response: routeResult,
            state: value => commonState(runtime, value.playerId, {
                gacha: runtime.gachaDomain.getPlayerGachaInfoSync(value.playerId, 1),
            }),
        }),
        scenario("mana-item-sell", {
            async prepare() {
                const player = await fixture.createPlayer("owner-focused-item-sell")
                fixture.prepareForManaUnlock(player.playerId, manaThreshold - 5)
                runtime.itemDomain.givePlayerItemSync(player.playerId, 1, 1)
                return player
            },
            request: value => ({
                viewer_id: value.viewerId, item_id: 1, sell_number: 1, api_count: 1,
            }),
            execute: value => post("/item", "sell", {
                viewer_id: value.viewerId, item_id: 1, sell_number: 1, api_count: 1,
            }),
            response: routeResult,
            state: value => commonState(runtime, value.playerId),
        }),
        ...["mail-receive", "mail-receive-all"].map((name, index) => scenario(name, {
            async prepare() {
                const player = await fixture.createPlayer(`owner-focused-${name}`)
                fixture.prepareForManaUnlock(player.playerId, manaThreshold - (index + 2))
                const mailIds = [
                    addMail(runtime, player.playerId, runtime.mailDomain.MailType.FREE_MANA, index + 2),
                ]
                return { ...player, mailIds }
            },
            request: value => name === "mail-receive"
                ? { viewer_id: value.viewerId, mail_id: value.mailIds[0] }
                : { viewer_id: value.viewerId, mail_ids: value.mailIds },
            execute: value => post("/mail", name === "mail-receive" ? "receive" : "receive_all",
                name === "mail-receive"
                    ? { viewer_id: value.viewerId, mail_id: value.mailIds[0] }
                    : { viewer_id: value.viewerId, mail_ids: value.mailIds }),
            response: routeResult,
            state: value => commonState(runtime, value.playerId, {
                mails: runtime.getDb().prepare(`
                    SELECT id,
                        CASE WHEN receive_time = '0000-00-00 00:00:00' THEN 0 ELSE 1 END AS received
                    FROM players_mails
                    WHERE player_id = ? ORDER BY id
                `).all(value.playerId),
            }),
        })),
        scenario("category9-update-progress", {
            async prepare() {
                const player = await fixture.createPlayer("owner-focused-category9")
                runtime.characterDomain.insertDefaultPlayerCharacterSync(player.playerId, awakeCharacterId)
                return player
            },
            request: value => ({
                viewer_id: value.viewerId, api_count: 1,
                mission_param_list: [{ mission_pattern: "twitter_check", progress_value: 1 }],
            }),
            execute: value => post("/mission", "update_mission_progress", {
                viewer_id: value.viewerId, api_count: 1,
                mission_param_list: [{ mission_pattern: "twitter_check", progress_value: 1 }],
            }),
            response: routeResult,
            state: value => commonState(runtime, value.playerId),
        }),
        scenario("pass-card-receive-all", {
            async prepare() {
                const player = await fixture.createPlayer("owner-focused-pass-card")
                fixture.prepareForManaUnlock(player.playerId, manaThreshold - 20_000)
                runtime.passCardDomain.addPlayerPassCardPointSync(player.playerId, 3, 400)
                return player
            },
            request: value => ({
                viewer_id: value.viewerId, pass_card_id: 3, all_receive: [],
                reward1_receive: [124], reward2_receive: [],
            }),
            execute: value => fixture.post("/pass-card", "receive_all", {
                viewer_id: value.viewerId, pass_card_id: 3, all_receive: [],
                reward1_receive: [124], reward2_receive: [],
            }),
            response: routeResult,
            state: value => commonState(runtime, value.playerId, {
                rewardRecords: runtime.passCardDomain.getPlayerPassCardRewardRecordsSync(
                    value.playerId, 3,
                ),
            }),
        }),
        scenario("raid-event-summary", {
            async prepare() {
                const player = await fixture.createPlayer("owner-focused-raid")
                fixture.prepareForManaUnlock(player.playerId, manaThreshold - 500)
                runtime.raidEventDomain.upsertRaidEventBossStateSync(4, {
                    weightedKillCount: 0, totalKillCount: 1,
                })
                return player
            },
            request: value => ({ viewer_id: value.viewerId, event_id: 4, api_count: 1 }),
            execute: value => fixture.post("/raid", "summary", {
                viewer_id: value.viewerId, event_id: 4, api_count: 1,
            }),
            response: routeResult,
            state: value => commonState(runtime, value.playerId, {
                receivedUpTo: runtime.raidEventDomain.getPlayerRaidEventSync(
                    value.playerId, 4,
                )?.receivedUpTo ?? 0,
            }),
        }),
        ...["shop-buy", "shop-bulk-buy"].map(name => scenario(name, {
            async prepare() {
                const player = await fixture.createPlayer(`owner-focused-${name}`)
                runtime.playerDomain.updatePlayerSync({ id: player.playerId, freeVmoney: 10 })
                return player
            },
            request: value => name === "shop-buy"
                ? { viewer_id: value.viewerId, shop_type: 8, shop_item_id: 880001, number: 1 }
                : { viewer_id: value.viewerId, shop_type: 4, buy_item_list: { 880001: 1, 880002: 1 } },
            execute: value => post("/shop", name === "shop-buy" ? "buy" : "bulk_buy",
                name === "shop-buy"
                    ? { viewer_id: value.viewerId, shop_type: 8, shop_item_id: 880001, number: 1 }
                    : { viewer_id: value.viewerId, shop_type: 4, buy_item_list: { 880001: 1, 880002: 1 } }),
            response: routeResult,
            state: value => commonState(runtime, value.playerId, {
                purchases: runtime.getDb().prepare(`
                    SELECT shop_type, shop_item_id, period_type, period_key, count
                    FROM players_shop_purchase_counters
                    WHERE player_id = ? ORDER BY shop_item_id, period_type
                `).all(value.playerId),
            }),
        })),
        scenario("story-finish", {
            async prepare() {
                const player = await fixture.createPlayer("owner-focused-story")
                fixture.prepareForStoryUnlock(player.playerId)
                return player
            },
            request: value => ({
                category: 3, quest_id: fixture.CHARACTER_QUEST_IDS[2], party_id: 1,
                viewer_id: value.viewerId, api_count: 1,
            }),
            execute: value => fixture.post("/story", "finish", {
                category: 3, quest_id: fixture.CHARACTER_QUEST_IDS[2], party_id: 1,
                viewer_id: value.viewerId, api_count: 1,
            }),
            response: routeResult,
            state: value => commonState(runtime, value.playerId, {
                finished: runtime.questDomain.getPlayerSingleQuestProgressSync(
                    value.playerId, 3, fixture.CHARACTER_QUEST_IDS[2],
                )?.finished ?? false,
            }),
        }),
        ...[["tutorial-step-15", 14], ["tutorial-step-16", 15]].map(([name, step]) => scenario(name, {
            async prepare() {
                const player = await fixture.createPlayer(`owner-focused-${name}`)
                runtime.playerDomain.updatePlayerSync({
                    id: player.playerId, tutorialStep: step, tutorialSkipFlag: false,
                    freeVmoney: 1000,
                })
                return player
            },
            request: value => ({
                viewer_id: value.viewerId, api_count: 1, statistics: {}, skip: false,
                step, ...(step === 14 ? { gacha_id: 1 } : {}),
            }),
            execute: value => post("/tutorial", "update_step", {
                viewer_id: value.viewerId, api_count: 1, statistics: {}, skip: false,
                step, ...(step === 14 ? { gacha_id: 1 } : {}),
            }),
            response: routeResult,
            state: value => commonState(runtime, value.playerId, {
                receipts: runtime.getDb().prepare(`
                    SELECT completed_step FROM players_tutorial_step_receipts
                    WHERE player_id = ? ORDER BY completed_step
                `).all(value.playerId),
            }),
        })),
    ]
}

module.exports = {
    AWAKE_OWNER_FOCUSED_SCENARIO_KEYS,
    AWAKE_OWNER_RUNTIME_EVIDENCE_REGISTRY,
    AWAKE_OWNER_SQL_UPPER_BOUND_REGISTRY,
    OWNER_CONTRACTS,
    SINGLE_REREAD_REASON,
    createAwakeOwnerFocusedScenarios,
}
