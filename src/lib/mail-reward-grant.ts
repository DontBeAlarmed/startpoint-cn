import {
    insertReceiveHistorySync,
    MailType,
    type RawPlayerMail,
} from "../data/domains/mail"
import { updatePlayerSync } from "../data/domains/player"
import type { Player } from "../data/types"
import bundledConfig from "../../assets/config.json"
import { getRuntimeContentTableSync } from "../content/runtime/table-access"
import type { ConfigValues } from "./types/config"
import {
    findItemInventoryPolicy,
    getItemInventoryPolicyCatalog,
} from "./inventory/item-inventory-policy"
import { isEventTradeExpiredAt } from "./inventory/event-trade-expiry-plan"
import { planManaCapacity } from "./inventory/mana-capacity-plan"
import {
    createRewardGrantExecutionPlan,
    collectRewardGrantItemOverflowDispositions,
    executeRewardGrantExecutionPlanAsTransactionOwnerSync,
    type RewardGrantCommand,
    type RewardGrantExecutionPlan,
    type RewardGrantItemOverflowPolicy,
} from "./reward-grant"
import { RewardType } from "./types/rewards"
import { getVirtualNow } from "../runtime/time/game-time"
import type { PlannedItemOverflowDisposition } from "./item-overflow"
import { createRewardGrantItemOverflowPolicy } from "./reward-grant-item-overflow"

export interface MailRewardSettlement {
    readonly characterList: Record<string, unknown>[]
    readonly equipmentList: Record<string, unknown>[]
    readonly itemList: Record<string, number>
    readonly userInfo: Record<string, number>
    readonly autoSaleExpiredMailCount: number
    readonly playerAfter: Player
    readonly itemOverflowDispositions?: readonly PlannedItemOverflowDisposition[]
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

export class MailRewardCapacityError extends Error {
    constructor(message: string) {
        super(message)
        this.name = "MailRewardCapacityError"
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

function standardReward(mail: RawPlayerMail): RewardGrantCommand | null {
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
): RewardGrantExecutionPlan {
    const entries: RewardGrantCommand[] = []
    for (const mail of mails) {
        validateMailReward(mail)
        const reward = standardReward(mail)
        if (reward === null) continue
        const attachmentCount = mail.type === MailType.CHARACTER ? mail.number : 1
        for (let attachmentIndex = 0; attachmentIndex < attachmentCount; attachmentIndex++) {
            entries.push(reward)
        }
    }
    return createRewardGrantExecutionPlan(entries)
}

function addSafe(left: number, right: number, field: string): number {
    const result = left + right
    if (!Number.isSafeInteger(result) || result < 0) {
        throw new UnsupportedMailAttachmentError(`${field} exceeds the safe integer range.`)
    }
    return result
}

function settlementReward(
    mail: RawPlayerMail,
    now: Date,
): { reward: RewardGrantCommand | null, autoSold: boolean } {
    const reward = standardReward(mail)
    if (mail.type !== MailType.ITEM) return { reward, autoSold: false }
    const catalog = getItemInventoryPolicyCatalog()
    const policy = findItemInventoryPolicy(catalog, requireMailTypeId(mail))
    if (policy === null) {
        throw new UnsupportedMailAttachmentError(`Mail ${mail.id} Item policy is unavailable.`)
    }
    if (policy.effectKind !== 9
        || policy.endTimeMs === null
        || !isEventTradeExpiredAt(now.getTime(), policy.endTimeMs)) {
        return { reward, autoSold: false }
    }
    return {
        reward: {
            type: RewardType.MANA,
            count: addSafe(0, mail.number * policy.salePrice, `Mail ${mail.id} sale Mana`),
        },
        autoSold: true,
    }
}

function createMailSettlementPlan(
    mails: readonly RawPlayerMail[],
    now: Date,
): { plan: RewardGrantExecutionPlan, autoSaleExpiredMailCount: number } {
    const entries: RewardGrantCommand[] = []
    let autoSaleExpiredMailCount = 0
    for (const mail of mails) {
        validateMailReward(mail)
        const settlement = settlementReward(mail, now)
        if (settlement.autoSold) autoSaleExpiredMailCount++
        if (settlement.reward === null) continue
        const attachmentCount = mail.type === MailType.CHARACTER ? mail.number : 1
        for (let attachmentIndex = 0; attachmentIndex < attachmentCount; attachmentIndex++) {
            entries.push(settlement.reward)
        }
    }
    return {
        plan: createRewardGrantExecutionPlan(entries),
        autoSaleExpiredMailCount,
    }
}

function createMailClaimItemPolicy(
    playerId: number,
    now: Date,
    knownPaidMana: number,
): RewardGrantItemOverflowPolicy {
    const catalog = getItemInventoryPolicyCatalog()
    const overflowPolicy = createRewardGrantItemOverflowPolicy(playerId, now, knownPaidMana)
    return Object.freeze({
        playerId,
        maxCount(itemId: number): number {
            const policy = findItemInventoryPolicy(catalog, itemId)
            if (policy === null) throw new MailRewardCapacityError(`Item ${itemId} policy is unavailable.`)
            return policy.maxCount
        },
        planOverflow(itemId: number, amount: number, currentFreeMana: number) {
            const policy = findItemInventoryPolicy(catalog, itemId)
            if (policy === null) throw new MailRewardCapacityError(`Item ${itemId} policy is unavailable.`)
            if (policy.sellable && policy.category === 6) {
                return overflowPolicy.planOverflow(itemId, amount, currentFreeMana)
            }
            return Object.freeze({
                kind: "mail" as const,
                itemId,
                overflowAmount: amount,
            })
        },
        finalizeOverflow(disposition: PlannedItemOverflowDisposition) {
            if (disposition.kind === "sold") {
                overflowPolicy.finalizeOverflow(disposition)
                return
            }
            throw new MailRewardCapacityError(
                `Mail Item ${disposition.itemId} cannot fit ${disposition.overflowAmount} additional unit(s).`,
            )
        },
    })
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
    autoSaleExpiredMailCount: number,
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
    if (autoSaleExpiredMailCount > 0) userInfo.free_mana = playerAfter.freeMana
    return userInfo
}

export function settleMailRewardsInTransactionOwnerSync(
    playerId: number,
    mails: readonly RawPlayerMail[],
    knownPlayerBefore: Player,
    now: Date = getVirtualNow(),
): MailRewardSettlement {
    const settlementPlan = createMailSettlementPlan(mails, now)
    const plan = settlementPlan.plan
    const dedicated = settleDedicatedMailBalance(mails, knownPlayerBefore)
    let manaRequested = 0
    for (const entry of plan.entries) {
        if (entry.type === RewardType.MANA) {
            manaRequested = addSafe(manaRequested, entry.count, "Mail Mana")
        }
    }
    const manaCapacity = planManaCapacity({
        freeMana: knownPlayerBefore.freeMana,
        paidMana: knownPlayerBefore.paidMana,
        maxMana: getRuntimeContentTableSync<ConfigValues>(
            "config.json",
            bundledConfig,
        ).max_mana,
        requestedMana: manaRequested,
    })
    if (manaCapacity.overflowMana > 0) {
        throw new MailRewardCapacityError("Mail Mana cannot fit in the player's Mana capacity.")
    }
    const grant = executeRewardGrantExecutionPlanAsTransactionOwnerSync(
        playerId,
        plan,
        {
            playerId: knownPlayerBefore.id,
            freeMana: knownPlayerBefore.freeMana,
            freeVmoney: knownPlayerBefore.freeVmoney,
            expPool: knownPlayerBefore.expPool,
        },
        { itemOverflow: createMailClaimItemPolicy(playerId, now, knownPlayerBefore.paidMana) },
    )
    const itemOverflowDispositions = collectRewardGrantItemOverflowDispositions(grant)
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
    const userInfo = projectMailUserInfo(
        mails,
        grant.playerAfter,
        dedicated.balance,
        settlementPlan.autoSaleExpiredMailCount,
    )
    if (itemOverflowDispositions.some(disposition => disposition.kind === "sold")) {
        userInfo.free_mana = grant.playerAfter.freeMana
    }
    return {
        characterList: grant.assets.characters.map(entry => (
            entry.after as Record<string, unknown>
        )),
        equipmentList: grant.assets.equipment.map(entry => (
            entry.after as Record<string, unknown>
        )),
        itemList: Object.fromEntries(grant.assets.items.map(item => [
            String(item.itemId),
            item.afterAmount,
        ])),
        userInfo,
        autoSaleExpiredMailCount: settlementPlan.autoSaleExpiredMailCount,
        playerAfter: {
            ...knownPlayerBefore,
            freeMana: grant.playerAfter.freeMana,
            freeVmoney: grant.playerAfter.freeVmoney,
            expPool: grant.playerAfter.expPool,
            vmoney: dedicated.balance.vmoney,
            starCrumb: dedicated.balance.starCrumb,
            bondToken: dedicated.balance.bondToken,
            bossBoostPoint: dedicated.balance.bossBoostPoint,
            boostPoint: dedicated.balance.boostPoint,
            rankPoint: dedicated.balance.rankPoint,
        },
        ...(itemOverflowDispositions.length > 0 ? { itemOverflowDispositions } : {}),
    }
}
