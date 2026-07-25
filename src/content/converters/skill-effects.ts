import { decodeAmf3Deflate } from "../sync/amf3"
import type { NestedOrderedMapTextRows, OrderedMapTextRow } from "../sync/ordered-map"
import { parseCsvLine } from "./csv"

const ACTION_DSL_SUFFIX = ".action.dsl.amf3.deflate"
const TARGET_EFFECTS = new Set([
    "CreateNormalHeal",
    "CreateRatioHeal",
    "ACRegeneration",
])

export interface SkillEffectSourceReader {
    readDynamic(logicalPath: string): Promise<Buffer>
    allowDynamic?(logicalPaths: readonly string[]): void
}

export interface SkillEffectCharacter {
    readonly stringId: string
    readonly unisonable: boolean
    readonly effects: readonly string[]
}

export interface SkillEffectTable {
    readonly schemaVersion: 1
    readonly characters: Readonly<Record<string, SkillEffectCharacter>>
    readonly unresolved: Readonly<Record<string, {
        readonly stringId: string
        readonly reason: string
        readonly programPaths: readonly string[]
    }>>
}

export interface SkillEffectConversionInput extends SkillEffectSourceReader {
    readonly characterRows: readonly OrderedMapTextRow[]
    readonly actionSkillRows: readonly NestedOrderedMapTextRows[]
    readonly switchedActionSkillRows: readonly NestedOrderedMapTextRows[]
    readonly decodeActionDsl?: (bytes: Buffer) => unknown
}

export interface SkillEffectConversionOutput {
    readonly "cdndata/active_mission_skill_effects.json": SkillEffectTable
}

function clean(value: string | undefined): string | null {
    const normalized = (value ?? "").trim()
    return normalized === "" || normalized === "(None)" ? null : normalized
}

function parseRow(row: OrderedMapTextRow, subject: string): string[] {
    return parseCsvLine(row.text, subject, reason => {
        throw new Error(`invalid skill content: ${reason}`)
    })
}

function indexNestedRows(
    rows: readonly NestedOrderedMapTextRows[],
    pathColumn: number,
    unisonColumn?: number,
): Map<string, { readonly paths: readonly string[], readonly unisonable: readonly boolean[] }> {
    const result = new Map<string, { paths: string[], unisonable: boolean[] }>()
    for (const outer of rows) {
        const paths: string[] = []
        const unisonable: boolean[] = []
        for (const row of outer.rows) {
            const fields = parseRow(row, `skill[${outer.key}][${row.key}]`)
            const path = clean(fields[pathColumn])
            if (path === null) continue
            paths.push(path)
            if (unisonColumn !== undefined) unisonable.push(fields[unisonColumn] === "true")
        }
        result.set(outer.key, { paths, unisonable })
    }
    return result
}

function isNegativeRange(value: unknown): boolean {
    if (!value || typeof value !== "object" || Array.isArray(value)) return false
    const range = value as { readonly min?: unknown, readonly max?: unknown }
    return typeof range.min === "number" && Number.isFinite(range.min)
        && typeof range.max === "number" && Number.isFinite(range.max)
        && range.min < 0 && range.max < 0
}

function collectEffects(value: unknown, effects: Set<string>): void {
    if (Array.isArray(value)) {
        if (value[0] === "ACToleranceOfElement"
            && Array.isArray(value[3])
            && value[3].length > 0
            && value[3].every(isNegativeRange)) {
            effects.add("ACToleranceOfElement_Down")
        }
        for (const child of value) collectEffects(child, effects)
        return
    }
    if (value && typeof value === "object") {
        for (const child of Object.values(value)) collectEffects(child, effects)
        return
    }
    if (typeof value === "string" && TARGET_EFFECTS.has(value)) effects.add(value)
}

function sortedUnique(values: Iterable<string>): string[] {
    return [...new Set(values)].sort((left, right) => left.localeCompare(right))
}

function dynamicPath(programPath: string): string {
    if (!/^[A-Za-z0-9_./$-]+$/.test(programPath) || programPath.includes("..")) {
        throw new Error(`invalid skill program path: ${programPath}`)
    }
    return `${programPath}${ACTION_DSL_SUFFIX}`
}

export async function convertSkillEffects(
    input: SkillEffectConversionInput,
): Promise<SkillEffectConversionOutput> {
    const actionSkills = indexNestedRows(input.actionSkillRows, 7, 3)
    const switchedSkills = indexNestedRows(input.switchedActionSkillRows, 0)
    const decode = input.decodeActionDsl ?? decodeAmf3Deflate
    const dslCache = new Map<string, Promise<unknown>>()
    const readDsl = (path: string): Promise<unknown> => {
        const cached = dslCache.get(path)
        if (cached) return cached
        const logicalPath = dynamicPath(path)
        input.allowDynamic?.([logicalPath])
        const promise = input.readDynamic(logicalPath).then(bytes => decode(bytes))
        dslCache.set(path, promise)
        return promise
    }

    const characters: Record<string, SkillEffectCharacter> = {}
    const unresolved: Record<string, {
        stringId: string
        reason: string
        programPaths: readonly string[]
    }> = {}

    for (const row of input.characterRows) {
        const fields = parseRow(row, `character[${row.key}]`)
        const stringId = clean(fields[0])
        if (stringId === null || !/^\d+$/.test(row.key)) continue
        const direct = actionSkills.get(stringId)
        const switchedId = clean(fields[14])
        const switched = switchedId === null ? undefined : switchedSkills.get(switchedId)
        const programs = sortedUnique([
            ...(direct?.paths ?? []),
            ...(switched?.paths ?? []),
        ])
        if (programs.length === 0) continue
        const unisonValues = direct?.unisonable ?? []
        if (new Set(unisonValues).size > 1) {
            unresolved[row.key] = { stringId, reason: "unisonable_mismatch", programPaths: programs }
            continue
        }
        const effects = new Set<string>()
        let failed = false
        for (const program of programs) {
            try {
                collectEffects(await readDsl(program), effects)
            } catch {
                failed = true
                break
            }
        }
        if (failed) {
            unresolved[row.key] = { stringId, reason: "skill_dsl_unreadable", programPaths: programs }
            continue
        }
        characters[row.key] = {
            stringId,
            unisonable: unisonValues.length > 0 && unisonValues.every(Boolean),
            effects: sortedUnique(effects),
        }
    }

    return {
        "cdndata/active_mission_skill_effects.json": {
            schemaVersion: 1,
            characters: Object.fromEntries(Object.entries(characters).sort(([left], [right]) => (
                Number(left) - Number(right)
            ))),
            unresolved: Object.fromEntries(Object.entries(unresolved).sort(([left], [right]) => (
                Number(left) - Number(right)
            ))),
        },
    }
}
