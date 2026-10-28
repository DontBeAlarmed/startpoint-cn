/**
 * 开局块（opening）解析源表转换器：ability / leader_ability / ability_soul
 * 的**窄行提取** + mana_node 原始三层嵌套透传。
 *
 * 为什么不走 DIRECT 直通（ordered-map-json-N）：部分行（如 leader_ability
 * 的多行描述）含**未加引号的裸换行**，ordered-map-json 的单行 CSV 解析
 * （parseCsvLine）拒收。行边界实际由 orderedmap 二进制结构决定而非换行。
 *
 * 输出为开局块窄行：[trigger, kind, power1, first_max]。trigger 取行首第 6
 * 列（c5，先于文本列），opening 三值取行末 3 列（c123-125 / c121-123 /
 * c120-122，行尾数值）——多行描述文本的中段逗号不影响两端切分。非 opening
 * 行 kind 为 null。消费方 src/lib/opening-bonus.ts 按此窄行读取；
 * assets/ 下同名窄行资产由 tools/gen_opening_assets.cjs 从 CDN 全量行
 * 提取物生成（与本地 orderedmap 提取目录同构）。
 */
import type { ContentConverterContext } from "./context"
import { parseNestedOrderedMapRows, parseTextOrderedMap } from "../sync/ordered-map"

export const OPENING_ABILITY_SOURCE_PATHS = {
    ability: "master/ability/ability.orderedmap",
    leaderAbility: "master/ability/leader_ability.orderedmap",
    abilitySoul: "master/ability/ability_soul.orderedmap",
    manaNode: "master/mana_board/mana_node.orderedmap",
} as const

export type OpeningAbilityTableName =
    | "ability.json"
    | "leader_ability.json"
    | "ability_soul.json"
    | "mana_node_raw.json"

export interface OpeningAbilitySourceReader {
    read(logicalPath: string): Promise<readonly { readonly key: string; readonly text: string }[]>
    /** 原始字节（三层嵌套源用 parseNestedOrderedMapRows 自行展开） */
    readBytes(logicalPath: string): Promise<Buffer>
}

export type OpeningRow = readonly [
    trigger: string,
    kind: number | null,
    power1: number | null,
    firstMax: number | null,
]

export interface OpeningAbilityConversionOutput {
    readonly tables: Record<OpeningAbilityTableName, unknown>
}

/**
 * 多行 CSV 行走：引号内的换行/逗号均为字段内容；引号外的换行 = 行界，
 * 引号外的逗号 = 字段界。返回每条逻辑行的字段数组。
 */
function parseMultiRowCsv(text: string): string[][] {
    const rows: string[][] = []
    let fields: string[] = []
    let field = ""
    let inQuotes = false
    for (let index = 0; index < text.length; index += 1) {
        const character = text[index]
        if (inQuotes) {
            if (character === '"') {
                if (text[index + 1] === '"') {
                    field += '"'
                    index += 1
                } else {
                    inQuotes = false
                }
            } else {
                field += character
            }
            continue
        }
        if (character === '"') {
            inQuotes = true
        } else if (character === ",") {
            fields.push(field)
            field = ""
        } else if (character === "\n" || character === "\r") {
            if (field !== "" || fields.length > 0) rows.push([...fields, field])
            fields = []
            field = ""
        } else {
            field += character
        }
    }
    if (field !== "" || fields.length > 0) rows.push([...fields, field])
    return rows
}

/** 各表 trigger 列位（1.4.5x 布局：ability c5 / leader c3 / soul c2） */
const TRIGGER_INDEX: Record<string, number> = {
    "ability.json": 5,
    "leader_ability.json": 3,
    "ability_soul.json": 2,
}

/**
 * 提取 opening 窄行：trigger 列 ∈ {"2"} 且行末三元组 kind ∈ {0,1,2}、
 * power1/first_max 为有限数的行。非 opening 行与错位碎行（多行描述被
 * 无引号换行截断的残片）一律不产出——宁少付不多付。
 */
function parseOpeningRows(
    entries: readonly { readonly key: string; readonly text: string }[],
    tableName: string,
): Record<string, readonly OpeningRow[]> {
    const triggerIndex = TRIGGER_INDEX[tableName] ?? 0
    const out: Record<string, readonly OpeningRow[]> = {}
    for (const entry of entries) {
        // entry.text = 该 id 的多行 CSV（c0 起始；行界 = 引号外换行，
        // 描述列的引号内换行保持为字段内容）
        const openingRows: OpeningRow[] = []
        for (const fields of parseMultiRowCsv(entry.text)) {
            if (fields[triggerIndex] !== "2") continue
            if (fields.length < 3) continue
            const kind = Number(fields[fields.length - 3])
            const power1 = Number(fields[fields.length - 2])
            const firstMax = Number(fields[fields.length - 1])
            if ((kind !== 0 && kind !== 1 && kind !== 2)
                || !Number.isFinite(power1) || !Number.isFinite(firstMax)) continue
            openingRows.push([fields[triggerIndex], kind, power1, firstMax] as const)
        }
        if (openingRows.length > 0) out[entry.key] = openingRows
    }
    return out
}

export async function convertOpeningAbilityTables(
    reader: OpeningAbilitySourceReader,
    _context: ContentConverterContext,
): Promise<OpeningAbilityConversionOutput> {
    const [abilityRows, leaderRows, soulRows] = await Promise.all([
        reader.read(OPENING_ABILITY_SOURCE_PATHS.ability),
        reader.read(OPENING_ABILITY_SOURCE_PATHS.leaderAbility),
        reader.read(OPENING_ABILITY_SOURCE_PATHS.abilitySoul),
    ])


    // mana_node 原始三层嵌套：{char: {board: {pos: [行]}}}
    // （与 convertManaNodes 同款 readBytes + 双层 parseNestedOrderedMapRows 展开；
    //   保留全列供节点→能力槽映射：c1=种类、c5=效果、c6=槽位号）
    const manaNodeRaw: Record<string, Record<string, Record<string, readonly string[][]>>> = {}
    for (const character of parseNestedOrderedMapRows(await reader.readBytes(OPENING_ABILITY_SOURCE_PATHS.manaNode))) {
        const boards: Record<string, Record<string, readonly string[][]>> = {}
        for (const board of parseNestedOrderedMapRows(character.value)) {
            const positions: Record<string, readonly string[][]> = {}
            for (const position of parseTextOrderedMap(board.value)) {
                // 引号感知切分：节点行的 required_item_ids 等字段含引号内逗号
                // （"1,2"），朴素 split 会错位 c5/c6 列
                const positionFields = parseMultiRowCsv(position.text)
                positions[position.key] = positionFields.length > 0 ? [positionFields[0]] : []
            }
            boards[board.key] = positions
        }
        manaNodeRaw[character.key] = boards
    }

    return {
        tables: {
            "ability.json": parseOpeningRows(abilityRows, "ability.json"),
            "leader_ability.json": parseOpeningRows(leaderRows, "leader_ability.json"),
            "ability_soul.json": parseOpeningRows(soulRows, "ability_soul.json"),
            "mana_node_raw.json": manaNodeRaw,
        },
    }
}
