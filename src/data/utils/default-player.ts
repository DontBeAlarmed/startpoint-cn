import { getServerDate } from "../../utils"
import { getMaxStamina } from "../../lib/stamina"
import type { Player } from "../types"

/** Build the persisted defaults for a newly-created player. */
export function getDefaultPlayerData(): Omit<Player, "id"> {
    const now = getServerDate()
    return {
        stamina: getMaxStamina(1),
        staminaHealTime: new Date(),
        boostPoint: 10,
        bossBoostPoint: 3,
        transitionState: 0,
        role: 1,
        name: "冒险者",
        lastLoginTime: now,
        comment: "よろしくお願いします",
        vmoney: 100,
        freeVmoney: 100,
        rankPoint: 0,
        starCrumb: 2,
        bondToken: 10,
        expPool: 0,
        expPooledTime: now,
        leaderCharacterId: 1,
        partySlot: 1,
        degreeId: 1,
        birth: 19900101,
        freeMana: 2000,
        paidMana: 2000,
        enableAuto3x: false,
        totalStaminaUsed: 0,
        totalPowerflips: 0,
        totalDashes: 0,
        totalManaObtained: 0,
        maxComboAchieved: 0,
        totalLoginDays: 1,
        tutorialStep: 0,
        tutorialSkipFlag: null,
        tutorialGachaCharacterId: null,
        timeOffset: null,
    }
}
