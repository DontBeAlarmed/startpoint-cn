import { deepFreeze } from "../../content/deep-freeze"
import { getDb } from "../../data/db"
import {
    clearPlayerCrazyGachaResultsSync,
    getPlayerCrazyGachaGachaIdsSync,
    getPlayerCrazyGachaIdsWithSlotZeroSync,
    getPlayerCrazyGachaResultsSync,
    replacePlayerCrazyGachaSlotZeroSync,
    savePlayerCrazyGachaSlotSync,
} from "../../data/domains/gacha-lifecycle-state"
import {
    getPlayerGachaInfoSync,
    insertPlayerGachaInfoSync,
    updatePlayerGachaInfoSync,
} from "../../data/domains/gacha"
import { insertReceiveHistoryBatchSync, MailType } from "../../data/domains/mail"
import { getPlayerSync } from "../../data/domains/player"
import { getCharacterAcquisitionStatesSync } from "../../data/domains/reward-acquisition"
import { getCharacterDataSync } from "../assets"
import { getCrazyGachaPolicySync } from "../config-content"
import { getCharacterStackCompensationItemId } from "../character-growth/commands/grant-character-stack"
import {
    drawGachaBannerWithMetadata,
    GachaCampaignPeriodError,
    GachaPeriodError,
    GachaRequestError,
    getGachaCatalog,
    isGachaPeriodAvailable,
    prepareGachaExecRequest,
} from "../gacha-catalog"
import { planCharacterGachaMovies } from "../gacha"
import {
    grantGachaRewardPlanInTransactionOwnerWithInventorySync,
} from "../gacha-reward-grant"
import { withDeferredInventoryBatchContextWithinTransactionSync } from "../inventory"
import { getMailArrivedSync } from "../mail-notification"
import {
    collectRewardGrantItemOverflowDispositions,
    createRewardGrantExecutionPlan,
} from "../reward-grant"
import type { Element, GachaCharacterDraw } from "../types"
import { RewardType } from "../types/rewards"
import type {
    CrazyGachaCandidateResult,
    CrazyGachaSaveResult,
    CrazyGachaSelectResult,
    GachaExecCommand,
    GachaExecProtocolRejected,
    GachaExecRejected,
    GachaPostCommitEffect,
} from "./model"
import { getPlayerGachaExecutionStateSync } from "./player-period"

function badRequest(message: string): GachaExecRejected {
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

function lifecycleAvailable(
    banner: ReturnType<typeof getGachaCatalog>["banners"][string],
    nowMs: number,
): boolean {
    return isGachaPeriodAvailable({
        availableFrom: banner.basePeriod.availableFrom,
        availableUntil: banner.ticketExpiryTime ?? banner.basePeriod.availableUntil,
    }, nowMs)
}

function slots(playerId: number, gachaId: number): Readonly<Record<number, readonly number[]>> {
    const result: Record<number, number[]> = {}
    for (const row of getPlayerCrazyGachaResultsSync(playerId, gachaId)) {
        ;(result[row.slotIndex] ??= []).push(row.characterId)
    }
    return result
}

export function projectCrazyGachaLoadStateSync(
    playerId: number,
): Readonly<{
    crazyGachaResultList: Readonly<Record<number, readonly number[]>>
    lastCrazyGachaDrawResult: readonly GachaCharacterDraw[]
}> {
    // 当前 Content 每个 snapshot 至多一个 page kind 5 banner；取持有槽位数据的
    // 最小 gacha_id，与 save 路径的动态推导保持对称，不硬编码 banner id。
    const gachaId = getPlayerCrazyGachaGachaIdsSync(playerId)[0]
    if (gachaId === undefined) return deepFreeze({
        crazyGachaResultList: {},
        lastCrazyGachaDrawResult: [],
    })
    const rows = getPlayerCrazyGachaResultsSync(playerId, gachaId)
    const slotZero = rows.filter(row => row.slotIndex === 0)
    const lastCrazyGachaDrawResult = slotZero.length === 10
        ? slotZero.map(row => ({
            character_id: row.characterId,
            movie_id: row.movieId as string,
            seed: row.seed as number,
            entry_count: row.entryCount as number,
            ...(row.exBoostItemId === null || row.exBoostItemCount === null ? {} : {
                ex_boost_item: { id: row.exBoostItemId, count: row.exBoostItemCount },
            }),
        }))
        : []
    return deepFreeze({
        crazyGachaResultList: slots(playerId, gachaId),
        lastCrazyGachaDrawResult,
    })
}

export function executeCrazyGachaCandidateSync(
    command: GachaExecCommand,
): CrazyGachaCandidateResult {
    const catalog = getGachaCatalog()
    try {
        return getDb().transaction(() => {
            const player = getPlayerSync(command.playerId)
            if (player === null) throw new Error("Crazy Gacha player disappeared")
            return withDeferredInventoryBatchContextWithinTransactionSync({
                playerId: command.playerId,
                playerExistence: "caller-verified",
            }, inventory => {
                const banner = catalog.banners[String(command.gachaId)]
                if (banner === undefined) return badRequest("Gacha does not exist.")
                const state = getPlayerGachaExecutionStateSync(command.playerId, banner)
                const ticket = banner.definition.crazyTenTicketItemId
                const prepared = prepareGachaExecRequest({
                    catalog,
                    gachaId: command.gachaId,
                    paymentType: command.paymentType,
                    execType: command.execType,
                    numberOfExec: command.numberOfExec,
                    nowMs: command.nowMs,
                    playerEffectivePeriod: state.effectivePeriod,
                    hasApplicableTicket: ticket !== undefined
                        && inventory.read(ticket).afterAmount > 0,
                })
                if (prepared.kind !== "crazyCandidate"
                    || prepared.banner.kind !== "character"
                    || prepared.ticket === null) {
                    return badRequest("Crazy Gacha request is invalid.")
                }
                const info = getPlayerGachaInfoSync(command.playerId, command.gachaId)
                const crazyDrawCount = (info?.crazyDrawCount ?? 0) + 1
                if (crazyDrawCount > getCrazyGachaPolicySync().tenDrawMaxCount) {
                    return badRequest("Crazy Gacha draw limit reached.")
                }
                if (inventory.read(prepared.ticket.itemId).afterAmount
                    < prepared.ticket.useTicketCount) {
                    return badRequest("Not enough Gacha tickets.")
                }

                const metadata = drawGachaBannerWithMetadata(prepared.banner, 10)
                const characterIds = metadata.map(draw => draw.id)
                const movies = planCharacterGachaMovies(
                    prepared.banner.definition,
                    characterIds,
                )
                const owned = getCharacterAcquisitionStatesSync(
                    command.playerId,
                    characterIds,
                )
                const seen = new Set(Object.keys(owned).map(Number))
                const draw: GachaCharacterDraw[] = characterIds.map((characterId, index) => {
                    const movie = movies[index]
                    const duplicate = seen.has(characterId)
                    seen.add(characterId)
                    const asset = duplicate ? getCharacterDataSync(characterId) : null
                    const itemId = asset === null ? undefined : getCharacterStackCompensationItemId(
                        asset.rarity,
                        asset.element as Element,
                    )
                    return {
                        character_id: characterId,
                        movie_id: movie.movieId,
                        seed: movie.seed,
                        entry_count: 1,
                        ...(itemId === undefined ? {} : {
                            ex_boost_item: { id: itemId, count: 1 },
                        }),
                    }
                })
                const ticketAfter = inventory.deduct(
                    prepared.ticket.itemId,
                    prepared.ticket.useTicketCount,
                ).afterAmount
                const nextInfo = {
                    gachaId: command.gachaId,
                    isDailyFirst: info?.isDailyFirst ?? true,
                    isAccountFirst: info?.isAccountFirst ?? true,
                    gachaExchangePoint: info?.gachaExchangePoint ?? 0,
                    crazyDrawCount,
                }
                if (info === null) insertPlayerGachaInfoSync(command.playerId, nextInfo)
                else updatePlayerGachaInfoSync(command.playerId, nextInfo)
                replacePlayerCrazyGachaSlotZeroSync({
                    playerId: command.playerId,
                    gachaId: command.gachaId,
                    draws: draw.map(entry => {
                        const exBoost = entry.ex_boost_item
                        return {
                            characterId: entry.character_id,
                            movieId: entry.movie_id,
                            seed: entry.seed,
                            entryCount: entry.entry_count,
                            exBoostItemId: exBoost === undefined || Array.isArray(exBoost)
                                ? null : exBoost.id,
                            exBoostItemCount: exBoost === undefined || Array.isArray(exBoost)
                                ? null : exBoost.count,
                        }
                    }),
                })
                inventory.flush()
                const postCommitEffects: GachaPostCommitEffect[] = movies
                    .filter(movie => movie.requiresVerification)
                    .map(movie => ({
                        kind: "seedMark" as const,
                        movieId: movie.movieId,
                        seed: movie.seed,
                        rarity: movie.rarity,
                    }))
                return deepFreeze({
                    ok: true as const,
                    kind: "crazyCandidate" as const,
                    playerId: command.playerId,
                    gachaId: command.gachaId,
                    draw,
                    crazyDrawCount,
                    exchangePoint: nextInfo.gachaExchangePoint,
                    isDailyFirst: nextInfo.isDailyFirst,
                    isAccountFirst: nextInfo.isAccountFirst,
                    ticketItemBalances: { [prepared.ticket.itemId]: ticketAfter },
                    slots: slots(command.playerId, command.gachaId),
                    postCommitEffects,
                })
            })
        })()
    } catch (error) {
        if (error instanceof GachaPeriodError || error instanceof GachaCampaignPeriodError) {
            return protocolRejected(error)
        }
        if (error instanceof GachaRequestError) return badRequest(error.message)
        throw error
    }
}

export function saveCrazyGachaCandidateSync(input: {
    readonly playerId: number
    readonly targetSlot: 1 | 2
    readonly nowMs: number
}): CrazyGachaSaveResult {
    return getDb().transaction(() => {
        const gachaIds = getPlayerCrazyGachaIdsWithSlotZeroSync(input.playerId)
        if (gachaIds.length !== 1) return badRequest("No unique Crazy Gacha result exists.")
        const gachaId = gachaIds[0]
        const banner = getGachaCatalog().banners[String(gachaId)]
        if (banner === undefined || banner.pageKind !== 5 || !lifecycleAvailable(banner, input.nowMs)) {
            return {
                ok: false as const,
                kind: "protocolResultCode" as const,
                resultCode: 1351 as const,
                message: "Crazy Gacha result is outside its available period.",
            }
        }
        if (!savePlayerCrazyGachaSlotSync(input.playerId, gachaId, input.targetSlot)) {
            return badRequest("Crazy Gacha result cannot be saved.")
        }
        return deepFreeze({
            ok: true as const,
            kind: "crazySave" as const,
            gachaId,
            slots: slots(input.playerId, gachaId),
        })
    })()
}

export function selectCrazyGachaCandidateSync(input: {
    readonly playerId: number
    readonly gachaId: number
    readonly slot: 0 | 1 | 2
    readonly nowMs: number
}): CrazyGachaSelectResult {
    const banner = getGachaCatalog().banners[String(input.gachaId)]
    if (banner === undefined || banner.kind !== "character" || banner.pageKind !== 5) {
        return badRequest("Crazy Gacha is invalid.")
    }
    if (!lifecycleAvailable(banner, input.nowMs)) {
        return {
            ok: false,
            kind: "protocolResultCode",
            resultCode: 1351,
            message: "Crazy Gacha is outside its available period.",
        }
    }
    return getDb().transaction(() => withDeferredInventoryBatchContextWithinTransactionSync({
        playerId: input.playerId,
        playerExistence: "caller-verified",
    }, inventory => {
        const player = getPlayerSync(input.playerId)
        if (player === null) throw new Error("Crazy Gacha player disappeared")
        const rows = getPlayerCrazyGachaResultsSync(input.playerId, input.gachaId)
            .filter(row => row.slotIndex === input.slot)
        if (rows.length !== 10 || rows.some((row, index) => row.position !== index)) {
            return badRequest("Crazy Gacha result is incomplete.")
        }
        const allowed = new Set(Object.values(banner.poolsByRank).flatMap(pool => (
            pool.items.map(item => item.id)
        )))
        const characterIds = rows.map(row => row.characterId)
        if (characterIds.some(characterId => !allowed.has(characterId))) {
            return badRequest("Crazy Gacha result contains an invalid Character.")
        }
        const plan = createRewardGrantExecutionPlan(characterIds.map(characterId => ({
            type: RewardType.CHARACTER,
            id: characterId,
        })))
        const grant = grantGachaRewardPlanInTransactionOwnerWithInventorySync(
            input.playerId,
            plan,
            {
                id: player.id,
                freeMana: player.freeMana,
                freeVmoney: player.freeVmoney,
                expPool: player.expPool,
            },
            inventory,
        )
        const characters = new Map<number, Readonly<Record<string, unknown>>>()
        const rewardItems: Record<number, number> = {}
        for (let index = 0; index < grant.entries.length; index += 1) {
            const outcome = grant.entries[index].outcome
            if (outcome.kind !== "character") throw new TypeError("Crazy Gacha grant kind mismatch")
            characters.set(characterIds[index], outcome.after)
            if (outcome.compensationItem !== null) {
                rewardItems[outcome.compensationItem.itemId] = outcome.compensationItem.afterAmount
            }
        }
        insertReceiveHistoryBatchSync(input.playerId, characterIds.map(characterId => ({
            type: MailType.CHARACTER,
            type_id: characterId,
            number: 1,
        })))
        clearPlayerCrazyGachaResultsSync(input.playerId, input.gachaId)
        const characterSnapshots = [...characters.values()]
        return deepFreeze({
            ok: true as const,
            kind: "crazySelect" as const,
            playerId: input.playerId,
            gachaId: input.gachaId,
            characters: characterSnapshots,
            rewardItems,
            ...(grant.playerAfter.freeMana === player.freeMana
                && grant.playerAfter.freeVmoney === player.freeVmoney
                && grant.playerAfter.expPool === player.expPool
                ? {}
                : { playerAfter: grant.playerAfter }),
            itemOverflowDispositions: collectRewardGrantItemOverflowDispositions(grant),
            mailArrived: getMailArrivedSync(input.playerId),
            postCommitEffects: [{
                kind: "characterGrowthPublication" as const,
                playerId: input.playerId,
                characterIds,
                characters: characterSnapshots,
                source: "gacha/crazy_select" as const,
            }],
        })
    }))()
}
