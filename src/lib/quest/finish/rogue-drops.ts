import { updatePlayerEquipmentSync } from "../../../data/domains/equipment"
import { getCharacterDataSync, getEquipmentElement, getEquipmentMaxLevel, getRogueEventConfig } from "../../assets"
import { givePlayerCharactersExpSync } from "../../character"
import { givePlayerRewardsSync } from "../../quest"
import type { AddExpList, ClientReturnBondTokenStatusList, ClientReturnCharacter, PlayerRewardResult, Reward, RushEventFolder } from "../../types"
import { QuestCategory, RewardType } from "../../types"

// Client-side kind values accepted by RushEventLogic.rewardListToGeneralRewardKinds
// (anything else throws ClientError 3446): 1=Item, 5=Character, 6=Equipment.
const REWARD_LIST_KIND: Record<string, number> = {
    item: 1,
    character: 5,
    equipment: 6,
}

const REWARD_TYPE: Record<string, RewardType> = {
    item: RewardType.ITEM,
    character: RewardType.CHARACTER,
    equipment: RewardType.EQUIPMENT,
}

export interface RogueDropOutcome {
    rewardResult: PlayerRewardResult
    // exp pumped into freshly dropped characters (empty unless drop_character_exp > 0)
    addExpList: AddExpList
    expCharacterList: ClientReturnCharacter[]
    bondTokenStatusList: ClientReturnBondTokenStatusList
    // absolute exp pool after the exp grant, or null when no exp grant ran
    expPoolAbsolute: number | null
    rewardListEntries: { kind: number, kind_id: number, number: number }[]
    // whether the caller may surface rewardListEntries in rush_battle_reward_list.
    // Never true for non-final folder rounds: the client treats a stored
    // non-empty clear reward as the folder-clear celebration and replaces the
    // quest select list with the folder's last quest (round skip exploit).
    showInRewardList: boolean
}

interface RogueDropParams {
    questCategory: number
    questAccomplished: boolean
    playerId: number
    questData: {
        rushEventId?: number
        rushEventFolderId?: RushEventFolder
        rushEventRound?: number
    }
    folderMaxRounds: Record<number, number | undefined>
    // character ids of the party that cleared the round (mains + unisons);
    // used to element-match pool drops so souls/weapons are actually usable
    partyCharacterIds?: number[]
}

/**
 * Roguelike rush-event mod: grants configured per-round loot
 * (weapons / souls / characters / items) after every cleared rush round.
 * Everything is gated by assets/rogue_event.json (hot-reloadable).
 *
 * @returns The drop outcome to merge into the quest finish response, or null.
 */
export function handleRoguePerRoundDrops(params: RogueDropParams): RogueDropOutcome | null {
    const { questCategory, questAccomplished, playerId, questData, folderMaxRounds, partyCharacterIds } = params

    if (questCategory !== QuestCategory.RUSH_EVENT || !questAccomplished) return null

    const { rushEventId, rushEventFolderId, rushEventRound } = questData
    if (rushEventId === undefined || rushEventFolderId === undefined || rushEventRound === undefined) return null

    const config = getRogueEventConfig(rushEventId)
    if (config === null) return null

    // fixed drops (per_round_drops) + weighted random pool (drop_pool × pool_draws)
    const dropsConfig: any[] = Array.isArray(config.per_round_drops) ? [...config.per_round_drops] : []
    const pool: any[] = Array.isArray(config.drop_pool) ? config.drop_pool : []
    const draws = Math.max(0, Math.floor(Number(config.pool_draws) || 0))
    if (pool.length > 0 && draws > 0) {
        // element matching (default on): souls/weapons hard-gate on element
        // ("属性不同,无法使用"), so restrict rolls to the clearing party's
        // elements plus universal (-1). Falls back to the full pool if the
        // filter would empty it.
        let candidates = pool
        if (config.match_party_element !== false && Array.isArray(partyCharacterIds)) {
            const partyElements = new Set<number>()
            for (const id of partyCharacterIds) {
                const element = Number(getCharacterDataSync(id)?.element)
                if (Number.isInteger(element)) partyElements.add(element)
            }
            if (partyElements.size > 0) {
                const filtered = pool.filter(entry => {
                    const element = getEquipmentElement(Number(entry?.id))
                    return element === -1 || partyElements.has(element)
                })
                if (filtered.length > 0) candidates = filtered
            }
        }
        // first draw guarantees a weapon (default on) so a round never yields
        // souls only; remaining draws roll the whole candidate set
        const weaponCandidates = candidates.filter(entry => entry?.type === "equipment")
        const pickWeighted = (entries: any[]) => {
            const totalWeight = entries.reduce((sum, e) => sum + (Number(e?.weight) > 0 ? Number(e.weight) : 1), 0)
            let roll = Math.random() * totalWeight
            for (const entry of entries) {
                roll -= Number(entry?.weight) > 0 ? Number(entry.weight) : 1
                if (roll <= 0) return entry
            }
            return entries[entries.length - 1]
        }
        for (let i = 0; i < draws; i++) {
            const source = (i === 0 && config.guarantee_weapon !== false && weaponCandidates.length > 0)
                ? weaponCandidates
                : candidates
            const picked = pickWeighted(source)
            if (picked !== undefined) dropsConfig.push(picked)
        }
    }

    const rewards: Reward[] = []
    const rewardListEntries: RogueDropOutcome["rewardListEntries"] = []
    for (const drop of dropsConfig) {
        const type = REWARD_TYPE[drop?.type]
        const id = Number(drop?.id)
        if (type === undefined || !Number.isInteger(id)) continue
        const count = Math.max(1, Number(drop?.count) || 1)
        rewards.push({ type, id, count } as Reward)
        rewardListEntries.push({ kind: REWARD_LIST_KIND[drop.type], kind_id: id, number: count })
    }
    if (rewards.length === 0) return null

    const rewardResult = givePlayerRewardsSync(playerId, rewards)
    if (rewardResult === null) return null

    // "finished goods" drops: raise dropped equipment to the configured
    // evolution level (players_equipment.level), clamped per item to the
    // equipment master's max_level — the client hard-throws C2284/C2287 on
    // out-of-range level/enhancement, so never write beyond the caps.
    // enhancement_level is 特殊改造 (only ~29 weapons define it, everything
    // else caps at 0) — configurable per drop entry only, no global knob.
    // DB row and the serialized response entries are patched together so the
    // client applies final stats immediately (equipment_list upsert).
    const equipLevel = Math.max(0, Math.floor(Number(config.drop_equipment_level) || 0))
    if (equipLevel > 0) {
        for (const entry of rewardResult.equipment_list as any[]) {
            const target = Math.min(equipLevel, getEquipmentMaxLevel(Number(entry.equipment_id)))
            if (Number(entry.level) < target) {
                entry.level = target
                updatePlayerEquipmentSync(playerId, Number(entry.equipment_id), { level: target })
            }
        }
    }

    // Optionally pump exp into characters that were actually added (dupes are
    // converted to items by givePlayerCharacterSync and never appear here).
    // The DB write always sticks; whether the client applies it mid-session is
    // a canary question — worst case the character shows Lv1 until relogin.
    let addExpList: AddExpList = []
    let expCharacterList: ClientReturnCharacter[] = []
    let bondTokenStatusList: ClientReturnBondTokenStatusList = {}
    let expPoolAbsolute: number | null = null
    const dropExp = Number(config.drop_character_exp) || 0
    if (dropExp > 0) {
        const droppedCharacterIds = rewardResult.character_list
            .map(character => Number((character as any).character_id))
            .filter(id => Number.isInteger(id))
        if (droppedCharacterIds.length > 0) {
            const expResult = givePlayerCharactersExpSync(playerId, droppedCharacterIds, dropExp, false)
            addExpList = expResult.add_exp_list
            expCharacterList = expResult.character_list
            bondTokenStatusList = expResult.bond_token_status_list
            expPoolAbsolute = expResult.exp_pool
        }
    }

    const isEndless = rushEventRound === 0
    const isFolderFinal = !isEndless && rushEventRound >= (folderMaxRounds[rushEventFolderId] ?? 0)
    const showInRewardList = isFolderFinal || (isEndless && config.show_reward_list_endless !== false)

    return {
        rewardResult,
        addExpList,
        expCharacterList,
        bondTokenStatusList,
        expPoolAbsolute,
        rewardListEntries,
        showInRewardList,
    }
}
