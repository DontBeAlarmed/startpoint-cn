import {
    getPlayerGachaCampaignSync,
    getPlayerGachaInfoSync,
    insertPlayerGachaCampaignSync,
    insertPlayerGachaInfoSync,
    updatePlayerGachaCampaignSync,
    updatePlayerGachaInfoSync,
} from "../../data/domains/gacha"
import {
    incrementActiveMissionGachaCampaignCountSync,
    incrementActiveMissionGachaCharacterCountSync,
} from "../../data/domains/active_mission_counters"
import { insertReceiveHistoryBatchSync, MailType } from "../../data/domains/mail"
import { getPlayerSync, updatePlayerSync } from "../../data/domains/player"
import type { PlayerGachaCampaign } from "../../data/types"
import { getDb } from "../../data/db"
import { updatePlayerStarsGachaCampaignCountsSync } from "../../data/domains/gacha-state"
import { deepFreeze } from "../../content/deep-freeze"
import {
    drawGachaBannerWithMetadata,
    GachaCampaignPeriodError,
    GachaPeriodError,
    GachaRequestError,
    getGachaCatalog,
    prepareGachaExecRequest,
} from "../gacha-catalog"
import { buildGachaExecPlan } from "../gacha-exec-plan"
import { GACHA_EXEC_TYPES } from "../gacha-rules"
import { getGachaTicketCost } from "../gacha-ticket"
import {
    grantGachaRewardPlanInTransactionOwnerWithInventorySync,
} from "../gacha-reward-grant"
import { planCharacterGachaMovies, rewardPlayerGachaDrawResultSync } from "../gacha"
import { withDeferredInventoryBatchContextWithinTransactionSync } from "../inventory"
import { getMailArrivedSync } from "../mail-notification"
import type { GachaCharacterDraw, GachaEquipmentDraw } from "../types"
import type {
    GachaExecCommand,
    GachaExecRejected,
    GachaExecResult,
    GachaExecProtocolRejected,
    GachaPostCommitEffect,
} from "./model"
import { getPlayerGachaExecutionStateSync } from "./player-period"

function rejected(message: string): GachaExecRejected {
    return { ok: false, kind: "badRequest", message }
}

function protocolRejected(
    error: GachaPeriodError | GachaCampaignPeriodError,
): GachaExecProtocolRejected {
    return {
        ok: false,
        kind: "protocolResultCode",
        resultCode: error.resultCode as 1351 | 1361,
        message: error.message,
    }
}

function recordSnapshots(
    values: readonly Object[],
    subject: string,
): Readonly<Record<string, unknown>>[] {
    return values.map(value => {
        if (value === null || typeof value !== "object" || Array.isArray(value)) {
            throw new TypeError(`${subject} result is not an object.`)
        }
        return value as Record<string, unknown>
    })
}

export function executeGachaDrawSync(command: GachaExecCommand): GachaExecResult {
    const catalog = getGachaCatalog()
    try {
        return getDb().transaction(() => {
            const player = getPlayerSync(command.playerId)
            if (player === null) throw new Error("Gacha player disappeared during execution")
            return withDeferredInventoryBatchContextWithinTransactionSync({
                playerId: command.playerId,
                playerExistence: "caller-verified",
            }, inventory => {
                const banner = catalog.banners[String(command.gachaId)]
                if (banner === undefined) return rejected("Gacha does not exist.")
                let playerGachaData = getPlayerGachaInfoSync(command.playerId, command.gachaId)
                const playerExecutionState = getPlayerGachaExecutionStateSync(
                    command.playerId,
                    banner,
                )
                if (playerExecutionState.starsCampaign !== undefined) {
                    const starsDefinition = catalog.starsCampaigns[
                        String(playerExecutionState.starsCampaign.campaignId)
                    ]
                    if (starsDefinition === undefined
                        || starsDefinition.gachaId !== command.gachaId
                        || playerExecutionState.starsCampaign.freeOneTimes
                            > starsDefinition.maximumFreeGachaTimes
                        || playerExecutionState.starsCampaign.freeTenTimes
                            > starsDefinition.maximumFreeGachaTimes) {
                        return rejected("Stars Gacha state is invalid.")
                    }
                }
                const ticket = getGachaTicketCost(
                    command.execType,
                    command.numberOfExec,
                    banner.definition,
                )
                const hasApplicableTicket = ticket !== null
                    && inventory.read(ticket.itemId).afterAmount >= ticket.useTicketCount
                const prepared = prepareGachaExecRequest({
                    catalog,
                    gachaId: command.gachaId,
                    paymentType: command.paymentType,
                    execType: command.execType,
                    numberOfExec: command.numberOfExec,
                    nowMs: command.nowMs,
                    playerEffectivePeriod: playerExecutionState.effectivePeriod,
                    hasApplicableTicket,
                })
                if (prepared.kind !== "ordinary") {
                    return rejected("Crazy Gacha requires the candidate lifecycle.")
                }

                const insertPlayerGachaData = playerGachaData === null
                playerGachaData = playerGachaData ?? {
                    gachaId: command.gachaId,
                    isAccountFirst: true,
                    isDailyFirst: true,
                    gachaExchangePoint: 0,
                }
                let plannedCampaign: PlayerGachaCampaign | null = null
                const planResult = buildGachaExecPlan({
                    gacha: prepared.banner.definition,
                    paymentType: command.paymentType,
                    execType: command.execType,
                    numberOfExec: command.numberOfExec,
                    playerFunds: {
                        freeVmoney: player.freeVmoney,
                        paidVmoney: player.vmoney,
                    },
                    playerGachaData,
                    getTicketCount: itemId => inventory.read(itemId).afterAmount,
                    getCampaignState: () => {
                        const campaign = prepared.campaign
                        if (campaign === null) return null
                        const existing = getPlayerGachaCampaignSync(
                            command.playerId,
                            command.gachaId,
                            campaign.campaignId,
                        )
                        plannedCampaign = existing ?? {
                            gachaId: command.gachaId,
                            campaignId: campaign.campaignId,
                            count: 1,
                        }
                        return {
                            campaignId: campaign.campaignId,
                            count: plannedCampaign.count,
                            insert: existing === null,
                        }
                    },
                })
                if (!planResult.ok) return rejected(planResult.message)

                const plan = planResult.plan
                const starsCampaignList = []
                if (plan.campaign !== null && playerExecutionState.starsCampaign !== undefined) {
                    const stars = playerExecutionState.starsCampaign
                    const definition = catalog.starsCampaigns[String(stars.campaignId)]
                    if (definition === undefined || definition.gachaId !== command.gachaId) {
                        return rejected("Stars Gacha state is invalid.")
                    }
                    const isTen = command.execType === GACHA_EXEC_TYPES.CAMPAIGN_MULTI
                    const used = isTen ? stars.freeTenTimes : stars.freeOneTimes
                    if (used >= definition.maximumFreeGachaTimes) {
                        return rejected("Stars Gacha free draw limit reached.")
                    }
                    const after = {
                        campaignId: stars.campaignId,
                        freeOneTimes: stars.freeOneTimes + (isTen ? 0 : 1),
                        freeTenTimes: stars.freeTenTimes + (isTen ? 1 : 0),
                    }
                    updatePlayerStarsGachaCampaignCountsSync({
                        playerId: command.playerId,
                        gachaId: command.gachaId,
                        ...after,
                    })
                    starsCampaignList.push(after)
                }
                const drawMetadata = drawGachaBannerWithMetadata(prepared.banner, plan.pullCount)
                const drawResult = drawMetadata.map(draw => draw.id)
                const characterMoviePlan = prepared.banner.kind === "character"
                    ? planCharacterGachaMovies(prepared.banner.definition, drawResult)
                    : undefined
                const exchangePoint = (playerGachaData.gachaExchangePoint ?? 0) + plan.pullCount
                const ticketItemBalances: Record<number, number> = {}
                if (plan.ticket !== null) {
                    ticketItemBalances[plan.ticket.itemId] = inventory.deduct(
                        plan.ticket.itemId,
                        plan.ticket.useTicketCount,
                    ).afterAmount
                }

                const campaignList = []
                if (plan.campaign !== null) {
                    const campaignData = plannedCampaign ?? {
                        gachaId: command.gachaId,
                        campaignId: plan.campaign.campaignId,
                        count: plan.campaign.count,
                    }
                    campaignData.count = plan.campaign.count
                    if (plan.campaign.insert) insertPlayerGachaCampaignSync(command.playerId, campaignData)
                    else updatePlayerGachaCampaignSync(
                        command.playerId,
                        command.gachaId,
                        plan.campaign.campaignId,
                        plan.campaign.count,
                    )
                    campaignList.push({
                        gachaId: campaignData.gachaId,
                        campaignId: campaignData.campaignId,
                        count: campaignData.count,
                    })
                }

                // Gate §7 顺序：Stone 扣费落库先于 RewardGrant adapters，
                // 使 knownPlayerBefore 与 grant 时刻的 DB 真值一致（资源 CAS 依赖）。
                updatePlayerSync({
                    id: command.playerId,
                    vmoney: plan.paidVmoney,
                    freeVmoney: plan.freeVmoney,
                })

                const postCommitEffects: GachaPostCommitEffect[] = []
                const reward = rewardPlayerGachaDrawResultSync(
                    command.playerId,
                    prepared.banner.definition,
                    drawResult,
                    drawMetadata,
                    characterMoviePlan,
                    {
                        ownerGrant: rewardPlan => (
                            grantGachaRewardPlanInTransactionOwnerWithInventorySync(
                                command.playerId,
                                rewardPlan,
                                {
                                    id: player.id,
                                    freeMana: player.freeMana,
                                    freeVmoney: plan.freeVmoney,
                                    expPool: player.expPool,
                                },
                                inventory,
                            )
                        ),
                        collectSeedMark: mark => postCommitEffects.push({
                            kind: "seedMark",
                            ...mark,
                        }),
                        collectCharacterSampledLog: snapshot => (
                            postCommitEffects.push({ kind: "sampledLog", ...snapshot })
                        ),
                    },
                )
                const characterSnapshots = prepared.banner.kind === "character"
                    ? recordSnapshots(reward.characters, "Character Gacha")
                    : []
                const equipmentSnapshots = prepared.banner.kind === "equipment"
                    ? recordSnapshots(reward.equipment, "Equipment Gacha")
                    : []
                if (prepared.banner.kind === "character") {
                    postCommitEffects.push({
                        kind: "characterGrowthPublication",
                        playerId: command.playerId,
                        characterIds: [],
                        characters: characterSnapshots,
                        source: "gacha/exec",
                    })
                }

                const historyType = prepared.banner.kind === "character"
                    ? MailType.CHARACTER
                    : MailType.EQUIPMENT
                insertReceiveHistoryBatchSync(
                    command.playerId,
                    drawResult.map(itemId => ({
                        type: historyType,
                        type_id: itemId,
                        number: 1,
                    })),
                )

                const nextGachaData = {
                    gachaId: command.gachaId,
                    isDailyFirst: command.execType === GACHA_EXEC_TYPES.DAILY_SINGLE
                        ? false
                        : playerGachaData.isDailyFirst,
                    isAccountFirst: command.execType === GACHA_EXEC_TYPES.ACCOUNT_PAID_MULTI
                        ? false
                        : playerGachaData.isAccountFirst,
                    gachaExchangePoint: exchangePoint,
                }
                if (insertPlayerGachaData) insertPlayerGachaInfoSync(command.playerId, nextGachaData)
                else updatePlayerGachaInfoSync(command.playerId, nextGachaData)
                if (prepared.banner.kind === "character") {
                    incrementActiveMissionGachaCharacterCountSync(command.playerId, drawResult.length)
                }
                if (plan.campaign !== null) {
                    incrementActiveMissionGachaCampaignCountSync(command.playerId)
                }
                const mailArrived = getMailArrivedSync(command.playerId)
                const successBase = {
                    ok: true as const,
                    playerId: command.playerId,
                    gachaId: command.gachaId,
                    freeVmoney: plan.freeVmoney,
                    paidVmoney: plan.paidVmoney,
                    exchangePoint,
                    isDailyFirst: nextGachaData.isDailyFirst,
                    isAccountFirst: nextGachaData.isAccountFirst,
                    mailArrived,
                    ticketItemBalances,
                    campaignList,
                    starsCampaignList,
                    rewardItems: reward.items,
                    ...(reward.playerAfter === undefined ? {} : {
                        playerAfter: reward.playerAfter,
                    }),
                    itemOverflowDispositions: reward.itemOverflowDispositions ?? [],
                    postCommitEffects,
                }
                return prepared.banner.kind === "character"
                    ? deepFreeze({
                        ...successBase,
                        kind: "character" as const,
                        draw: reward.draw as GachaCharacterDraw[],
                        characters: characterSnapshots,
                    })
                    : deepFreeze({
                        ...successBase,
                        kind: "equipment" as const,
                        draw: reward.draw as GachaEquipmentDraw[],
                        equipment: equipmentSnapshots,
                        isErupt: reward.isErupt ?? false,
                    })
            })
        })()
    } catch (error) {
        if (error instanceof GachaPeriodError || error instanceof GachaCampaignPeriodError) {
            return protocolRejected(error)
        }
        if (error instanceof GachaRequestError) return rejected(error.message)
        throw error
    }
}
