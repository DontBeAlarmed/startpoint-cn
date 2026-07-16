import { getDb } from "../db";
import { Player, RawPlayer, MergedPlayerData, PartyCategory, PlayerPartyGroup, Account, PlayerParty, DailyChallengePointListEntry, DailyChallengePointListCampaign, RawDailyChallengePointListEntry, RawDailyChallengePointListCampaign, PlayerRushEventPlayedParty, RawPlayerRushEventPlayedParty, UserRushEventPlayedParty } from "../types";
import { getServerTime, getServerDate } from "../../utils";
import { getDefaultPlayerData, deserializeBoolean, serializeBoolean } from "../utils";
import { getAccountSync } from "./account";
import { getPlayerQuestProgressSync } from "./quest";
import { isNewDay, isNewWeek } from "../../lib/time-utils";
import { takeSnapshot } from "../../lib/mission/snapshot";
import dailyChallengePointLookup from "../../../assets/daily_challenge_point_lookup.json";

type DailyChallengePointLookup = Record<string, { maxPoint: number, isRecovery: boolean, name: string }>

function getDailyChallengePointDefaults(): DailyChallengePointListEntry[] {
    const lookup = dailyChallengePointLookup as DailyChallengePointLookup
    const entries: DailyChallengePointListEntry[] = []
    for (const [idStr, data] of Object.entries(lookup)) {
        entries.push({
            id: Number(idStr),
            point: data.maxPoint,
            campaignList: []
        })
    }
    return entries
}

const expPoolMax = 100000;
import { insertPlayerTriggeredTutorialsSync } from "./tutorial";
import { insertPlayerOptionsSync } from "./option";
import { insertPlayerItemsSync } from "./item";
import { insertPlayerEquipmentListSync } from "./equipment";
import { insertPlayerPartyGroupListSync } from "./party";
import { insertPlayerCharactersSync, insertPlayerCharactersManaNodesSync } from "./character";
import { insertPlayerDrawnQuestsSync, insertPlayerQuestProgressListSync } from "./quest";
import { insertPlayerGachaInfoListSync, insertPlayerGachaCampaignListSync , getPlayerGachaInfoListSync, updatePlayerGachaInfoSync, getPlayerGachaCampaignListSync, updatePlayerGachaCampaignSync } from "./gacha";
import { insertPlayerBoxGachasSync } from "./boxGacha";
import { insertPlayerRushEventListSync, insertPlayerRushEventClearedFolderListSync, insertPlayerRushEventPlayedPartyListSync } from "./rushEvent";
import { insertPlayerClearedRegularMissionListSync, insertPlayerActiveMissionsSync } from "./mission";
import { insertPlayerPeriodicRewardPointsListSync, insertPlayerStartDashExchangeCampaignsSync, insertPlayerMultiSpecialExchangeCampaignsSync } from "./campaign";

/**
 * Gets a player's daily challenge point list based on their id.
 * 
 * @param playerId The ID of the player to get the daily challenge point list of.
 * @returns The player's daily challenge point list.
 */
export function getPlayerDailyChallengePointListSync(
    playerId: number
): DailyChallengePointListEntry[] {

    const rawEntries = getDb().prepare(`
    SELECT id, point
    FROM daily_challenge_point_list_entries
    WHERE player_id = ?
    `).all(playerId) as RawDailyChallengePointListEntry[]

    const rawCampaigns = getDb().prepare(`
    SELECT campaign_id, additional_point, list_entry_id
    FROM daily_challenge_point_list_campaigns
    WHERE player_id = ?
    `).all(playerId) as RawDailyChallengePointListCampaign[]

    const campaignBuckets: Record<number, DailyChallengePointListCampaign[]> = {}

    for (const rawCampaign of rawCampaigns) {
        const listEntryId = rawCampaign.list_entry_id
        let bucket = campaignBuckets[listEntryId]
        if (!bucket) {
            bucket = []
            campaignBuckets[listEntryId] = bucket
        }

        bucket.push({
            campaignId: rawCampaign.campaign_id,
            additionalPoint: rawCampaign.additional_point
        })
    }

    const entries = []
    for (const rawEntry of rawEntries) {
        const id = rawEntry.id
        entries.push({
            id: id,
            point: rawEntry.point,
            campaignList: campaignBuckets[id] || []
        })
    }

    return entries
}

/**
 * Inserts a singular DailyChallengePointListEntry into the database.
 * 
 * @param playerId The ID of the player.
 * @param entry The entry to insert.
 */
function insertPlayerDailyChallengePointListEntrySync(
    playerId: number,
    entry: DailyChallengePointListEntry
) {
    const id = entry.id

    // insert into the list entry table
    getDb().prepare(`
    INSERT INTO daily_challenge_point_list_entries (id, point, player_id)
    VALUES (?, ?, ?)
    `).run(
        id,
        entry.point,
        playerId
    )

    // insert campaigns
    for (const campaign of entry.campaignList) {
        getDb().prepare(`
        INSERT INTO daily_challenge_point_list_campaigns (campaign_id, additional_point, list_entry_id, player_id)
        VALUES (?, ?, ?, ?)
        `).run(
            campaign.campaignId,
            campaign.additionalPoint,
            id,
            playerId
        )
    }
}

/**
 * Batch inserts a list of DailyChallengePointListEntries into the database.
 * 
 * @param playerId The ID of the player.
 * @param entries The entries to insert.
 */
export function insertPlayerDailyChallengePointListSync(
    playerId: number,
    entries: DailyChallengePointListEntry[]
) {
    getDb().transaction(() => {
        for (const entry of entries) {
            insertPlayerDailyChallengePointListEntrySync(playerId, entry)
        }
    })()
}

/**
 * Updates a player's daily challenge point for a specific entry.
 */
export function updatePlayerDailyChallengePointSync(
    playerId: number,
    entryId: number,
    point: number
) {
    getDb().prepare(`
    UPDATE daily_challenge_point_list_entries SET point = ?
    WHERE id = ? AND player_id = ?
    `).run(point, entryId, playerId)
}

/**
 * Inserts a singular item into the player's inventory.
 * 
 * @param playerId The ID of the player.
 * @param itemId The ID of the item to insert.
 * @param amount The amount of the item to insert.
 */
function insertPlayerItemSync(
    playerId: number,
    itemId: number | string,
    amount: number
) {
    getDb().prepare(`
    INSERT INTO players_items (id, amount, player_id)
    VALUES (?, ?, ?)
    `).run(
        Number(itemId),
        amount,
        playerId
    )
}
/**
 * Converts a PlayerRushEventPlayedParty object from database format.
 * 
 * @param serialized The PlayerRushEventPlayedParty in database format.
 * @returns 
 */
export function deserializePlayerRushEventPlayedParty(
    serialized: RawPlayerRushEventPlayedParty
): PlayerRushEventPlayedParty {
    return {
        characterIds: [
            serialized.character_id_1,
            serialized.character_id_2,
            serialized.character_id_3
        ],
        unisonCharacterIds: [
            serialized.unison_character_id_1,
            serialized.unison_character_id_2,
            serialized.unison_character_id_3
        ],
        abilitySoulIds: [
            serialized.ability_soul_id_1,
            serialized.ability_soul_id_2,
            serialized.ability_soul_id_3
        ],
        equipmentIds: [
            serialized.equipment_id_1,
            serialized.equipment_id_2,
            serialized.equipment_id_3
        ],
        evolutionImgLevels: [
            serialized.evolution_img_level_1,
            serialized.evolution_img_level_2,
            serialized.evolution_img_level_3
        ],
        unisonEvolutionImgLevels: [
            serialized.unison_evolution_img_level_1,
            serialized.unison_evolution_img_level_2,
            serialized.unison_evolution_img_level_3
        ],
        battleType: serialized.battle_type,
        round: serialized.round
    }
}

/**
 * Converts a PlayerRushEventPlayedParty into database format.
 * 
 * @param playerId The ID of the player.
 * @param eventId The ID of the rush event.
 * @param deserialized The deserialized rush party to convert.
 * @returns A RawPlayerRushEventPlayedParty
 */
export function serializePlayerRushEventPlayedParty(
    deserialized: PlayerRushEventPlayedParty
): UserRushEventPlayedParty {
    return {
        character_id_1: deserialized.characterIds[0],
        character_id_2: deserialized.characterIds[1],
        character_id_3: deserialized.characterIds[2],
        unison_character_id_1: deserialized.unisonCharacterIds[0],
        unison_character_id_2: deserialized.unisonCharacterIds[1],
        unison_character_id_3: deserialized.unisonCharacterIds[2],
        equipment_id_1: deserialized.equipmentIds[0],
        equipment_id_2: deserialized.equipmentIds[1],
        equipment_id_3: deserialized.equipmentIds[2],
        ability_soul_id_1: deserialized.abilitySoulIds[0],
        ability_soul_id_2: deserialized.abilitySoulIds[1],
        ability_soul_id_3: deserialized.abilitySoulIds[2],
        evolution_img_level_1: deserialized.evolutionImgLevels[0],
        evolution_img_level_2: deserialized.evolutionImgLevels[1],
        evolution_img_level_3: deserialized.evolutionImgLevels[2],
        unison_evolution_img_level_1: deserialized.unisonEvolutionImgLevels[0],
        unison_evolution_img_level_2: deserialized.unisonEvolutionImgLevels[1],
        unison_evolution_img_level_3: deserialized.unisonEvolutionImgLevels[2],
    }
}
/**
 * Synchronously gets the first player bound to an account.
 */
export function getPlayerFromAccountIdSync(
    accountId: number
): Player | null {
    const response = getDb().prepare(`
    SELECT id
    FROM players
    WHERE account_id = ?
    `).get(accountId) as { id: number } | undefined

    if (response === undefined) return null

    return getPlayerSync(response.id)
}

/**
 * Gets the account that is tied to an individual player.
 * 
 * @param playerId The ID of the player.
 * @returns The account that is tied to the player.
 */
export function getAccountFromPlayerIdSync(
    playerId: number
): Account | null {
    const raw = getDb().prepare(`
    SELECT account_id
    FROM players
    WHERE id = ?
    `).get(playerId) as { account_id: number } | undefined

    return raw === undefined ? null : getAccountSync(raw.account_id)
}

/**
 * Converts a RawPlayer into a Player
 * 
 * @param raw The raw player to convert into a player.
 * @returns The converted Player
 */
function buildPlayer(
    raw: RawPlayer
): Player {
    return {
        id: raw.id,
        stamina: raw.stamina,
        staminaHealTime: new Date(raw.stamina_heal_time),
        boostPoint: raw.boost_point,
        bossBoostPoint: raw.boss_boost_point,
        transitionState: raw.transition_state,
        role: raw.role,
        name: raw.name,
        lastLoginTime: new Date(raw.last_login_time),
        comment: raw.comment,
        vmoney: raw.vmoney,
        freeVmoney: raw.free_vmoney,
        rankPoint: raw.rank_point,
        starCrumb: raw.star_crumb,
        bondToken: raw.bond_token,
        expPool: raw.exp_pool,
        expPooledTime: new Date(raw.exp_pooled_time),
        leaderCharacterId: raw.leader_character_id,
        partySlot: raw.party_slot,
        degreeId: raw.degree_id,
        birth: raw.birth,
        freeMana: raw.free_mana,
        paidMana: raw.paid_mana,
        enableAuto3x: deserializeBoolean(raw.enable_auto_3x),
        totalStaminaUsed: raw.total_stamina_used || 0,
        totalPowerflips: raw.total_powerflips || 0,
        totalDashes: raw.total_dashes || 0,
        totalManaObtained: raw.total_mana_obtained || 0,
        maxComboAchieved: raw.max_combo_achieved || 0,
        totalLoginDays: raw.total_login_days || 0,
        tutorialStep: raw.tutorial_step,
        tutorialSkipFlag: raw.tutorial_skip_flag === null ? null : deserializeBoolean(raw.tutorial_skip_flag),
        tutorialGachaCharacterId: raw.tutorial_gacha_character_id,
    }
}

export function getPlayerSync(
    playerId: number
): Player | null {
    const raw = getDb().prepare(`
    SELECT id, stamina, stamina_heal_time, boost_point, boss_boost_point,
        transition_state, role, name, last_login_time, comment,
        vmoney, free_vmoney, rank_point, star_crumb,
        bond_token, exp_pool, exp_pooled_time, leader_character_id, party_slot,
        degree_id, birth, free_mana, paid_mana, enable_auto_3x, total_stamina_used, total_powerflips, total_dashes, total_mana_obtained, max_combo_achieved, total_login_days, tutorial_step, tutorial_skip_flag, tutorial_gacha_character_id
    FROM players
    WHERE id = ?    
    `).get(playerId) as RawPlayer | undefined

    if (raw === undefined) return null

    return buildPlayer(raw)
}

export function getAllPlayersSync(
    offset: number = 0,
    limit: number = 25
): Player[] {
    const raw = getDb().prepare(`
    SELECT id, stamina, stamina_heal_time, boost_point, boss_boost_point,
        transition_state, role, name, last_login_time, comment,
        vmoney, free_vmoney, rank_point, star_crumb,
        bond_token, exp_pool, exp_pooled_time, leader_character_id, party_slot,
        degree_id, birth, free_mana, paid_mana, enable_auto_3x, total_stamina_used, total_powerflips, total_dashes, total_mana_obtained, max_combo_achieved, total_login_days, tutorial_step, tutorial_skip_flag, tutorial_gacha_character_id
    FROM players
    LIMIT ?
    OFFSET ?
    `).all(limit, offset) as RawPlayer[]

    return raw.map(rawPlayer => buildPlayer(rawPlayer))
}

/**
 * Inserts a player into the database.
 * 
 * @param accountId The ID of the account that this player is linked to.
 * @param player The player data to insert.
 * @returns The ID of the player that was inserted.
 */
export function insertPlayerSync(
    accountId: number,
    player: Pick<Partial<Player>, 'id'> & Omit<Player, 'id'>,
): number {
    const playerId = player.id
    const playerIdGiven = playerId !== undefined

    const params: Record<string, any> = {
        stamina: player.stamina,
        stamina_heal_time: player.staminaHealTime.toISOString(),
        boost_point: player.boostPoint,
        boss_boost_point: player.bossBoostPoint,
        transition_state: player.transitionState,
        role: player.role,
        name: player.name,
        last_login_time: player.lastLoginTime.toISOString(),
        comment: player.comment,
        vmoney: player.vmoney,
        free_vmoney: player.freeVmoney,
        rank_point: player.rankPoint,
        star_crumb: player.starCrumb,
        bond_token: player.bondToken,
        exp_pool: player.expPool,
        exp_pooled_time: player.expPooledTime.toISOString(),
        leader_character_id: player.leaderCharacterId,
        party_slot: player.partySlot,
        degree_id: player.degreeId,
        birth: player.birth,
        free_mana: player.freeMana,
        paid_mana: player.paidMana,
        enable_auto_3x: serializeBoolean(player.enableAuto3x),
        total_stamina_used: player.totalStaminaUsed ?? 0,
        total_powerflips: player.totalPowerflips ?? 0,
        total_dashes: player.totalDashes ?? 0,
        total_mana_obtained: player.totalManaObtained ?? 0,
        max_combo_achieved: player.maxComboAchieved ?? 0,
        total_login_days: player.totalLoginDays ?? 0,
        account_id: accountId,
        tutorial_step: player.tutorialStep ?? null,
        tutorial_skip_flag: player.tutorialSkipFlag !== null ? serializeBoolean(player.tutorialSkipFlag) : null,
        tutorial_gacha_character_id: player.tutorialGachaCharacterId ?? null,
        time_offset: player.timeOffset ?? null,
    }

    if (playerIdGiven)
        params.id = playerId

    const idCol = playerIdGiven ? ', id' : ''
    const idVal = playerIdGiven ? ', @id' : ''

    const insert = getDb().prepare(`
    INSERT INTO players (stamina, stamina_heal_time, boost_point, boss_boost_point,
        transition_state, role, name, last_login_time, comment, vmoney, free_vmoney,
        rank_point, star_crumb, bond_token, exp_pool, exp_pooled_time, leader_character_id,
        party_slot, degree_id, birth, free_mana, paid_mana, enable_auto_3x,
        total_stamina_used, total_powerflips, total_dashes, total_mana_obtained, max_combo_achieved, total_login_days, account_id,
        tutorial_step, tutorial_skip_flag, tutorial_gacha_character_id,
        time_offset${idCol})
    VALUES (@stamina, @stamina_heal_time, @boost_point, @boss_boost_point,
        @transition_state, @role, @name, @last_login_time, @comment,
        @vmoney, @free_vmoney, @rank_point, @star_crumb, @bond_token,
        @exp_pool, @exp_pooled_time, @leader_character_id, @party_slot,
        @degree_id, @birth, @free_mana, @paid_mana, @enable_auto_3x,
        @total_stamina_used, @total_powerflips, @total_dashes, @total_mana_obtained, @max_combo_achieved, @total_login_days, @account_id,
        @tutorial_step, @tutorial_skip_flag, @tutorial_gacha_character_id,
        @time_offset${idVal})
    `).run(params)

    // return
    return Number(insert.lastInsertRowid)
}

/**
 * Inserts the data from a MergedPlayerData object into the database.
 * 
 * @param toInsert The data to insert into the database.
 * @returns The newly inserted player's id.
 */
export function insertMergedPlayerDataSync(
    accountId: number,
    toInsert: MergedPlayerData
) {
    const player = toInsert.player
    const playerId = player.id
    insertPlayerSync(accountId, player)

    insertPlayerDailyChallengePointListSync(playerId, toInsert.dailyChallengePointList)
    insertPlayerTriggeredTutorialsSync(playerId, toInsert.triggeredTutorial)
    insertPlayerClearedRegularMissionListSync(playerId, toInsert.clearedRegularMissionList)
    insertPlayerCharactersSync(playerId, toInsert.characterList)
    insertPlayerCharactersManaNodesSync(playerId, toInsert.characterManaNodeList)
    insertPlayerPartyGroupListSync(playerId, toInsert.partyGroupList)
    insertPlayerItemsSync(playerId, toInsert.itemList)
    insertPlayerEquipmentListSync(playerId, toInsert.equipmentList)
    insertPlayerQuestProgressListSync(playerId, toInsert.questProgress)
    insertPlayerGachaInfoListSync(playerId, toInsert.gachaInfoList)
    insertPlayerGachaCampaignListSync(playerId, toInsert.gachaCampaignList)
    insertPlayerDrawnQuestsSync(playerId, toInsert.drawnQuestList)
    insertPlayerPeriodicRewardPointsListSync(playerId, toInsert.periodicRewardPointList)
    insertPlayerActiveMissionsSync(playerId, toInsert.allActiveMissionList)
    insertPlayerBoxGachasSync(playerId, toInsert.boxGachaList)
    insertPlayerStartDashExchangeCampaignsSync(playerId, toInsert.startDashExchangeCampaignList)
    insertPlayerMultiSpecialExchangeCampaignsSync(playerId, toInsert.multiSpecialExchangeCampaignList)
    insertPlayerOptionsSync(playerId, toInsert.userOption)

    // insert data that could be undefined.
    const rushEventList = toInsert.rushEventList
    if (rushEventList !== undefined) {
        insertPlayerRushEventListSync(playerId, rushEventList)
    }

    const rushEventClearedFolderList = toInsert.rushEventClearedFolderList
    if (rushEventClearedFolderList !== undefined) {
        insertPlayerRushEventClearedFolderListSync(playerId, rushEventClearedFolderList)
    }

    const rushEventPlayedPartyList = toInsert.rushEventPlayedPartyList
    if (rushEventPlayedPartyList !== undefined) {
        insertPlayerRushEventPlayedPartyListSync(playerId, rushEventPlayedPartyList)
    }
}

export function getDefaultPlayerPartyGroupsSync(
    partyType: PartyCategory = PartyCategory.NORMAL,
    characterIds: (number | null)[] = [1, null, null]
): Record<string, PlayerPartyGroup> {
    const partyGroups: Record<string, PlayerPartyGroup> = {}

    const partyNames = ["A", "B", "C", "D", "E", "F", "G", "H", "I", "J"]
    const groupCount = 12  // CN version: 12 groups × 10 slots = 120 parties

    const character1 = characterIds[0]
    const character2 = characterIds[1]
    const character3 = characterIds[2]

    for (let i = 0; i < groupCount; i++) {
        const list: Record<string, PlayerParty> = {}
        const group: PlayerPartyGroup = {
            list: list,
            colorId: 15,
            category: partyType
        }

        for (let slot = 1; slot <= 10; slot++) {
            const name = partyNames[slot - 1]
            list[slot] = {
                name: `Party ${name}`,
                characterIds: [character1, character2, character3],
                unisonCharacterIds: [null, null, null],
                equipmentIds: [null, null, null],
                abilitySoulIds: [null, null, null],
                edited: false,
                options: {
                    allowOtherPlayersToHealMe: true
                },
                category: partyType
            }
        }

        partyGroups[(i + 1).toString()] = group
    }

    return partyGroups
}

/**
 * Inserts a default player data into the database, linked to a provided account id.
 * 
 * @param accountId The account ID to link the new player to.
 * @returns The newly created player.
 */
export function insertDefaultPlayerSync(
    accountId: number
): Player {
    const player: Omit<Player, 'id'> = getDefaultPlayerData()

    const db = getDb()
    const insertAll = db.transaction((): number => {
        const playerId = insertPlayerSync(accountId, player)

    // daily challenge point list — initialize all 282 CDN entries
    insertPlayerDailyChallengePointListSync(playerId, getDailyChallengePointDefaults())

    // insert triggered tutorials — empty to trigger tutorial on new accounts
    insertPlayerTriggeredTutorialsSync(playerId, [])

    // insert cleared regular missions
    insertPlayerClearedRegularMissionListSync(playerId, {})

    // insert characterList
    insertPlayerCharactersSync(playerId, {
        "1": {
            entryCount: 1,
            evolutionLevel: 0,
            overLimitStep: 0,
            protection: false,
            joinTime: new Date(),
            updateTime: new Date(),
            exp: 10,
            stack: 0,
            bondTokenList: [
                {
                    manaBoardIndex: 1,
                    status: 0
                },
                {
                    manaBoardIndex: 2,
                    status: 0
                }
            ],
            manaBoardIndex: 1
        }
    })

    // insert characterManaNodeList
    insertPlayerCharactersManaNodesSync(playerId, {})

    // insert default parties
    insertPlayerPartyGroupListSync(playerId, getDefaultPlayerPartyGroupsSync())

    // insert items
    insertPlayerItemsSync(playerId, {})

    // insert equipment
    insertPlayerEquipmentListSync(playerId, {})

    // insert quest progress
    insertPlayerQuestProgressListSync(playerId, {})

    // insert options
    insertPlayerOptionsSync(playerId, {
        "gacha_play_no_rarity_up_movie": false,
        "auto_play": false,
        "number_notation_symbol": true,
        "payment_alert": true,
        "room_number_hidden": false,
        "attention_sound_effect": true,
        "attention_vibration": false,
        "attention_enable_in_battle": true,
        "simple_ability_description": false
    })

    // insert gacha info
    insertPlayerGachaInfoListSync(playerId, [])

    // insert drawnQuestList
    insertPlayerDrawnQuestsSync(playerId, [
        {
            categoryId: 6,
            questId: 5001,
            oddsId: 5
        },
        {
            categoryId: 6,
            questId: 5002,
            oddsId: 3
        },
        {
            categoryId: 6,
            questId: 5003,
            oddsId: 1
        },
        {
            categoryId: 6,
            questId: 5004,
            oddsId: 6
        },
        {
            categoryId: 6,
            questId: 5005,
            oddsId: 2
        },
        {
            categoryId: 6,
            questId: 13001,
            oddsId: 2
        },
        {
            categoryId: 6,
            questId: 13002,
            oddsId: 4
        },
        {
            categoryId: 6,
            questId: 13003,
            oddsId: 3
        },
        {
            categoryId: 6,
            questId: 13004,
            oddsId: 2
        },
        {
            categoryId: 6,
            questId: 13005,
            oddsId: 9
        },
        {
            categoryId: 6,
            questId: 13006,
            oddsId: 2
        },
        {
            categoryId: 6,
            questId: 14001,
            oddsId: 4
        },
        {
            categoryId: 6,
            questId: 14002,
            oddsId: 3
        },
        {
            categoryId: 6,
            questId: 14003,
            oddsId: 6
        },
        {
            categoryId: 6,
            questId: 14004,
            oddsId: 5
        },
        {
            categoryId: 6,
            questId: 14005,
            oddsId: 8
        },
        {
            categoryId: 6,
            questId: 14006,
            oddsId: 6
        },
        {
            categoryId: 6,
            questId: 15001,
            oddsId: 6
        },
        {
            categoryId: 6,
            questId: 15002,
            oddsId: 3
        },
        {
            categoryId: 6,
            questId: 15003,
            oddsId: 5
        },
        {
            categoryId: 6,
            questId: 15004,
            oddsId: 4
        },
        {
            categoryId: 6,
            questId: 15005,
            oddsId: 7
        },
        {
            categoryId: 6,
            oddsId: 5,
            questId: 15006
        },
        {
            categoryId: 6,
            questId: 16001,
            oddsId: 1
        },
        {
            categoryId: 6,
            questId: 16002,
            oddsId: 8
        },
        {
            categoryId: 6,
            questId: 16003,
            oddsId: 3
        },
        {
            categoryId: 6,
            questId: 16004,
            oddsId: 6
        },
        {
            categoryId: 6,
            questId: 16005,
            oddsId: 1
        },
        {
            categoryId: 6,
            questId: 16006,
            oddsId: 9
        },
        {
            categoryId: 6,
            questId: 17001,
            oddsId: 6
        },
        {
            categoryId: 6,
            questId: 17002,
            oddsId: 8
        },
        {
            categoryId: 6,
            questId: 17003,
            oddsId: 2
        },
        {
            categoryId: 6,
            questId: 17004,
            oddsId: 3
        },
        {
            categoryId: 6,
            questId: 17005,
            oddsId: 7
        },
        {
            categoryId: 6,
            questId: 17006,
            oddsId: 6
        },
        {
            categoryId: 6,
            questId: 18001,
            oddsId: 8
        },
        {
            categoryId: 6,
            questId: 18002,
            oddsId: 3
        },
        {
            categoryId: 6,
            questId: 18003,
            oddsId: 4
        },
        {
            categoryId: 6,
            questId: 18004,
            oddsId: 3
        },
        {
            categoryId: 6,
            questId: 18005,
            oddsId: 4
        },
        {
            categoryId: 6,
            questId: 18006,
            oddsId: 6
        },
        {
            categoryId: 6,
            questId: 19001,
            oddsId: 6
        },
        {
            categoryId: 6,
            questId: 19002,
            oddsId: 7
        },
        {
            categoryId: 6,
            questId: 19003,
            oddsId: 3
        },
        {
            categoryId: 6,
            questId: 19004,
            oddsId: 3
        },
        {
            categoryId: 6,
            questId: 19005,
            oddsId: 2
        },
        {
            categoryId: 6,
            questId: 19006,
            oddsId: 1
        },
        {
            categoryId: 6,
            questId: 19007,
            oddsId: 7
        },
        {
            categoryId: 6,
            questId: 19008,
            oddsId: 7
        },
        {
            categoryId: 6,
            questId: 19009,
            oddsId: 5
        },
        {
            categoryId: 6,
            questId: 19010,
            oddsId: 2
        },
        {
            categoryId: 6,
            questId: 19011,
            oddsId: 2
        },
        {
            categoryId: 6,
            questId: 19012,
            oddsId: 9
        },
        {
            categoryId: 6,
            questId: 19013,
            oddsId: 4
        },
        {
            categoryId: 6,
            questId: 19014,
            oddsId: 8
        },
        {
            categoryId: 6,
            questId: 19015,
            oddsId: 1
        },
        {
            categoryId: 6,
            questId: 19016,
            oddsId: 1
        },
        {
            categoryId: 6,
            questId: 19017,
            oddsId: 6
        },
        {
            categoryId: 6,
            questId: 19018,
            oddsId: 4
        },
        {
            categoryId: 14,
            questId: 1001,
            oddsId: 21
        },
        {
            categoryId: 14,
            questId: 1002,
            oddsId: 30
        },
        {
            categoryId: 14,
            questId: 1003,
            oddsId: 20
        },
        {
            categoryId: 14,
            questId: 1004,
            oddsId: 27
        },
        {
            categoryId: 14,
            questId: 1005,
            oddsId: 9
        },
        {
            categoryId: 14,
            questId: 1006,
            oddsId: 35
        },
    ])

    // insert periodicReward
    insertPlayerPeriodicRewardPointsListSync(playerId, [
        {
            id: 1,
            point: 22,
        },
        {
            id: 2,
            point: 2,
        },
        {
            id: 3,
            point: 2,
        },
        {
            id: 10000000,
            point: 2,
        },
    ])

    // insert active missions
    insertPlayerActiveMissionsSync(playerId, {})

    // insert box gacha
    insertPlayerBoxGachasSync(playerId, {
        "1001": [
            {
                boxId: 1,
                resetTimes: 0,
                remainingNumber: 572,
                isClosed: false
            },
            {
                boxId: 2,
                resetTimes: 0,
                remainingNumber: 647,
                isClosed: false
            },
            {
                boxId: 3,
                resetTimes: 0,
                remainingNumber: 732,
                isClosed: false
            },
            {
                boxId: 4,
                resetTimes: 0,
                remainingNumber: 912,
                isClosed: false
            },
            {
                boxId: 5,
                resetTimes: 0,
                remainingNumber: 1401,
                isClosed: false
            },
        ]
    })

    // insert start dash campaign list
    insertPlayerStartDashExchangeCampaignsSync(playerId, [])

    // insert the multi special exchange campaign list
    insertPlayerMultiSpecialExchangeCampaignsSync(playerId, [
        {
            campaignId: 3,
            status: 1
        }
    ])

        return playerId
    })

    const finalPlayerId = insertAll()
    const finalPlayer = player as Player
    finalPlayer.id = finalPlayerId
    return finalPlayer
}

/**
 * Updates a player within the database.
 * 
 * @param player The properties of the player to change. Id must always be present.
 */
export function updatePlayerSync(
    player: Partial<Player> & Pick<Player, 'id'>
) {
    const id = player.id

    const fieldMap: Record<string, string> = {
        'stamina': 'stamina',
        'staminaHealTime': 'stamina_heal_time',
        'boostPoint': 'boost_point',
        'bossBoostPoint': 'boss_boost_point',
        'transitionState': 'transition_state',
        'role': 'role',
        'name': 'name',
        'lastLoginTime': 'last_login_time',
        'comment': 'comment',
        'vmoney': 'vmoney',
        'freeVmoney': 'free_vmoney',
        'rankPoint': 'rank_point',
        'starCrumb': 'star_crumb',
        'bondToken': 'bond_token',
        'expPool': 'exp_pool',
        'expPooledTime': 'exp_pooled_time',
        'leaderCharacterId': 'leader_character_id',
        'partySlot': 'party_slot',
        'degreeId': 'degree_id',
        'birth': 'birth',
        'freeMana': 'free_mana',
        'paidMana': 'paid_mana',
        'enableAuto3x': 'enable_auto_3x',
        'totalStaminaUsed': 'total_stamina_used',
        'totalPowerflips': 'total_powerflips',
        'totalDashes': 'total_dashes',
        'totalManaObtained': 'total_mana_obtained',
        'maxComboAchieved': 'max_combo_achieved',
        'totalLoginDays': 'total_login_days',
        'tutorialStep': 'tutorial_step',
        'tutorialSkipFlag': 'tutorial_skip_flag',
        'tutorialGachaCharacterId': 'tutorial_gacha_character_id'
    }

    const sets: string[] = []
    const values: any[] = []
    for (const key in player) {
        const value = player[key as keyof typeof player]
        const mapped = fieldMap[key]
        if (mapped && value !== undefined) {
            sets.push(`${mapped} = ?`)
            if (value instanceof Date) {
                values.push(value.toISOString())
            } else if (typeof (value) === 'boolean') {
                values.push(serializeBoolean(value))
            } else {
                values.push(value)
            }
        }
    }

    if (sets.length > 0) getDb().prepare(`
        UPDATE players
        SET ${sets.join(', ')}
        WHERE id = ?
        `).run([...values, id]);
}

/**
 * Replaces a player's data with the provided MergedPlayerData object.
 * 
 * @param replaceWith The MergedPlayerData to replace.
 */
export function replacePlayerDataSync(
    replaceWith: MergedPlayerData
) {
    try {
        const playerId = replaceWith.player.id

        const account = getAccountFromPlayerIdSync(playerId)
        if (account === null)
            throw new Error("No account tied to player id.");

        // delete player
        deletePlayerSync(playerId)

        // insert new
        insertMergedPlayerDataSync(account.id, replaceWith)
    } catch (error: Error | any) {
        console.error(error)
        throw error
    }
}

/**
 * Deletes a player from the database completely.
 * 
 * @param playerId The ID of the player to delete
 */
export function deletePlayerSync(
    playerId: number
) {
    getDb().prepare(`DELETE FROM players WHERE id = ?`).run(playerId)
}

export function collectPlayerDataPooledExpSync(
    player: Player,
    dateNow: Date = new Date()
) {
    const serverTimeNow = getServerTime(dateNow)
    const poolTime = getServerTime(player.expPooledTime)
    const diff = Math.max(0, serverTimeNow - poolTime)

    if (60 > diff) return;

    updatePlayerSync({
        id: player.id,
        expPooledTime: dateNow,
        expPool: player.expPool + Math.min(expPoolMax, Math.floor(diff / 60))
    })
}

/**
 * Collects any pooled exp that a player might have.
 * Exp regenerates at a rate of 1 per minute.
 * 
 * @param playerId The ID of the player to collect the pooled EXP of.
 */
export function collectPlayerPooledExpSync(
    playerId: number
) {
    // exp regenerates at a rate of 1/min
    const playerData = getPlayerSync(playerId)
    if (!playerData) return;

    collectPlayerDataPooledExpSync(playerData)
}

/**
 * Performs a daily reset for a a player data object.
 * 
 * @param player The player data to perform the daily reset for
 * @param loginDate 
 * @returns A boolean; whether the daily reset was performed
 */
export function dailyResetPlayerDataSync(
    player: Player,
    loginDate: Date = new Date()
): boolean {
    const lastLoginTime = player.lastLoginTime
    const playerId = player.id
    const crossedDay = isNewDay(loginDate, lastLoginTime)
    const crossedWeek = isNewWeek(loginDate, lastLoginTime)

    if (crossedDay) {
        updatePlayerSync({
            id: playerId,
            lastLoginTime: loginDate,
            bossBoostPoint: 3,
            boostPoint: 3,
            totalLoginDays: (player.totalLoginDays ?? 0) + 1
        })

        // Reset daily challenge points — sync with CDN and rebuild if missing
        const dcEntries = getPlayerDailyChallengePointListSync(playerId)
        const defaults = getDailyChallengePointDefaults()
        if (dcEntries.length === 0) {
            insertPlayerDailyChallengePointListSync(playerId, defaults)
        } else {
            // Reset existing entries to CDN max
            for (const entry of dcEntries) {
                const cdn = (dailyChallengePointLookup as DailyChallengePointLookup)[String(entry.id)]
                const maxPoint = cdn?.maxPoint ?? entry.point
                updatePlayerDailyChallengePointSync(playerId, entry.id, maxPoint + entry.campaignList.reduce((s, c) => s + c.additionalPoint, 0))
            }
            // Add any new CDN entries not yet in player's list
            const existingIds = new Set(dcEntries.map(e => e.id))
            const missing = defaults.filter(e => !existingIds.has(e.id))
            if (missing.length > 0) {
                insertPlayerDailyChallengePointListSync(playerId, missing)
            }
        }

        // reset gacha "isDailyFirst" values.
        const gachaInfo = getPlayerGachaInfoListSync(playerId)
        for (const gacha of gachaInfo) {
            updatePlayerGachaInfoSync(playerId, {
                gachaId: gacha.gachaId,
                isDailyFirst: true
            })
        }

        // reset campaigns
        const gachaCampaigns = getPlayerGachaCampaignListSync(playerId)
        for (const campaign of gachaCampaigns) {
            updatePlayerGachaCampaignSync(playerId, campaign.gachaId, campaign.campaignId, 1)
        }

        // Daily mission reset: take snapshot + wipe cache
        const questProgress = getPlayerQuestProgressSync(playerId)
        let totalClears = 0, ss = 0, s = 0, a = 0, b = 0
        for (const [section, quests] of Object.entries(questProgress)) {
            for (const qp of quests) {
                if (qp.finished) {
                    totalClears++
                    if (qp.clearRank === 6) ss++
                    else if (qp.clearRank === 5) s++
                    else if (qp.clearRank === 4) a++
                    else if (qp.clearRank === 3) b++
                }
            }
        }
        takeSnapshot(playerId, 'daily', {
            questClears: totalClears,
            staminaUsed: player.totalStaminaUsed,
            rankSs: ss, rankS: s, rankA: a, rankB: b,
        })
        getDb().prepare(`DELETE FROM players_active_missions_stages WHERE player_id = ? AND mission_id IN (SELECT id FROM players_active_missions WHERE player_id = ? AND progress >= 0)`).run(playerId, playerId)
        getDb().prepare(`DELETE FROM players_active_missions WHERE player_id = ?`).run(playerId)

        // weekly reset
        if (crossedWeek) {
            takeSnapshot(playerId, 'weekly', {
                questClears: totalClears,
                staminaUsed: player.totalStaminaUsed,
                rankSs: ss, rankS: s, rankA: a, rankB: b,
            })
        }

        return true
    } else {
        updatePlayerSync({
            id: playerId,
            lastLoginTime: loginDate,
        })
        return false
    }
}

/**
 * Performs a daily reset for a player
 * 
 * @param playerId The ID of the player to perform the daily reset for.
 * @returns A boolean; whether the daily reset was performed
 */
export function dailyResetPlayerSync(
    playerId: number
): boolean {
    const playerData = getPlayerSync(playerId)
    if (!playerData) return false;

    return dailyResetPlayerDataSync(playerData)
}
