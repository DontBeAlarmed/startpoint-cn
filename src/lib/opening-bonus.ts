import type { ReadonlyContentRepository } from "../content/runtime/content-snapshot"

/**
 * 开局块（opening block）加成解析。
 *
 * 游戏数据模型：能力行的 trigger 列（ability c5 / leader_ability c3 /
 * ability_soul c2）= 2 时携带 opening 块（kind 列 + 强度区间列），效果类别
 * OpeningAbilityKind：0=MyselfExpBoost（自身经验）1=AllyExpBoost（全队经验，
 * CN 1.4.54 零行）2=ManaBoost（玛纳获得）。客户端从不在数值上应用这些块
 * （getOpeningSkillRate 零调用），结算画面的经验/玛纳原样显示服务端返回值，
 * 因此服务端加成不会产生显示/结算失配——唯一风险是少付。
 *
 * 强度插值（客户端 AbilityPowerValue.resolve，LevelScale）：
 *   strength = power1 + (first_max - power1) * (power - 1) / (maxPower - 1)
 *   power == maxPower（或觉醒）→ first_max；power == 1 → power1。
 * 各来源的 power：
 *   - 编队槽能力魂：定值 power1（客户端 MinimumLevel）
 *   - 装备自带魂：装备等级 LevelScale(level, equipment_dissolve.max_level)
 *   - 角色玛纳盘能力：该槽位已学节点计数 LevelScale(count, character c36 max
 *     powers)；任一槽位节点觉醒 → 直接 first_max（客户端 awake toMax）
 *   - 队长能力（仅 1 号位）：LevelScale(min(进化+1, 2), 2) → 0 觉 power1、
 *     ≥1 觉 first_max（LeaderAbilityLogic 构造器）
 *
 * 数据源全部经内容表直读（{id: rows} positional，字符串值）；表缺失或行
 * 异常一律 fail-open 为无加成（乘数 1），未知 opening kind 跳过不崩——
 * 自制内容未来新增 kind 时此处是唯一扩展点。
 *
 * v1 边界（有意保守，避免多付）：玛纳盘/队长能力只对主（非合击）角色计；
 * 合击伙伴的开局块暂不计入（需按 unisonable 列过滤后放开）。
 */

export interface OpeningBonusCharacterInput {
    readonly characterId: number
    readonly evolutionLevel: number
    /** {节点 id: 觉醒级} —— players_characters_mana_nodes 投影 */
    readonly manaNodes: Readonly<Record<string, number>>
    /** 该角色槽位的装备（装备 id + 等级） */
    readonly equipment: { readonly equipmentId: number; readonly level: number } | null
    /** 该角色槽位装配的能力魂 id（players_parties.ability_soul_N） */
    readonly abilitySoulId: number | null
}

export interface OpeningBonusPartyInput {
    /** 按槽位排列的主角色；index 0 为队长（队长能力仅此位生效） */
    readonly characters: readonly OpeningBonusCharacterInput[]
}

export interface OpeningBonusResult {
    /** 玛纳获得乘数（作用于 reward_mana，不含 field_mana/pool_exp） */
    readonly manaMultiplier: number
    /** 按角色 id 的经验乘数（作用于 add_exp 的基础值；不含 boost 点） */
    readonly expMultiplierByCharacter: Readonly<Record<number, number>>
}

interface OpeningBlock {
    readonly kind: number
    readonly power1: number
    readonly firstMax: number
}

const OPENING_TRIGGER = 2

/**
 * 窄行（opening-ability 转换器/资产行）：[trigger, kind, power1, first_max]。
 * 三张能力表统一此 schema；非 opening 行（trigger ≠ 2）返回 null。
 */
function parseOpeningBlock(row: readonly unknown[], subject: string): OpeningBlock | null {
    if (String(row[0] ?? "") !== String(OPENING_TRIGGER)) return null
    const kind = Number(row[1])
    const power1 = Number(row[2])
    const firstMax = Number(row[3])
    if (!Number.isFinite(kind) || !Number.isFinite(power1) || !Number.isFinite(firstMax)) {
        console.warn(`[OPENING] malformed opening block skipped: ${subject}`)
        return null
    }
    return { kind, power1, firstMax }
}

/** LevelScale 插值；power≥maxPower → first_max，power≤1 → power1（客户端 resolve 语义） */
function levelScaleStrength(block: OpeningBlock, power: number, maxPower: number): number {
    if (maxPower < 1) return block.firstMax
    if (block.power1 === block.firstMax) return block.firstMax
    if (power >= maxPower) return block.firstMax
    if (power <= 1) return block.power1
    const t = (power - 1) / (maxPower - 1)
    const strength = block.power1 * (1 - t) + block.firstMax * t
    // 数值防御：损坏/敌意组成 JSON 可带入非有限数，NaN 乘数会污染结算
    return Number.isFinite(strength) ? strength : 0
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null
}

function rowsOf(table: unknown, subject: string): Record<string, readonly (readonly unknown[])[]> {
    if (!isRecord(table)) return {}
    const out: Record<string, readonly (readonly unknown[])[]> = {}
    for (const [id, rows] of Object.entries(table)) {
        if (!Array.isArray(rows)) continue
        out[id] = rows as readonly (readonly unknown[])[]
    }
    void subject
    return out
}

function characterRawRow(
    repository: ReadonlyContentRepository,
    characterId: number,
): readonly unknown[] | null {
    let table: unknown
    try {
        table = repository.table("cdndata/character.json")
    } catch {
        return null
    }
    if (!isRecord(table)) return null
    const entry = table[String(characterId)]
    if (!Array.isArray(entry) || !Array.isArray(entry[0])) return null
    return entry[0] as readonly unknown[]
}

function intAt(row: readonly unknown[], index: number): number | null {
    const parsed = Number(row[index])
    return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null
}

/**
 * 玛纳盘节点 → 能力槽计数。节点 id 解码（客户端 get_boardValues）：
 * board = floor(id/200) % 10，pos = id % 200。原始 mana_node 行：
 * c1=种类（"0"=能力节点）、c5=效果（"0"=能力槽）、c6=槽位号（1..6）。
 * 槽位 power = 已学同槽节点数；任一已学同槽节点觉醒级 > 0 → 该槽视为觉醒
 * （客户端 awake toMax）。
 */
function slotPowerFromManaNodes(
    manaNodeRaw: unknown,
    characterId: number,
    slot: number,
    manaNodes: Readonly<Record<string, number>>,
): { power: number; awakened: boolean } {
    const result = { power: 0, awakened: false }
    if (!isRecord(manaNodeRaw)) return result
    const characterBoards = manaNodeRaw[String(characterId)]
    if (!isRecord(characterBoards)) return result
    for (const nodeIdText of Object.keys(manaNodes)) {
        const nodeId = Number(nodeIdText)
        if (!Number.isSafeInteger(nodeId) || nodeId <= 0) continue
        const board = Math.floor(nodeId / 200) % 10
        const position = nodeId % 200
        const boardRows = characterBoards[String(board)]
        if (!isRecord(boardRows)) continue
        const rows = boardRows[String(position)]
        if (!Array.isArray(rows) || !Array.isArray(rows[0])) continue
        const row = rows[0] as readonly unknown[]
        if (String(row[1] ?? "") !== "0") continue // 非能力节点（剧情节点）
        if (String(row[5] ?? "") !== "0") continue // 效果不是能力槽
        if (Number(row[6]) !== slot) continue
        result.power += 1
        const awakeLevel = Number(manaNodes[nodeIdText] ?? 0)
        if (awakeLevel > 0) result.awakened = true
    }
    return result
}

export function resolveOpeningBonus(
    repository: ReadonlyContentRepository,
    party: OpeningBonusPartyInput,
): OpeningBonusResult {
    // 契约：expMultiplierByCharacter 恒覆盖全部编队角色（无加成 = 1），
    // 消费方无需处理缺键
    const failOpen: OpeningBonusResult = {
        manaMultiplier: 1,
        expMultiplierByCharacter: Object.fromEntries(
            party.characters.map(character => [character.characterId, 1]),
        ),
    }

    let abilityRows: Record<string, readonly (readonly unknown[])[]>
    let leaderRows: Record<string, readonly (readonly unknown[])[]>
    let soulRows: Record<string, readonly (readonly unknown[])[]>
    let manaNodeRaw: unknown
    try {
        abilityRows = rowsOf(repository.table("ability.json"), "ability")
        leaderRows = rowsOf(repository.table("leader_ability.json"), "leader_ability")
        soulRows = rowsOf(repository.table("ability_soul.json"), "ability_soul")
        manaNodeRaw = repository.table("mana_node_raw.json")
    } catch (error) {
        console.warn("[OPENING] content tables unavailable, opening bonus disabled", error)
        return failOpen
    }

    // 全队 Mana/Ally 聚合 + 按角色 Myself 聚合
    let manaBonusSum = 0
    let allyExpBonusSum = 0
    const myselfBonusByCharacter = new Map<number, number>()

    const addStrength = (kind: number, strength: number, ownerCharacterId: number | null): void => {
        if (!Number.isFinite(strength)) return
        if (kind === 2) manaBonusSum += strength
        else if (kind === 1) allyExpBonusSum += strength
        else if (kind === 0 && ownerCharacterId !== null) {
            myselfBonusByCharacter.set(
                ownerCharacterId,
                (myselfBonusByCharacter.get(ownerCharacterId) ?? 0) + strength,
            )
        }
        // 未知 kind：跳过（自制内容新类别的服务端扩展点）
    }

    try {
        party.characters.forEach((character, slotIndex) => {
            const charRow = characterRawRow(repository, character.characterId)

            // —— 玛纳盘能力（c19..c24 = 槽 1..6；c36 = max_ability_powers）——
            // 角色主数据行缺失只跳过行依赖段；装备魂/编队魂照常解析
            if (charRow !== null) {
            const maxPowersText = String(charRow[36] ?? "")
            const maxPowers = maxPowersText === ""
                ? []
                : maxPowersText.split(",").map(value => Number(value))
            for (let slot = 1; slot <= 6; slot += 1) {
                const abilityId = intAt(charRow, 18 + slot)
                if (abilityId === null) continue
                const rows = abilityRows[String(abilityId)]
                if (rows === undefined) continue
                for (const row of rows) {
                    const block = parseOpeningBlock(row, `ability ${abilityId}`)
                    if (block === null) continue
                    const maxPower = maxPowers[slot - 1] ?? 1
                    const { power, awakened } = slotPowerFromManaNodes(
                        manaNodeRaw,
                        character.characterId,
                        slot,
                        character.manaNodes,
                    )
                    // 0 节点 = 该槽能力未学习（客户端 isLearned false），无加成
                    if (power === 0 && !awakened) continue
                    const strength = awakened
                        ? block.firstMax
                        : levelScaleStrength(block, power, maxPower)
                    addStrength(block.kind, strength, character.characterId)
                }
            }

            // —— 队长能力（仅 1 号位；c17 = leader ability id）——
            if (slotIndex === 0 && charRow !== null) {
                const leaderAbilityId = intAt(charRow, 17)
                if (leaderAbilityId !== null) {
                    const rows = leaderRows[String(leaderAbilityId)]
                    if (rows !== undefined) {
                        for (const row of rows) {
                            const block = parseOpeningBlock(row, `leader ${leaderAbilityId}`)
                            if (block === null) continue
                            // LeaderAbilityLogic: LevelScale(min(进化+1, 2), 2)
                            const strength = character.evolutionLevel >= 1
                                ? block.firstMax
                                : block.power1
                            addStrength(block.kind, strength, character.characterId)
                        }
                    }
                }
            }

            }
            // —— 装备自带魂（equipment_dissolve: ability_soul_id + max_level）——
            if (character.equipment !== null) {
                let dissolveTable: unknown = null
                try {
                    dissolveTable = repository.table("equipment_dissolve.json")
                } catch {
                    dissolveTable = null
                }
                if (isRecord(dissolveTable)) {
                    const dissolve = dissolveTable[String(character.equipment.equipmentId)]
                    if (isRecord(dissolve)) {
                        const soulId = Number(dissolve.ability_soul_id)
                        const maxLevel = Number(dissolve.max_level)
                        // 客户端溶解门控同源：generate_ability_soul=false 的装备
                        // 不携带魂能力（equipment-dissolve.ts 同款判断）
                        const generatesSoul = dissolve.generate_ability_soul !== false
                        if (generatesSoul && Number.isSafeInteger(soulId) && soulId > 0) {
                            const rows = soulRows[String(soulId)]
                            if (rows !== undefined) {
                                for (const row of rows) {
                                    const block = parseOpeningBlock(row, `soul ${soulId}`)
                                    if (block === null) continue
                                    const strength = levelScaleStrength(
                                        block,
                                        character.equipment.level,
                                        maxLevel,
                                    )
                                    addStrength(block.kind, strength, character.characterId)
                                }
                            }
                        }
                    }
                }
            }

            // —— 编队槽能力魂（定值 power1，客户端 MinimumLevel）——
            if (character.abilitySoulId !== null && character.abilitySoulId > 0) {
                const rows = soulRows[String(character.abilitySoulId)]
                if (rows !== undefined) {
                    for (const row of rows) {
                        const block = parseOpeningBlock(row, `party soul ${character.abilitySoulId}`)
                        if (block === null) continue
                        addStrength(block.kind, block.power1, character.characterId)
                    }
                }
            }
        })
    } catch (error) {
        console.warn("[OPENING] aggregation failed, opening bonus disabled", error)
        return failOpen
    }

    const expMultiplierByCharacter: Record<number, number> = {}
    for (const character of party.characters) {
        const myself = myselfBonusByCharacter.get(character.characterId) ?? 0
        expMultiplierByCharacter[character.characterId] = 1 + myself + allyExpBonusSum
    }

    return {
        manaMultiplier: 1 + manaBonusSum,
        expMultiplierByCharacter,
    }
}
