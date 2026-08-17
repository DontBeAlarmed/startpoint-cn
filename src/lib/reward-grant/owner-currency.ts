import { getDb } from "../../data/db"
import type { PlayerRewardResult } from "../types/rewards"
import { RewardType } from "../types/rewards"
import { RewardGrantKnownPlayerValidationError } from "./known-player"
import type { RewardGrantReward } from "./types"

export interface OwnerCurrencyState {
    freeMana: number
    freeVmoney: number
    expPool: number
}

export interface RewardGrantOwnerPlayerUpdate {
    readonly degreeId?: number
}

function assertValidOwnerCurrency(
    field: keyof OwnerCurrencyState,
    value: number,
): void {
    if (!Number.isSafeInteger(value) || value < 0) {
        throw new RewardGrantKnownPlayerValidationError(field)
    }
}

export function grantOwnerCurrency(
    reward: Extract<RewardGrantReward, { type: RewardType.BEADS | RewardType.MANA | RewardType.EXP }>,
    playerAfter: OwnerCurrencyState,
    currencyDeltas: OwnerCurrencyState,
): PlayerRewardResult {
    const result: PlayerRewardResult = {
        user_info: { free_mana: 0, free_vmoney: 0, exp_pool: 0 },
        character_list: [],
        joined_character_id_list: [],
        equipment_list: [],
        items: {},
    }
    switch (reward.type) {
        case RewardType.BEADS:
            const nextFreeVmoney = playerAfter.freeVmoney + reward.count
            assertValidOwnerCurrency("freeVmoney", nextFreeVmoney)
            playerAfter.freeVmoney = nextFreeVmoney
            currencyDeltas.freeVmoney += reward.count
            result.user_info.free_vmoney = reward.count
            break
        case RewardType.MANA:
            const nextFreeMana = playerAfter.freeMana + reward.count
            assertValidOwnerCurrency("freeMana", nextFreeMana)
            playerAfter.freeMana = nextFreeMana
            currencyDeltas.freeMana += reward.count
            result.user_info.free_mana = reward.count
            break
        case RewardType.EXP:
            const nextExpPool = playerAfter.expPool + reward.count
            assertValidOwnerCurrency("expPool", nextExpPool)
            playerAfter.expPool = nextExpPool
            currencyDeltas.expPool += reward.count
            result.user_info.exp_pool = reward.count
            break
    }
    return result
}

export function persistOwnerCurrency(
    playerId: number,
    playerAfter: OwnerCurrencyState,
    currencyDeltas: OwnerCurrencyState,
    playerUpdate: RewardGrantOwnerPlayerUpdate = {},
): void {
    if (currencyDeltas.freeMana === 0
        && currencyDeltas.freeVmoney === 0
        && currencyDeltas.expPool === 0
        && playerUpdate.degreeId === undefined) return
    getDb().prepare(`
        UPDATE players
        SET free_vmoney = ?, free_mana = ?, exp_pool = ?,
            total_mana_obtained = total_mana_obtained + ?,
            degree_id = COALESCE(?, degree_id)
        WHERE id = ?
    `).run(
        playerAfter.freeVmoney,
        playerAfter.freeMana,
        playerAfter.expPool,
        currencyDeltas.freeMana,
        playerUpdate.degreeId ?? null,
        playerId,
    )
}
