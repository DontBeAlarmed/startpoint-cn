// 写入端点结构安全校验（防坏档）：只挡会真正坏档/崩溃的输入，不卡游戏平衡。
import characterData from "../../../assets/character.json"
import { getItemIdsSync } from "../../lib/assets"

export const MAX_INT = 2147483647 // 2^31 - 1，客户端 int 上限（≥2^31 解码成 null = 坏档）

export const VALID_CHARACTER_IDS: Set<number> = new Set(Object.keys(characterData).map(Number))
export function isValidItemId(itemId: number): boolean {
    return getItemIdsSync().includes(itemId)
}

type Rule =
    | { kind: "uint" }
    | { kind: "uintNull" }
    | { kind: "bool" }
    | { kind: "boolNull" }
    | { kind: "string"; max: number }
    | { kind: "date" }

const uint: Rule = { kind: "uint" }
const uintNull: Rule = { kind: "uintNull" }

// 白名单：Player 已知可编辑字段（id 不在内 = 禁改）
export const PLAYER_FIELD_RULES: Record<string, Rule> = {
    stamina: uint,
    boostPoint: uint,
    bossBoostPoint: uint,
    transitionState: uint,
    role: uint,
    vmoney: uint,
    freeVmoney: uint,
    rankPoint: uint,
    starCrumb: uint,
    bondToken: uint,
    expPool: uint,
    leaderCharacterId: uint,
    partySlot: uint,
    degreeId: uint,
    birth: uint,
    freeMana: uint,
    paidMana: uint,
    name: { kind: "string", max: 32 },
    comment: { kind: "string", max: 128 },
    enableAuto3x: { kind: "bool" },
    tutorialSkipFlag: { kind: "boolNull" },
    tutorialStep: uintNull,
    tutorialGachaCharacterId: uintNull,
    staminaHealTime: { kind: "date" },
    lastLoginTime: { kind: "date" },
    expPooledTime: { kind: "date" },
}

export type FieldResult = { ok: true; value: any } | { ok: false; error: string }

function isNullish(raw: any): boolean {
    return raw === "" || raw === "null" || raw === null || raw === undefined
}

function parseUint(field: string, raw: any): FieldResult {
    const n = Number(raw)
    if (!Number.isFinite(n)) return { ok: false, error: `${field} 不是有效数字` }
    const v = Math.trunc(n)
    if (v < 0 || v > MAX_INT) return { ok: false, error: `${field} 超出范围（需 0 ~ ${MAX_INT}）` }
    return { ok: true, value: v }
}

export function validatePlayerField(field: string, raw: any): FieldResult {
    const rule = PLAYER_FIELD_RULES[field]
    if (!rule) return { ok: false, error: `不允许修改字段：${field}` }

    switch (rule.kind) {
        case "uint":
            return parseUint(field, raw)
        case "uintNull":
            return isNullish(raw) ? { ok: true, value: null } : parseUint(field, raw)
        case "bool":
            return { ok: true, value: raw === true || raw === "true" || raw === "1" }
        case "boolNull":
            return isNullish(raw) ? { ok: true, value: null } : { ok: true, value: raw === true || raw === "true" || raw === "1" }
        case "string": {
            const s = String(raw)
            if (s.length > rule.max) return { ok: false, error: `${field} 过长（最多 ${rule.max} 字符）` }
            return { ok: true, value: s }
        }
        case "date": {
            const d = new Date(raw)
            if (isNaN(d.getTime())) return { ok: false, error: `${field} 不是有效日期` }
            return { ok: true, value: d }
        }
    }
}
