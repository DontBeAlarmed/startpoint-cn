import {
    insertReceiveHistorySync,
    MailType,
    type RawPlayerMail,
} from "../data/domains/mail"
import { updatePlayerSync } from "../data/domains/player"
import type { Player } from "../data/types"
import { createRewardGrantPlan } from "./reward-grant"
import type { RewardGrantPlan, RewardGrantReward } from "./reward-grant"
import { executeRewardGrantPlanInTransactionOwnerSync } from "./reward-grant/owner-executor"
import { RewardType } from "./types/rewards"

export interface MailRewardSource {
    readonly mailId: number
    readonly attachmentIndex: number
}

export interface MailRewardSettlement {
    readonly characterList: Record<string, unknown>[]
    readonly equipmentList: Record<string, unknown>[]
    readonly itemList: Record<string, number>
    readonly userInfo: Record<string, number>
}

const SUPPORTED_MAIL_TYPES = new Set<number>([
    MailType.ITEM,
    MailType.PAID_VMONEY,
    MailType.FREE_VMONEY,
    MailType.CHARACTER,
    MailType.EQUIPMENT,
    MailType.STAR_CRUMB,
    MailType.FREE_MANA,
    MailType.EXP_POOL,
    MailType.BOND_TOKEN,
    MailType.BOSS_BOOST_POINT,
    MailType.BOOST_POINT,
    MailType.RANK_POINT,
])

export class UnsupportedMailAttachmentError extends Error {
    constructor(message: string) {
        super(message)
        this.name = "UnsupportedMailAttachmentError"
    }
}

export class MailRewardBalanceOverflowError extends Error {
    readonly field: keyof DedicatedMailBalance

    constructor(field: keyof DedicatedMailBalance) {
        super(`Mail reward balance overflow: ${field}`)
        this.name = "MailRewardBalanceOverflowError"
        this.field = field
    }
}

interface DedicatedMailBalance {
    vmoney: number
    starCrumb: number
    bondToken: number
    bossBoostPoint: number
    boostPoint: number
    rankPoint: number
}

function requireMailTypeId(mail: RawPlayerMail): number {
    if (!Number.isSafeInteger(mail.type_id) || (mail.type_id as number) <= 0) {
        throw new UnsupportedMailAttachmentError(`Mail ${mail.id} has an invalid attachment ID.`)
    }
    return mail.type_id as number
}

function validateMailReward(mail: RawPlayerMail): void {
    if (!SUPPORTED_MAIL_TYPES.has(mail.type)) {
        throw new UnsupportedMailAttachmentError(
            `Mail ${mail.id} has unsupported attachment type ${mail.type}.`,
        )
    }
    if (!Number.isSafeInteger(mail.number) || mail.number <= 0) {
        throw new UnsupportedMailAttachmentError(`Mail ${mail.id} has an invalid attachment amount.`)
    }
    if (mail.type === MailType.ITEM
        || mail.type === MailType.CHARACTER
        || mail.type === MailType.EQUIPMENT) {
        requireMailTypeId(mail)
    }
}

function standardReward(mail: RawPlayerMail): RewardGrantReward | null {
    switch (mail.type) {
        case MailType.ITEM:
            return { type: RewardType.ITEM, id: requireMailTypeId(mail), count: mail.number }
        case MailType.FREE_VMONEY:
            return { type: RewardType.BEADS, count: mail.number }
        case MailType.CHARACTER:
            return { type: RewardType.CHARACTER, id: requireMailTypeId(mail) }
        case MailType.EQUIPMENT:
            return { type: RewardType.EQUIPMENT, id: requireMailTypeId(mail), count: mail.number }
        case MailType.FREE_MANA:
            return { type: RewardType.MANA, count: mail.number }
        case MailType.EXP_POOL:
            return { type: RewardType.EXP, count: mail.number }
        default:
            return null
    }
}

export function createMailRewardPlan(
    mails: readonly RawPlayerMail[],
): RewardGrantPlan<MailRewardSource> {
    const entries: Array<{ source: MailRewardSource, reward: RewardGrantReward }> = []
    for (const mail of mails) {
        validateMailReward(mail)
        const reward = standardReward(mail)
        if (reward === null) continue
        const attachmentCount = mail.type === MailType.CHARACTER ? mail.number : 1
        for (let attachmentIndex = 0; attachmentIndex < attachmentCount; attachmentIndex++) {
            entries.push({
                source: { mailId: mail.id, attachmentIndex },
                reward,
            })
        }
    }
    return createRewardGrantPlan(entries)
}

function addDedicatedReward(
    balance: DedicatedMailBalance,
    field: keyof DedicatedMailBalance,
    amount: number,
): void {
    const next = balance[field] + amount
    if (!Number.isSafeInteger(next) || next < 0) {
        throw new MailRewardBalanceOverflowError(field)
    }
    balance[field] = next
}

function settleDedicatedMailBalance(
    mails: readonly RawPlayerMail[],
    player: Player,
): { balance: DedicatedMailBalance, update: Partial<DedicatedMailBalance> } {
    const balance: DedicatedMailBalance = {
        vmoney: player.vmoney,
        starCrumb: player.starCrumb,
        bondToken: player.bondToken,
        bossBoostPoint: player.bossBoostPoint,
        boostPoint: player.boostPoint,
        rankPoint: player.rankPoint,
    }
    const update: Partial<DedicatedMailBalance> = {}
    for (const mail of mails) {
        let field: keyof DedicatedMailBalance | null = null
        switch (mail.type) {
            case MailType.PAID_VMONEY:
                field = "vmoney"
                break
            case MailType.STAR_CRUMB:
                field = "starCrumb"
                break
            case MailType.BOND_TOKEN:
                field = "bondToken"
                break
            case MailType.BOSS_BOOST_POINT:
                field = "bossBoostPoint"
                break
            case MailType.BOOST_POINT:
                field = "boostPoint"
                break
            case MailType.RANK_POINT:
                field = "rankPoint"
                break
        }
        if (field === null) continue
        addDedicatedReward(balance, field, mail.number)
        update[field] = balance[field]
    }
    return { balance, update }
}

function projectMailUserInfo(
    mails: readonly RawPlayerMail[],
    playerAfter: { freeMana: number, freeVmoney: number, expPool: number },
    dedicatedAfter: DedicatedMailBalance,
): Record<string, number> {
    const userInfo: Record<string, number> = {}
    for (const mail of mails) {
        switch (mail.type) {
            case MailType.PAID_VMONEY:
                userInfo.vmoney = dedicatedAfter.vmoney
                break
            case MailType.FREE_VMONEY:
                userInfo.free_vmoney = playerAfter.freeVmoney
                break
            case MailType.STAR_CRUMB:
                userInfo.star_crumb = dedicatedAfter.starCrumb
                break
            case MailType.FREE_MANA:
                userInfo.free_mana = playerAfter.freeMana
                break
            case MailType.EXP_POOL:
                userInfo.exp_pool = playerAfter.expPool
                break
            case MailType.BOND_TOKEN:
                userInfo.bond_token = dedicatedAfter.bondToken
                break
            case MailType.BOSS_BOOST_POINT:
                userInfo.boss_boost_point = dedicatedAfter.bossBoostPoint
                break
            case MailType.BOOST_POINT:
                userInfo.boost_point = dedicatedAfter.boostPoint
                break
            case MailType.RANK_POINT:
                userInfo.rank_point = dedicatedAfter.rankPoint
                break
        }
    }
    return userInfo
}

export function settleMailRewardsInTransactionOwnerSync(
    playerId: number,
    mails: readonly RawPlayerMail[],
    knownPlayerBefore: Player,
): MailRewardSettlement {
    const plan = createMailRewardPlan(mails)
    const dedicated = settleDedicatedMailBalance(mails, knownPlayerBefore)
    const grant = executeRewardGrantPlanInTransactionOwnerSync(
        playerId,
        plan,
        knownPlayerBefore,
    )
    if (Object.keys(dedicated.update).length > 0) {
        updatePlayerSync({ id: playerId, ...dedicated.update })
    }
    for (const mail of mails) {
        insertReceiveHistorySync(playerId, {
            type: mail.type,
            type_id: mail.type_id,
            number: mail.number,
        })
    }
    return {
        characterList: grant.aggregate.character_list as Record<string, unknown>[],
        equipmentList: grant.aggregate.equipment_list as Record<string, unknown>[],
        itemList: grant.aggregate.items,
        userInfo: projectMailUserInfo(mails, grant.playerAfter, dedicated.balance),
    }
}
