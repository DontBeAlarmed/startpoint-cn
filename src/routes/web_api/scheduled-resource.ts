import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify"

import bundledConfig from "../../../assets/config.json"
import bundledItemMaxCounts from "../../../assets/item_max_count.json"
import { getPlayerSync } from "../../data/domains/player"
import {
    deleteScheduledResourceRuleSync,
    getScheduledResourceRuleSync,
    insertScheduledResourceRuleSync,
    listScheduledResourceRulesSync,
    updateScheduledResourceRuleSync,
    type ScheduledResourceRule,
    type ScheduledResourceRuleInput,
} from "../../data/domains/scheduled-resource"
import { getRuntimeContentTableSync } from "../../content/runtime/table-access"
import { getItemLookupSync } from "../../lib/assets"
import type { ConfigValues } from "../../lib/types/config"
import { validateScheduledResourceRuleInput } from "../../lib/scheduled-resource-rules"

interface RuleParams {
    readonly id: string
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value)
}

function parseDate(value: unknown, label: string): Date | null {
    if (value === null || value === undefined || value === "") return null
    if (typeof value !== "string") throw new Error(`${label}无效`)
    const parsed = new Date(value)
    if (!Number.isFinite(parsed.getTime())) throw new Error(`${label}无效`)
    return parsed
}

function parseBody(body: unknown): ScheduledResourceRuleInput {
    if (!isPlainObject(body)) throw new Error("请求内容无效")
    if (body.description !== null && body.description !== undefined
        && typeof body.description !== "string") {
        throw new Error("备注无效")
    }
    const description = typeof body.description === "string"
        ? body.description.trim() || null
        : null
    if ((description?.length ?? 0) > 200) throw new Error("备注最多 200 字符")
    return {
        scope: body.scope as ScheduledResourceRuleInput["scope"],
        playerId: body.playerId as number | null,
        rewardType: body.rewardType as ScheduledResourceRuleInput["rewardType"],
        rewardId: body.rewardId as number | null,
        grantAmount: body.grantAmount as number,
        triggerThreshold: body.triggerThreshold as number,
        inventoryCap: body.inventoryCap as number,
        enabled: body.enabled as boolean,
        startsAtReal: parseDate(body.startsAtReal, "开始时间"),
        endsAtReal: parseDate(body.endsAtReal, "结束时间"),
        description,
    }
}

function parseRuleId(raw: string): number | null {
    if (!/^[1-9]\d*$/.test(raw)) return null
    const id = Number(raw)
    return Number.isSafeInteger(id) ? id : null
}

function getAuthority() {
    return {
        itemMaxCounts: getRuntimeContentTableSync<Readonly<Record<string, number>>>(
            "item_max_count.json",
            bundledItemMaxCounts,
        ),
        maxFreeVmoney: getRuntimeContentTableSync<ConfigValues>(
            "config.json",
            bundledConfig,
        ).max_virtual_money,
        playerExists: (playerId: number) => getPlayerSync(playerId) !== null,
    }
}

function validateBody(body: unknown): ScheduledResourceRuleInput {
    const input = parseBody(body)
    const validation = validateScheduledResourceRuleInput(input, getAuthority())
    if (!validation.ok) throw new Error(validation.error)
    return validation.value
}

function createRuleProjector() {
    const authority = getAuthority()
    const itemLookup = getItemLookupSync()
    return (rule: ScheduledResourceRule) => ({
            ...rule,
            rewardName: rule.rewardType === "free_vmoney"
                ? "免费星导石"
                : itemLookup[String(rule.rewardId)] ?? `道具 #${rule.rewardId}`,
            officialMaxCount: rule.rewardType === "free_vmoney"
                ? authority.maxFreeVmoney
                : authority.itemMaxCounts[String(rule.rewardId)],
        })
}

function badRequest(reply: FastifyReply, error: unknown) {
    const message = error instanceof Error ? error.message : "请求内容无效"
    return reply.status(400).send({ error: message })
}

const routes = async (fastify: FastifyInstance) => {
    fastify.get("/authority", async (_request: FastifyRequest, reply: FastifyReply) => (
        reply.status(200).send({ maxFreeVmoney: getAuthority().maxFreeVmoney })
    ))

    fastify.get("/", async (_request: FastifyRequest, reply: FastifyReply) => (
        reply.status(200).send(listScheduledResourceRulesSync().map(createRuleProjector()))
    ))

    fastify.post("/", async (request: FastifyRequest, reply: FastifyReply) => {
        try {
            return reply.status(201).send(createRuleProjector()(
                insertScheduledResourceRuleSync(validateBody(request.body)),
            ))
        } catch (error) {
            return badRequest(reply, error)
        }
    })

    fastify.patch("/:id", async (request: FastifyRequest, reply: FastifyReply) => {
        const ruleId = parseRuleId((request.params as RuleParams).id)
        if (ruleId === null || getScheduledResourceRuleSync(ruleId) === null) {
            return reply.status(404).send({ error: "规则不存在" })
        }
        try {
            return reply.status(200).send(createRuleProjector()(
                updateScheduledResourceRuleSync(ruleId, validateBody(request.body)),
            ))
        } catch (error) {
            return badRequest(reply, error)
        }
    })

    fastify.patch("/:id/enabled", async (request: FastifyRequest, reply: FastifyReply) => {
        const ruleId = parseRuleId((request.params as RuleParams).id)
        const rule = ruleId === null ? null : getScheduledResourceRuleSync(ruleId)
        if (rule === null) return reply.status(404).send({ error: "规则不存在" })
        if (!isPlainObject(request.body) || typeof request.body.enabled !== "boolean") {
            return reply.status(400).send({ error: "启用状态无效" })
        }
        return reply.status(200).send(createRuleProjector()(updateScheduledResourceRuleSync(rule.id, {
            ...rule,
            enabled: request.body.enabled,
        })))
    })

    fastify.delete("/:id", async (request: FastifyRequest, reply: FastifyReply) => {
        const ruleId = parseRuleId((request.params as RuleParams).id)
        if (ruleId === null || !deleteScheduledResourceRuleSync(ruleId)) {
            return reply.status(404).send({ error: "规则不存在" })
        }
        return reply.status(200).send({ ok: true })
    })
}

export default routes
