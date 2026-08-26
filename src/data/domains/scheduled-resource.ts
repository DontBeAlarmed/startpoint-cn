import { getDb } from "../db"
import { getRealNow } from "../../runtime/time/game-time"

export type ScheduledResourceScope = "global" | "player"
export type ScheduledResourceRewardType = "item" | "free_vmoney"

export interface ScheduledResourceRuleInput {
    readonly scope: ScheduledResourceScope
    readonly playerId: number | null
    readonly rewardType: ScheduledResourceRewardType
    readonly rewardId: number | null
    readonly grantAmount: number
    readonly triggerThreshold: number
    readonly inventoryCap: number
    readonly enabled: boolean
    readonly startsAtReal: Date | null
    readonly endsAtReal: Date | null
    readonly description: string | null
}

export interface ScheduledResourceRule extends ScheduledResourceRuleInput {
    readonly id: number
    readonly createdAtReal: Date
    readonly updatedAtReal: Date
}

export interface ScheduledResourceState {
    readonly ruleId: number
    readonly lastGrantedBusinessDay: string
    readonly lastGrantedAtReal: Date
}

interface RawRule {
    id: number
    scope: ScheduledResourceScope
    player_id: number | null
    reward_type: ScheduledResourceRewardType
    reward_id: number | null
    grant_amount: number
    trigger_threshold: number
    inventory_cap: number
    enabled: number
    starts_at_real: string | null
    ends_at_real: string | null
    description: string | null
    created_at_real: string
    updated_at_real: string
}

const ruleColumns = `
    id, scope, player_id, reward_type, reward_id, grant_amount,
    trigger_threshold, inventory_cap, enabled, starts_at_real,
    ends_at_real, description, created_at_real, updated_at_real
`

function buildRule(raw: RawRule): ScheduledResourceRule {
    return {
        id: raw.id,
        scope: raw.scope,
        playerId: raw.player_id,
        rewardType: raw.reward_type,
        rewardId: raw.reward_id,
        grantAmount: raw.grant_amount,
        triggerThreshold: raw.trigger_threshold,
        inventoryCap: raw.inventory_cap,
        enabled: raw.enabled === 1,
        startsAtReal: raw.starts_at_real === null ? null : new Date(raw.starts_at_real),
        endsAtReal: raw.ends_at_real === null ? null : new Date(raw.ends_at_real),
        description: raw.description,
        createdAtReal: new Date(raw.created_at_real),
        updatedAtReal: new Date(raw.updated_at_real),
    }
}

function ruleParameters(input: ScheduledResourceRuleInput, updatedAt: Date) {
    return {
        scope: input.scope,
        player_id: input.playerId,
        reward_type: input.rewardType,
        reward_id: input.rewardId,
        grant_amount: input.grantAmount,
        trigger_threshold: input.triggerThreshold,
        inventory_cap: input.inventoryCap,
        enabled: input.enabled ? 1 : 0,
        starts_at_real: input.startsAtReal?.toISOString() ?? null,
        ends_at_real: input.endsAtReal?.toISOString() ?? null,
        description: input.description,
        updated_at_real: updatedAt.toISOString(),
    }
}

export function getScheduledResourceRuleSync(ruleId: number): ScheduledResourceRule | null {
    const raw = getDb().prepare(`
        SELECT ${ruleColumns}
        FROM scheduled_resource_rules
        WHERE id = ?
    `).get(ruleId) as RawRule | undefined
    return raw === undefined ? null : buildRule(raw)
}

export function listScheduledResourceRulesSync(): ScheduledResourceRule[] {
    const rows = getDb().prepare(`
        SELECT ${ruleColumns}
        FROM scheduled_resource_rules
        ORDER BY id DESC
    `).all() as RawRule[]
    return rows.map(buildRule)
}

export function listScheduledResourceRulesForPlayerSync(
    playerId: number,
): ScheduledResourceRule[] {
    const rows = getDb().prepare(`
        SELECT ${ruleColumns}
        FROM scheduled_resource_rules
        WHERE enabled = 1
          AND (scope = 'global' OR (scope = 'player' AND player_id = ?))
        ORDER BY id ASC
    `).all(playerId) as RawRule[]
    return rows.map(buildRule)
}

export function insertScheduledResourceRuleSync(
    input: ScheduledResourceRuleInput,
    now = getRealNow(),
): ScheduledResourceRule {
    const parameters = ruleParameters(input, now)
    const result = getDb().prepare(`
        INSERT INTO scheduled_resource_rules (
            scope, player_id, reward_type, reward_id, grant_amount,
            trigger_threshold, inventory_cap, enabled, starts_at_real,
            ends_at_real, description, created_at_real, updated_at_real
        ) VALUES (
            @scope, @player_id, @reward_type, @reward_id, @grant_amount,
            @trigger_threshold, @inventory_cap, @enabled, @starts_at_real,
            @ends_at_real, @description, @updated_at_real, @updated_at_real
        )
    `).run(parameters)
    const rule = getScheduledResourceRuleSync(Number(result.lastInsertRowid))
    if (rule === null) throw new Error("scheduled resource rule insert did not persist")
    return rule
}

export function updateScheduledResourceRuleSync(
    ruleId: number,
    input: ScheduledResourceRuleInput,
    now = getRealNow(),
): ScheduledResourceRule {
    const result = getDb().prepare(`
        UPDATE scheduled_resource_rules
        SET scope = @scope,
            player_id = @player_id,
            reward_type = @reward_type,
            reward_id = @reward_id,
            grant_amount = @grant_amount,
            trigger_threshold = @trigger_threshold,
            inventory_cap = @inventory_cap,
            enabled = @enabled,
            starts_at_real = @starts_at_real,
            ends_at_real = @ends_at_real,
            description = @description,
            updated_at_real = @updated_at_real
        WHERE id = @id
    `).run({ id: ruleId, ...ruleParameters(input, now) })
    if (result.changes === 0) throw new Error(`scheduled resource rule ${ruleId} does not exist`)
    const rule = getScheduledResourceRuleSync(ruleId)
    if (rule === null) throw new Error("scheduled resource rule update did not persist")
    return rule
}

export function deleteScheduledResourceRuleSync(ruleId: number): boolean {
    return getDb().prepare("DELETE FROM scheduled_resource_rules WHERE id = ?")
        .run(ruleId).changes > 0
}

export function getScheduledResourceStatesByRuleIdsSync(
    playerId: number,
    ruleIds: readonly number[],
): Record<number, ScheduledResourceState> {
    const ids = [...new Set(ruleIds)].filter(id => Number.isSafeInteger(id) && id > 0)
    if (ids.length === 0) return {}
    const placeholders = ids.map(() => "?").join(", ")
    const rows = getDb().prepare(`
        SELECT rule_id, last_granted_business_day, last_granted_at_real
        FROM players_scheduled_resource_state
        WHERE player_id = ? AND rule_id IN (${placeholders})
    `).all(playerId, ...ids) as Array<{
        rule_id: number
        last_granted_business_day: string
        last_granted_at_real: string
    }>
    return Object.fromEntries(rows.map(row => [row.rule_id, {
        ruleId: row.rule_id,
        lastGrantedBusinessDay: row.last_granted_business_day,
        lastGrantedAtReal: new Date(row.last_granted_at_real),
    }]))
}

export function recordScheduledResourceGrantsWithinTransactionSync(
    playerId: number,
    ruleIds: readonly number[],
    businessDay: string,
    grantedAtReal: Date,
): void {
    const db = getDb()
    if (!db.inTransaction) {
        throw new Error("recordScheduledResourceGrantsWithinTransactionSync requires an active transaction")
    }
    const statement = db.prepare(`
        INSERT INTO players_scheduled_resource_state (
            player_id, rule_id, last_granted_business_day, last_granted_at_real
        ) VALUES (?, ?, ?, ?)
        ON CONFLICT(player_id, rule_id) DO UPDATE SET
            last_granted_business_day = excluded.last_granted_business_day,
            last_granted_at_real = excluded.last_granted_at_real
    `)
    for (const ruleId of new Set(ruleIds)) {
        statement.run(playerId, ruleId, businessDay, grantedAtReal.toISOString())
    }
}
