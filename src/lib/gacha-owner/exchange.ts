import { deepFreeze } from "../../content/deep-freeze"
import { getDb } from "../../data/db"
import { getPlayerGachaInfoSync, updatePlayerGachaInfoSync } from "../../data/domains/gacha"
import { insertReceiveHistoryBatchSync, MailType } from "../../data/domains/mail"
import { getPlayerSync } from "../../data/domains/player"
import { getMailArrivedSync } from "../mail-notification"
import { withDeferredInventoryBatchContextWithinTransactionSync } from "../inventory"
import { createRewardGrantExecutionPlan } from "../reward-grant"
import { RewardType } from "../types/rewards"
import { getGachaCatalog, isGachaPeriodAvailable } from "../gacha-catalog"
import type { GachaCatalog } from "../gacha-catalog"
import { getGachaTicketCost } from "../gacha-ticket"
import { GACHA_EXEC_TYPES } from "../gacha-rules"
import {
    collectRewardGrantItemOverflowDispositions,
} from "../reward-grant"
import {
    grantGachaRewardPlanInTransactionOwnerWithInventorySync,
} from "../gacha-reward-grant"
import { getPlayerGachaExecutionStateSync } from "./player-period"
import type {
    GachaExchangeResult,
    GachaPostCommitEffect,
} from "./model"

export type GachaExchangeCommand = Readonly<{
    playerId: number
    gachaId: number
    targetId: number
    kind: "character" | "equipment"
    nowMs: number
}>

function badRequest(message: string): GachaExchangeResult {
    return { ok: false, kind: "badRequest", message }
}

function periodRejected(message: string): GachaExchangeResult {
    return {
        ok: false,
        kind: "protocolResultCode",
        resultCode: 1351,
        message,
    }
}

function ticketExecTypes(kind: "character" | "equipment"): readonly number[] {
    return kind === "character"
        ? [
            GACHA_EXEC_TYPES.SINGLE_CONFIGURED_TICKET,
            GACHA_EXEC_TYPES.MULTI_CONFIGURED_TICKET,
            GACHA_EXEC_TYPES.SINGLE_TICKET,
            GACHA_EXEC_TYPES.MULTI_TICKET,
            GACHA_EXEC_TYPES.SINGLE_RARE4_TICKET,
        ]
        : [
            GACHA_EXEC_TYPES.SINGLE_CONFIGURED_TICKET,
            GACHA_EXEC_TYPES.MULTI_CONFIGURED_TICKET,
            GACHA_EXEC_TYPES.SINGLE_WEAPON_TICKET,
            GACHA_EXEC_TYPES.MULTI_WEAPON_TICKET,
        ]
}

function records(values: readonly Object[], subject: string): Readonly<Record<string, unknown>>[] {
    return values.map(value => {
        if (value === null || typeof value !== "object" || Array.isArray(value)) {
            throw new TypeError(`${subject} exchange result is invalid`)
        }
        return value as Record<string, unknown>
    })
}

export function executeGachaExchangeSync(
    command: GachaExchangeCommand,
    dependencies: { readonly catalog?: GachaCatalog } = {},
): GachaExchangeResult {
    const catalog = dependencies.catalog ?? getGachaCatalog()
    const banner = catalog.banners[String(command.gachaId)]
    if (banner === undefined || banner.kind !== command.kind || banner.pageKind === 5) {
        return badRequest("Gacha exchange target is invalid.")
    }
    const target = catalog.exchangeableByGachaAndItem[`${command.gachaId}:${command.targetId}`]
    if (target === undefined) return badRequest("Gacha exchange target is not exchangeable.")
    const rate = catalog.exchangeRates[command.kind][String(target.rank)]
    if (!Number.isSafeInteger(rate) || rate <= 0) throw new TypeError("Gacha exchange rate is invalid")

    return getDb().transaction(() => withDeferredInventoryBatchContextWithinTransactionSync({
        playerId: command.playerId,
        playerExistence: "caller-verified",
    }, inventory => {
        const player = getPlayerSync(command.playerId)
        if (player === null) throw new Error("Gacha exchange player disappeared")
        const info = getPlayerGachaInfoSync(command.playerId, command.gachaId)
        if (info === null) return badRequest("No Gacha state exists for exchange.")
        const playerState = getPlayerGachaExecutionStateSync(command.playerId, banner)
        const basePeriod = banner.definition.isComeback || banner.definition.isStarsGacha
            ? playerState.effectivePeriod
            : banner.basePeriod
        if (basePeriod === undefined) return periodRejected("Gacha exchange period is unavailable.")

        const baseAvailable = isGachaPeriodAvailable(basePeriod, command.nowMs)
        let extendedAvailable = false
        if (!baseAvailable && banner.ticketExpiryTime !== undefined) {
            const ticketIds = [...new Set(ticketExecTypes(command.kind).flatMap(execType => {
                const ticket = getGachaTicketCost(execType, 1, banner.definition)
                return ticket === null ? [] : [ticket.itemId]
            }))]
            const hasExtendingTicket = inventory.readMany(ticketIds).some(item => item.afterAmount > 0)
            extendedAvailable = hasExtendingTicket && isGachaPeriodAvailable({
                availableFrom: basePeriod.availableFrom,
                availableUntil: banner.ticketExpiryTime,
            }, command.nowMs)
        }
        if (!baseAvailable && !extendedAvailable) {
            return periodRejected("Gacha exchange is outside its available period.")
        }

        const exchangePoint = (info.gachaExchangePoint ?? 0) - rate
        if (exchangePoint < 0) return badRequest("Not enough Gacha exchange points.")
        const rewardPlan = createRewardGrantExecutionPlan([
            command.kind === "character"
                ? { type: RewardType.CHARACTER, id: command.targetId }
                : { type: RewardType.EQUIPMENT, id: command.targetId, count: 1 },
        ])
        const grant = grantGachaRewardPlanInTransactionOwnerWithInventorySync(
            command.playerId,
            rewardPlan,
            {
                id: player.id,
                freeMana: player.freeMana,
                freeVmoney: player.freeVmoney,
                expPool: player.expPool,
            },
            inventory,
        )
        const outcome = grant.entries[0]?.outcome
        if (outcome === undefined || outcome.kind !== command.kind) {
            throw new TypeError("Gacha exchange reward kind mismatch")
        }
        updatePlayerGachaInfoSync(command.playerId, {
            gachaId: command.gachaId,
            gachaExchangePoint: exchangePoint,
        })
        insertReceiveHistoryBatchSync(command.playerId, [{
            type: command.kind === "character" ? MailType.CHARACTER : MailType.EQUIPMENT,
            type_id: command.targetId,
            number: 1,
        }])
        const rewardItems: Record<number, number> = {}
        const postCommitEffects: GachaPostCommitEffect[] = []
        let characters: Readonly<Record<string, unknown>>[] = []
        let equipment: Readonly<Record<string, unknown>>[] = []
        if (outcome.kind === "character") {
            characters = records([outcome.after], "Character")
            if (outcome.compensationItem !== null) {
                rewardItems[outcome.compensationItem.itemId] = outcome.compensationItem.afterAmount
            }
            postCommitEffects.push({
                kind: "characterGrowthPublication",
                playerId: command.playerId,
                characterIds: [command.targetId],
                characters,
                source: "gacha/exchange_character",
            })
        } else {
            equipment = records([outcome.after], "Equipment")
        }
        const common = {
            ok: true as const,
            playerId: command.playerId,
            gachaId: command.gachaId,
            targetId: command.targetId,
            exchangePoint,
            isDailyFirst: info.isDailyFirst,
            isAccountFirst: info.isAccountFirst,
            mailArrived: getMailArrivedSync(command.playerId),
            rewardItems,
            ...(grant.playerAfter.freeMana === player.freeMana
                ? {}
                : { playerAfter: grant.playerAfter }),
            itemOverflowDispositions: collectRewardGrantItemOverflowDispositions(grant),
            postCommitEffects,
        }
        return command.kind === "character"
            ? deepFreeze({ ...common, kind: "character" as const, characters })
            : deepFreeze({ ...common, kind: "equipment" as const, equipment })
    }))()
}
