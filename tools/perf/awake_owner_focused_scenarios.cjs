"use strict"

const SINGLE_REREAD_REASON = "earlier awake settlement precedes later authoritative reward, active-mission, response-state and active-quest writes"

const AWAKE_OWNER_FOCUSED_SCENARIO_KEYS = Object.freeze([
    "candidate-zero",
    "candidate-one",
    "candidate-multiple",
    "learn-mana-final-node",
    "bond-success",
    "category9-update-progress",
    "story-finish",
    "mana-item-sell",
    "reward-grant-post-commit",
    "character-grant-owner",
    "single-finish",
    "pass-card-receive-all",
    "raid-event-summary",
])

function evidence(boundary, owners, scenarios, seedContract) {
    return Object.freeze({
        boundary,
        owners: Object.freeze(owners),
        scenarios: Object.freeze(scenarios),
        seedContract,
    })
}

const AWAKE_OWNER_RUNTIME_EVIDENCE_REGISTRY = Object.freeze({
    "candidate-zero-post-commit": evidence(
        "best-effort-post-commit",
        ["exchange/star_crumb"],
        ["candidate-zero"],
        "empty actual character seed, no changed global facts",
    ),
    "candidate-one-post-commit": evidence(
        "best-effort-post-commit",
        ["gacha/exchange_character", "gacha/exec"],
        ["candidate-one"],
        "one actual reward character, no changed global facts",
    ),
    "candidate-multiple-in-tx": evidence(
        "best-effort-in-tx",
        ["multi/finish", "tutorial/update_step:15", "tutorial/update_step:16"],
        ["candidate-multiple"],
        "bounded actual owner characters at an in-transaction publication boundary",
    ),
    "reward-grant-in-tx": evidence(
        "best-effort-in-tx",
        ["active_mission/receive", "mail/receive", "mail/receive_all"],
        ["candidate-one"],
        "actual reward characters plus reward-derived FactKey seeds",
    ),
    "reward-grant-post-commit": evidence(
        "best-effort-post-commit",
        ["box_gacha/exec", "shop/buy", "shop/bulk_buy"],
        ["reward-grant-post-commit"],
        "actual reward characters plus reward-derived FactKey seeds",
    ),
    "character-grant-post-commit": evidence(
        "best-effort-post-commit",
        ["character/add_character_from_town"],
        ["character-grant-owner"],
        "one actually granted character, no changed global facts",
    ),
    "learn-mana-strict": evidence(
        "strict-in-tx",
        ["character/learn_mana_node"],
        ["learn-mana-final-node"],
        "target character after the final mana-node write",
    ),
    "bond-in-tx": evidence(
        "best-effort-in-tx",
        ["character/receive_bond_token"],
        ["bond-success"],
        "target character after the bond-token write",
    ),
    "category9-post-commit": evidence(
        "best-effort-post-commit",
        ["mission/update_mission_progress"],
        ["category9-update-progress"],
        "characters derived from actually updated Category 9 missions",
    ),
    "mana-item-post-commit": evidence(
        "best-effort-post-commit",
        ["item/sell"],
        ["mana-item-sell"],
        "empty character seed plus the changed player FactKey",
    ),
    "story-in-tx": evidence(
        "best-effort-in-tx",
        ["story_quest/finish"],
        ["story-finish"],
        "actual story/reward characters plus changed quest and reward facts",
    ),
    "single-in-tx": evidence(
        "best-effort-in-tx",
        ["single/finish"],
        ["single-finish"],
        "battle party characters, direct missions and post-settlement changed facts",
    ),
    "pass-card-post-commit": evidence(
        "best-effort-post-commit",
        ["pass_card/receive_all"],
        ["pass-card-receive-all"],
        "empty character seed plus pass-card reward FactKey seeds",
    ),
    "raid-summary-post-commit": evidence(
        "best-effort-post-commit",
        ["raid_event/summary"],
        ["raid-event-summary"],
        "empty character seed plus raid summary reward FactKey seeds",
    ),
})

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
            freeMana: player.freeMana,
            totalManaObtained: player.totalManaObtained,
        },
        characters: Object.entries(characters).map(([characterId, character]) => ({
            characterId: Number(characterId),
            evolutionLevel: character.evolutionLevel,
            exp: character.exp,
            stack: character.stack,
        })).sort((left, right) => left.characterId - right.characterId),
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

function prepareReadyCharacter(runtime, playerId, characterId, progressByMission = {}) {
    if (runtime.characterDomain.getPlayerCharacterSync(playerId, characterId) === null) {
        runtime.characterDomain.insertDefaultPlayerCharacterSync(playerId, characterId)
    }
    const character = runtime.assets.getCharacterDataSync(characterId)
    runtime.characterDomain.updatePlayerCharacterSync(playerId, characterId, {
        exp: runtime.characterExpCaps[character.rarity][0],
    })
    runtime.characterDomain.insertPlayerCharacterManaNodesSync(
        playerId,
        characterId,
        Object.keys(runtime.assets.getCharacterManaNodesSync(characterId, 1)).map(Number),
    )
    for (const [missionId, progress] of Object.entries(progressByMission)) {
        runtime.missionDomain.updatePlayerCategoryMissionSync(
            playerId,
            9,
            Number(missionId),
            progress,
        )
    }
}

function scenario(name, contract, implementation) {
    return Object.freeze({
        name,
        snapshotSource: "none",
        freshPostWriteEvaluationRequired: true,
        ...contract,
        ...implementation,
    })
}

function createAwakeOwnerFocusedScenarios(runtime) {
    const awakeCharacterId = runtime.fixture.AWAKE_CHARACTER_ID
    const secondCharacterId = 341005
    const manaThreshold = runtime.fixture.AWAKE_MANA_THRESHOLD
    const freshReread = "no owner snapshot is injected; load the bounded post-write scope"
    const publish = (playerId, characterSeeds, characterLists, factSeeds = []) => (
        runtime.publishAwakeCharacterListBestEffort(
            playerId,
            characterSeeds,
            characterLists,
            { invalidatedFactKeys: factSeeds },
        )
    )

    return [
        scenario("candidate-zero", {
            characterSeeds: [], factSeeds: [], directMissionSeeds: [], rereadReason: freshReread,
        }, {
            async prepare() {
                return runtime.fixture.createPlayer("owner-focused-candidate-zero")
            },
            request: fixture => ({ operation: "publish", playerId: fixture.playerId, characterSeeds: [] }),
            execute: fixture => publish(fixture.playerId, [], [[]]),
            response: result => ({ characterList: normalizeCharacterList(result) }),
            state: fixture => commonState(runtime, fixture.playerId),
        }),
        scenario("candidate-one", {
            characterSeeds: [awakeCharacterId],
            factSeeds: ["player"],
            directMissionSeeds: [],
            rereadReason: freshReread,
        }, {
            async prepare() {
                const fixture = await runtime.fixture.createPlayer("owner-focused-candidate-one")
                runtime.fixture.prepareForManaUnlock(fixture.playerId, manaThreshold)
                return fixture
            },
            request: fixture => ({
                operation: "transactional-reward-publication",
                playerId: fixture.playerId,
                characterSeeds: [awakeCharacterId],
                factSeeds: ["player"],
            }),
            execute: fixture => runtime.getDb().transaction(() => publish(
                fixture.playerId,
                [awakeCharacterId],
                [[{ character_id: awakeCharacterId }]],
                [{ kind: "player" }],
            ))(),
            response: result => ({ characterList: normalizeCharacterList(result) }),
            state: fixture => commonState(runtime, fixture.playerId),
        }),
        scenario("candidate-multiple", {
            characterSeeds: [awakeCharacterId, secondCharacterId].sort((a, b) => a - b),
            factSeeds: [], directMissionSeeds: [], rereadReason: freshReread,
        }, {
            async prepare() {
                const fixture = await runtime.fixture.createPlayer("owner-focused-candidate-multiple")
                runtime.fixture.prepareForManaUnlock(fixture.playerId, manaThreshold)
                prepareReadyCharacter(runtime, fixture.playerId, secondCharacterId, {
                    3410051: 1, 3410052: 5, 3410053: 5, 3410054: 3,
                })
                return fixture
            },
            request: fixture => ({
                operation: "transactional-multi-owner-publication",
                playerId: fixture.playerId,
                characterSeeds: [awakeCharacterId, secondCharacterId].sort((a, b) => a - b),
            }),
            execute: fixture => runtime.getDb().transaction(() => publish(
                fixture.playerId,
                [awakeCharacterId, secondCharacterId],
                [[
                    { character_id: awakeCharacterId },
                    { character_id: secondCharacterId },
                ]],
            ))(),
            response: result => ({ characterList: normalizeCharacterList(result) }),
            state: fixture => commonState(runtime, fixture.playerId),
        }),
        scenario("learn-mana-final-node", {
            characterSeeds: [awakeCharacterId],
            factSeeds: [], directMissionSeeds: [], rereadReason: freshReread,
        }, {
            async prepare() {
                const fixture = await runtime.fixture.createPlayer("owner-focused-learn-mana")
                runtime.characterDomain.insertDefaultPlayerCharacterSync(fixture.playerId, awakeCharacterId)
                const character = runtime.assets.getCharacterDataSync(awakeCharacterId)
                runtime.characterDomain.updatePlayerCharacterSync(fixture.playerId, awakeCharacterId, {
                    exp: runtime.characterExpCaps[character.rarity][0],
                })
                const nodes = Object.keys(runtime.assets.getCharacterManaNodesSync(awakeCharacterId, 1))
                    .map(Number).sort((left, right) => left - right)
                runtime.characterDomain.insertPlayerCharacterManaNodesSync(
                    fixture.playerId,
                    awakeCharacterId,
                    nodes.slice(0, -1),
                )
                runtime.missionDomain.updatePlayerCategoryMissionSync(fixture.playerId, 9, 2630021, 3)
                runtime.missionDomain.updatePlayerCategoryMissionSync(fixture.playerId, 9, 2630023, 1)
                runtime.playerDomain.updatePlayerSync({
                    id: fixture.playerId,
                    totalManaObtained: manaThreshold,
                })
                return { ...fixture, finalNodeId: nodes.at(-1) }
            },
            request: fixture => ({
                operation: "learn-mana-final-node",
                playerId: fixture.playerId,
                characterId: awakeCharacterId,
                nodeId: fixture.finalNodeId,
            }),
            execute: fixture => runtime.getDb().transaction(() => {
                runtime.characterDomain.insertPlayerCharacterManaNodesSync(
                    fixture.playerId,
                    awakeCharacterId,
                    [fixture.finalNodeId],
                )
                const context = runtime.createAwakeRequestContext({
                    playerId: fixture.playerId,
                    candidateCharacterIds: [awakeCharacterId],
                })
                return runtime.reconcileAwakeUnlockCharacterListStrict(
                    fixture.playerId,
                    [{ character_id: awakeCharacterId }],
                    { context, candidateCharacterIds: [awakeCharacterId] },
                )
            })(),
            response: result => ({ characterList: normalizeCharacterList(result) }),
            state: fixture => commonState(runtime, fixture.playerId, {
                learnedFinalNode: runtime.characterDomain
                    .getPlayerCharacterManaNodesSync(fixture.playerId, awakeCharacterId)
                    .includes(fixture.finalNodeId),
            }),
        }),
        scenario("bond-success", {
            characterSeeds: [awakeCharacterId],
            factSeeds: [], directMissionSeeds: [], rereadReason: freshReread,
        }, {
            async prepare() {
                const fixture = await runtime.fixture.createPlayer("owner-focused-bond")
                runtime.fixture.prepareForManaUnlock(fixture.playerId, manaThreshold)
                runtime.characterDomain.updatePlayerCharacterBondTokenSync(
                    fixture.playerId,
                    awakeCharacterId,
                    { manaBoardIndex: 1, status: 1 },
                )
                return fixture
            },
            request: fixture => ({
                operation: "receive-bond-token",
                playerId: fixture.playerId,
                characterId: awakeCharacterId,
                manaBoardIndex: 1,
            }),
            execute: fixture => runtime.getDb().transaction(() => {
                const before = runtime.playerDomain.getPlayerSync(fixture.playerId)
                runtime.playerDomain.updatePlayerSync({
                    id: fixture.playerId,
                    bondToken: before.bondToken + 1,
                })
                runtime.characterDomain.updatePlayerCharacterBondTokenSync(
                    fixture.playerId,
                    awakeCharacterId,
                    { manaBoardIndex: 1, status: 2 },
                )
                return publish(
                    fixture.playerId,
                    [awakeCharacterId],
                    [[{ character_id: awakeCharacterId }]],
                )
            })(),
            response: result => ({ characterList: normalizeCharacterList(result) }),
            state: fixture => commonState(runtime, fixture.playerId, {
                bondTokens: runtime.characterDomain
                    .getPlayerCharacterSync(fixture.playerId, awakeCharacterId).bondTokenList,
            }),
        }),
        scenario("category9-update-progress", {
            characterSeeds: [awakeCharacterId],
            factSeeds: [], directMissionSeeds: [], rereadReason: freshReread,
        }, {
            async prepare() {
                const fixture = await runtime.fixture.createPlayer("owner-focused-category9")
                prepareReadyCharacter(runtime, fixture.playerId, awakeCharacterId, { 2630023: 1 })
                runtime.playerDomain.updatePlayerSync({
                    id: fixture.playerId,
                    totalManaObtained: manaThreshold,
                })
                return fixture
            },
            request: fixture => ({
                operation: "update-mission-progress",
                playerId: fixture.playerId,
                category: 9,
                missionId: 2630021,
                progress: 3,
            }),
            execute: fixture => {
                runtime.missionDomain.updatePlayerCategoryMissionSync(
                    fixture.playerId, 9, 2630021, 3,
                )
                return publish(fixture.playerId, [awakeCharacterId], [[]])
            },
            response: result => ({ characterList: normalizeCharacterList(result) }),
            state: fixture => commonState(runtime, fixture.playerId),
        }),
        scenario("story-finish", {
            characterSeeds: [],
            factSeeds: ["questProgress:3"],
            directMissionSeeds: [],
            rereadReason: freshReread,
        }, {
            async prepare() {
                const fixture = await runtime.fixture.createPlayer("owner-focused-story")
                runtime.fixture.prepareForStoryUnlock(fixture.playerId)
                return fixture
            },
            request: fixture => ({
                category: 3,
                quest_id: runtime.fixture.CHARACTER_QUEST_IDS[2],
                party_id: 1,
                viewer_id: fixture.viewerId,
                api_count: 1,
            }),
            execute: fixture => runtime.fixture.post("/story", "finish", {
                category: 3,
                quest_id: runtime.fixture.CHARACTER_QUEST_IDS[2],
                party_id: 1,
                viewer_id: fixture.viewerId,
                api_count: 1,
            }),
            response: result => ({
                statusCode: result.response.statusCode,
                characterList: normalizeCharacterList(result.body.data.character_list),
                storyJoined: result.body.data.story_join_character_id_list,
            }),
            state: fixture => commonState(runtime, fixture.playerId, {
                finalQuestFinished: runtime.questDomain.getPlayerSingleQuestProgressSync(
                    fixture.playerId, 3, runtime.fixture.CHARACTER_QUEST_IDS[2],
                )?.finished ?? false,
            }),
        }),
        scenario("mana-item-sell", {
            characterSeeds: [],
            factSeeds: ["player"],
            directMissionSeeds: [],
            rereadReason: freshReread,
        }, {
            async prepare() {
                const fixture = await runtime.fixture.createPlayer("owner-focused-item-sell")
                runtime.fixture.prepareForManaUnlock(fixture.playerId, manaThreshold - 5)
                runtime.itemDomain.givePlayerItemSync(fixture.playerId, 1, 1)
                return fixture
            },
            request: fixture => ({
                operation: "sell-item",
                playerId: fixture.playerId,
                itemId: 1,
                sellNumber: 1,
            }),
            execute: fixture => {
                const sale = runtime.sellItemSync(fixture.playerId, 1, 1)
                if (!sale.ok) throw new Error(sale.error)
                const characterList = publish(
                    fixture.playerId,
                    [],
                    [[]],
                    [{ kind: "player" }],
                )
                return { sale, characterList }
            },
            response: result => ({
                freeMana: result.sale.freeMana,
                itemCount: result.sale.newCount,
                characterList: normalizeCharacterList(result.characterList),
            }),
            state: fixture => commonState(runtime, fixture.playerId, {
                item1: runtime.itemDomain.getPlayerItemSync(fixture.playerId, 1) ?? 0,
            }),
        }),
        scenario("reward-grant-post-commit", {
            characterSeeds: [secondCharacterId],
            factSeeds: ["player"],
            directMissionSeeds: [],
            rereadReason: freshReread,
        }, {
            async prepare() {
                const fixture = await runtime.fixture.createPlayer("owner-focused-reward-post-commit")
                runtime.fixture.prepareForManaUnlock(fixture.playerId, manaThreshold - 5)
                return fixture
            },
            request: fixture => ({
                operation: "reward-grant-post-commit",
                playerId: fixture.playerId,
                characterId: secondCharacterId,
                mana: 5,
            }),
            execute: fixture => {
                const grant = runtime.getDb().transaction(() => {
                    const before = runtime.playerDomain.getPlayerSync(fixture.playerId)
                    runtime.playerDomain.updatePlayerSync({
                        id: fixture.playerId,
                        freeMana: before.freeMana + 5,
                        totalManaObtained: before.totalManaObtained + 5,
                    })
                    return runtime.givePlayerCharacterSync(fixture.playerId, secondCharacterId)
                })()
                if (!grant?.character) throw new Error("owner-focused reward character grant failed")
                const characterList = publish(
                    fixture.playerId,
                    [secondCharacterId],
                    [[grant.character]],
                    [{ kind: "player" }],
                )
                return { grant, characterList }
            },
            response: result => ({
                characterList: normalizeCharacterList(result.characterList),
                duplicateItem: result.grant.item ?? null,
            }),
            state: fixture => commonState(runtime, fixture.playerId),
        }),
        scenario("character-grant-owner", {
            characterSeeds: [secondCharacterId],
            factSeeds: [], directMissionSeeds: [], rereadReason: freshReread,
        }, {
            async prepare() {
                return runtime.fixture.createPlayer("owner-focused-character-grant")
            },
            request: fixture => ({
                operation: "grant-character",
                playerId: fixture.playerId,
                characterId: secondCharacterId,
            }),
            execute: fixture => {
                const grant = runtime.givePlayerCharacterSync(fixture.playerId, secondCharacterId)
                if (!grant?.character) throw new Error("owner-focused character grant failed")
                const characterList = publish(
                    fixture.playerId,
                    [secondCharacterId],
                    [[grant.character]],
                )
                return { grant, characterList }
            },
            response: result => ({
                characterList: normalizeCharacterList(result.characterList),
                duplicateItem: result.grant.item ?? null,
            }),
            state: fixture => commonState(runtime, fixture.playerId),
        }),
        scenario("single-finish", {
            characterSeeds: [1],
            factSeeds: ["passState:3", "player"],
            directMissionSeeds: [],
            rereadReason: SINGLE_REREAD_REASON,
        }, {
            async prepare() {
                const fixture = await runtime.fixture.createPlayer("owner-focused-single")
                runtime.fixture.prepareForManaUnlock(fixture.playerId, manaThreshold - 1)
                const playId = "awake-owner-focused-single"
                runtime.fixture.insertActiveQuest(fixture.playerId, {
                    questId: runtime.fixture.MAIN_QUEST_ID,
                    category: 1,
                    useBossBoostPoint: false,
                    useBoostPoint: false,
                    isAutoStartMode: false,
                    isMulti: false,
                    coordinatorOrigin: null,
                    playId,
                    continueCount: 0,
                })
                return { ...fixture, playId }
            },
            request: fixture => runtime.fixture.singleFinishPayload(
                fixture.viewerId,
                fixture.playId,
                1,
            ),
            execute: fixture => runtime.fixture.post(
                "/single",
                "finish",
                runtime.fixture.singleFinishPayload(fixture.viewerId, fixture.playId, 1),
            ),
            response: (result, measurements) => ({
                statusCode: result.response.statusCode,
                characterList: normalizeCharacterList(result.body.data.character_list),
                activeQuestRemoved: measurements.fixtureActiveQuestRemoved,
                category9Evaluations: measurements.category9Evaluations,
            }),
            state: fixture => commonState(runtime, fixture.playerId, {
                activeQuestPresent: runtime.fixture.activeQuests[fixture.playerId] !== undefined,
            }),
        }),
        scenario("pass-card-receive-all", {
            characterSeeds: [],
            factSeeds: ["player"],
            directMissionSeeds: [],
            rereadReason: freshReread,
        }, {
            async prepare() {
                const fixture = await runtime.fixture.createPlayer("owner-focused-pass-card")
                runtime.fixture.prepareForManaUnlock(fixture.playerId, manaThreshold - 20_000)
                runtime.passCardDomain.addPlayerPassCardPointSync(fixture.playerId, 3, 400)
                return fixture
            },
            request: fixture => ({
                viewer_id: fixture.viewerId,
                pass_card_id: 3,
                all_receive: [],
                reward1_receive: [124],
                reward2_receive: [],
            }),
            execute: fixture => runtime.fixture.post("/pass-card", "receive_all", {
                viewer_id: fixture.viewerId,
                pass_card_id: 3,
                all_receive: [],
                reward1_receive: [124],
                reward2_receive: [],
            }),
            response: result => ({
                statusCode: result.response.statusCode,
                characterList: normalizeCharacterList(result.body.data.character_list),
                received: result.body.data.all_received_record,
                freeMana: result.body.data.user_info.free_mana,
            }),
            state: fixture => commonState(runtime, fixture.playerId, {
                rewardRecords: runtime.passCardDomain
                    .getPlayerPassCardRewardRecordsSync(fixture.playerId, 3),
            }),
        }),
        scenario("raid-event-summary", {
            characterSeeds: [],
            factSeeds: ["player"],
            directMissionSeeds: [],
            rereadReason: freshReread,
        }, {
            async prepare() {
                const fixture = await runtime.fixture.createPlayer("owner-focused-raid")
                runtime.fixture.prepareForManaUnlock(fixture.playerId, manaThreshold - 500)
                runtime.raidEventDomain.upsertRaidEventBossStateSync(4, {
                    weightedKillCount: 0,
                    totalKillCount: 1,
                })
                return fixture
            },
            request: fixture => ({ viewer_id: fixture.viewerId, event_id: 4, api_count: 1 }),
            execute: fixture => runtime.fixture.post("/raid", "summary", {
                viewer_id: fixture.viewerId,
                event_id: 4,
                api_count: 1,
            }),
            response: result => ({
                statusCode: result.response.statusCode,
                characterList: normalizeCharacterList(result.body.data.character_list),
                rewardList: result.body.data.kill_count_reward_data.reward_list,
                itemList: result.body.data.item_list,
                freeMana: result.body.data.user_info.free_mana,
            }),
            state: fixture => commonState(runtime, fixture.playerId, {
                receivedUpTo: runtime.raidEventDomain
                    .getPlayerRaidEventSync(fixture.playerId, 4)?.receivedUpTo ?? 0,
                item100000: runtime.itemDomain.getPlayerItemSync(fixture.playerId, 100000) ?? 0,
            }),
        }),
    ]
}

module.exports = {
    AWAKE_OWNER_FOCUSED_SCENARIO_KEYS,
    AWAKE_OWNER_RUNTIME_EVIDENCE_REGISTRY,
    AWAKE_OWNER_SQL_UPPER_BOUND_REGISTRY,
    SINGLE_REREAD_REASON,
    createAwakeOwnerFocusedScenarios,
}
