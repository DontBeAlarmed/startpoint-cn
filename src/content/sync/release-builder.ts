import {
    convertCharacters,
    type CharacterConversionInput,
    type CharacterConversionOutput,
} from "../converters/character"
import {
    convertCharacterElections,
    type CharacterElectionConversionInput,
    type CharacterElectionConversionOutput,
} from "../converters/character-election"
import {
    convertGachas,
    type GachaConversionOutput,
    type GachaSourceReader,
} from "../converters/gacha"
import {
    convertGameplayTables,
    type GameplayConversionOutput,
    type GameplaySourceReader,
} from "../converters/gameplay"
import {
    convertShops,
    type ShopConversionOutput,
    type ShopSourceReader,
} from "../converters/shop"
import {
    convertSkillEffects,
    type SkillEffectConversionInput,
    type SkillEffectConversionOutput,
} from "../converters/skill-effects"
import { parseCsvLine } from "../converters/csv"
import { convertOrderedMapJson } from "../converters/ordered-map-json"
import {
    convertRewards,
    type RewardConversionOutput,
    type RewardSourceReader,
} from "../converters/reward"
import {
    convertQuests,
    type QuestConversionCompatibility,
    type QuestConversionOutput,
    type QuestSourceReader,
} from "../converters/quest"
import { mapWithConcurrency } from "../concurrency"
import { hashContentResourcePath } from "../resource-path"
import { importBundledTable } from "./bundled-importer"
import type { ContentTableBuildContext, ContentTableBuilder } from "./engine"
import {
    parseNestedTextOrderedMaps,
    parseTextOrderedMap,
    type NestedOrderedMapTextRows,
    type OrderedMapTextRow,
} from "./ordered-map"
import type { GachaOddsDynamicSourceReference } from "./schema"
import type { TableSourceDefinition } from "./table-registry"

type ConverterOutput = object

const RELEASE_BUILD_IO_CONCURRENCY = 8
const DIRECT_ORDERED_MAP_CONVERTER = /^ordered-map-json-([1-3])$/
const SUPPORTED_CONVERTER_IDS = new Set([
    "character",
    "character-election",
    "gacha",
    "gameplay",
    "shop",
    "skill-effects",
    "ordered-map-json-1",
    "ordered-map-json-2",
    "ordered-map-json-3",
    "reward",
    "quest",
    "bundled-json",
    "server-json",
])

export interface DefaultContentTableBuilderDependencies {
    readonly convertCharacters?: (
        input: CharacterConversionInput,
    ) => CharacterConversionOutput | Promise<CharacterConversionOutput>
    readonly convertCharacterElections?: (
        input: CharacterElectionConversionInput,
    ) => CharacterElectionConversionOutput | Promise<CharacterElectionConversionOutput>
    readonly convertGachas?: (
        reader: GachaSourceReader,
    ) => GachaConversionOutput | Promise<GachaConversionOutput>
    readonly convertGameplayTables?: (
        reader: GameplaySourceReader,
    ) => GameplayConversionOutput | Promise<GameplayConversionOutput>
    readonly convertShops?: (
        reader: ShopSourceReader,
    ) => ShopConversionOutput | Promise<ShopConversionOutput>
    readonly convertSkillEffects?: (
        input: SkillEffectConversionInput,
    ) => SkillEffectConversionOutput | Promise<SkillEffectConversionOutput>
    readonly convertRewards?: (
        reader: RewardSourceReader,
    ) => RewardConversionOutput | Promise<RewardConversionOutput>
    readonly convertQuests?: (
        reader: QuestSourceReader,
        compatibility: QuestConversionCompatibility,
    ) => QuestConversionOutput | Promise<QuestConversionOutput>
    readonly importBundledTable?: typeof importBundledTable
}

function invalidLogicalPath(logicalPath: string): never {
    throw new Error(`invalid orderedmap logical path: ${logicalPath}`)
}

function requireLogicalPath(logicalPath: string): string {
    if (!logicalPath
        || logicalPath.includes("\\")
        || logicalPath.includes("*")
        || /[\u0000-\u001f\u007f]/.test(logicalPath)
        || logicalPath.startsWith("/")
        || logicalPath.split("/").some(segment => (
            segment === "" || segment === "." || segment === ".."
        ))) {
        invalidLogicalPath(logicalPath)
    }
    const hashed = hashContentResourcePath(logicalPath)
    if (hashed.logicalPath !== logicalPath) invalidLogicalPath(logicalPath)
    return logicalPath
}

class StrictOrderedMapReader implements GachaSourceReader, GameplaySourceReader, ShopSourceReader,
    RewardSourceReader, QuestSourceReader {
    private readonly context: ContentTableBuildContext
    private readonly allowed = new Set<string>()
    private readonly rawCache = new Map<string, Buffer>()
    private readonly flatCache = new Map<string, readonly OrderedMapTextRow[]>()
    private readonly nestedCache = new Map<string, readonly NestedOrderedMapTextRows[]>()

    constructor(context: ContentTableBuildContext, logicalPaths: Iterable<string>) {
        this.context = context
        this.allow(logicalPaths)
    }

    allow(logicalPaths: Iterable<string>): void {
        for (const logicalPath of logicalPaths) this.allowed.add(requireLogicalPath(logicalPath))
    }

    async read(logicalPath: string): Promise<readonly OrderedMapTextRow[]> {
        const normalized = this.requireAllowed(logicalPath)
        const cached = this.flatCache.get(normalized)
        if (cached) return cached
        const parsed = parseTextOrderedMap(await this.readRaw(normalized))
        this.flatCache.set(normalized, parsed)
        return parsed
    }

    async readDynamic(logicalPath: string): Promise<Buffer> {
        const normalized = this.requireAllowed(logicalPath)
        return this.readRaw(normalized)
    }

    async readNested(logicalPath: string): Promise<readonly NestedOrderedMapTextRows[]> {
        const normalized = this.requireAllowed(logicalPath)
        const cached = this.nestedCache.get(normalized)
        if (cached) return cached
        const parsed = parseNestedTextOrderedMaps(await this.readRaw(normalized))
        this.nestedCache.set(normalized, parsed)
        return parsed
    }

    private requireAllowed(logicalPath: string): string {
        const normalized = requireLogicalPath(logicalPath)
        if (!this.allowed.has(normalized)) {
            throw new Error(`orderedmap logical path is not declared by the registry: ${normalized}`)
        }
        return normalized
    }

    private async readRaw(logicalPath: string): Promise<Buffer> {
        const cached = this.rawCache.get(logicalPath)
        if (cached) return Buffer.from(cached)
        const { relativePath } = hashContentResourcePath(logicalPath)
        const physicalPath = `production/upload/${relativePath}`
        if (!this.context.archiveIndex.has(physicalPath)) {
            throw new Error(`orderedmap source is missing: ${logicalPath}`)
        }
        let bytes: Buffer
        try {
            bytes = await this.context.archiveIndex.read(physicalPath)
        } catch {
            throw new Error(`orderedmap source is missing or unreadable: ${logicalPath}`)
        }
        this.rawCache.set(logicalPath, Buffer.from(bytes))
        return Buffer.from(bytes)
    }
}

function dynamicSourceKey(source: GachaOddsDynamicSourceReference): string {
    return JSON.stringify(source)
}

function cleanReference(
    value: string | undefined,
    source: GachaOddsDynamicSourceReference,
): string | null {
    const normalized = source.referenceNormalization === "trim"
        ? (value ?? "").trim()
        : (value ?? "")
    return source.skipReferences.some(reference => reference === normalized) ? null : normalized
}

function requireOddsId(oddsId: string): string {
    if (!oddsId
        || oddsId === "."
        || oddsId === ".."
        || !/^[A-Za-z0-9._-]+$/.test(oddsId)) {
        throw new Error(`invalid gacha odds reference: ${oddsId}`)
    }
    return oddsId
}

function oddsLogicalPath(
    source: GachaOddsDynamicSourceReference,
    oddsId: string,
): string {
    return requireLogicalPath(
        source.logicalPathTemplate.replace("{oddsId}", requireOddsId(oddsId)),
    )
}

async function expandGachaOddsSource(
    reader: StrictOrderedMapReader,
    source: GachaOddsDynamicSourceReference,
): Promise<readonly string[]> {
    const rows = await reader.read(source.sourceOrderedMap)
    const ids = new Set<string>()
    for (const row of rows) {
        const columns = parseCsvLine(
            row.text,
            `gacha[${row.key}]`,
            reason => { throw new Error(`invalid gacha odds references: ${reason}`) },
        )
        const rarityReference = cleanReference(columns[source.rarityOddsColumn], source)
        if (rarityReference !== null) ids.add(requireOddsId(rarityReference))

        const prizeKind = columns[source.prizeKindColumn]
        const pool = source.poolOddsColumns.find(candidate => candidate.prizeKind === prizeKind)
        if (!pool) {
            throw new Error(`invalid gacha odds prize kind in gacha[${row.key}]: ${prizeKind}`)
        }
        for (const column of pool.columns) {
            const reference = cleanReference(columns[column], source)
            if (reference !== null) ids.add(requireOddsId(reference))
        }
    }
    const paths = [...ids]
        .sort((left, right) => left < right ? -1 : left > right ? 1 : 0)
        .map(oddsId => oddsLogicalPath(source, oddsId))
    reader.allow(paths)
    await mapWithConcurrency(paths, RELEASE_BUILD_IO_CONCURRENCY, async logicalPath => {
        try {
            await reader.readNested(logicalPath)
        } catch {
            throw new Error(`referenced gacha odds is missing or unreadable: ${logicalPath}`)
        }
    })
    return paths
}

async function authorizeDynamicSources(
    reader: StrictOrderedMapReader,
    definitions: readonly TableSourceDefinition[],
): Promise<void> {
    const seen = new Set<string>()
    for (const definition of definitions) {
        for (const source of definition.dynamicSources) {
            const key = dynamicSourceKey(source)
            if (seen.has(key)) continue
            seen.add(key)
            if (!definition.sourceOrderedMaps.includes(source.sourceOrderedMap)) {
                throw new Error(
                    `dynamic source is not rooted in its registry table: ${definition.tableName}`,
                )
            }
            await expandGachaOddsSource(reader, source)
        }
    }
}

function addConverterOutput(
    target: Map<string, unknown>,
    converterId: string,
    output: ConverterOutput,
): void {
    for (const [tableName, value] of Object.entries(output)) {
        if (target.has(tableName)) {
            throw new Error(`content converter produced duplicate table: ${tableName}`)
        }
        target.set(tableName, value)
    }
    if (Object.keys(output).length === 0) {
        throw new Error(`content converter produced no tables: ${converterId}`)
    }
}

function directOrderedMapDepth(converterId: string): number | null {
    const match = DIRECT_ORDERED_MAP_CONVERTER.exec(converterId)
    return match ? Number(match[1]) : null
}

async function runCharacterConverter(
    reader: StrictOrderedMapReader,
    convert: NonNullable<DefaultContentTableBuilderDependencies["convertCharacters"]>,
): Promise<CharacterConversionOutput> {
    const [characterRows, characterTextRows] = await Promise.all([
        reader.read("master/character/character.orderedmap"),
        reader.read("master/character/character_text.orderedmap"),
    ])
    return convert({ characterRows, characterTextRows })
}

async function runCharacterElectionConverter(
    reader: StrictOrderedMapReader,
    convert: NonNullable<DefaultContentTableBuilderDependencies["convertCharacterElections"]>,
): Promise<CharacterElectionConversionOutput> {
    const [electionRows, excludeRows, characterRows, encyclopediaRows] = await Promise.all([
        reader.read("master/character_election/character_election.orderedmap"),
        reader.read("master/character_election/character_election_exclude.orderedmap"),
        reader.read("master/character/character.orderedmap"),
        reader.readNested("master/encyclopedia/encyclopedia.orderedmap"),
    ])
    return convert({ electionRows, excludeRows, characterRows, encyclopediaRows })
}

async function runSkillEffectConverter(
    reader: StrictOrderedMapReader,
    convert: NonNullable<DefaultContentTableBuilderDependencies["convertSkillEffects"]>,
): Promise<Awaited<ReturnType<typeof convertSkillEffects>>> {
    const [characterRows, actionSkillRows, switchedActionSkillRows] = await Promise.all([
        reader.read("master/character/character.orderedmap"),
        reader.readNested("master/skill/action_skill.orderedmap"),
        reader.readNested("master/skill/switched_action_skill.orderedmap"),
    ])
    return convert({
        characterRows,
        actionSkillRows,
        switchedActionSkillRows,
        readDynamic: logicalPath => reader.readDynamic(logicalPath),
        allowDynamic: logicalPaths => reader.allow(logicalPaths),
    })
}

export function createDefaultContentTableBuilder(
    dependencies: DefaultContentTableBuilderDependencies = {},
): ContentTableBuilder {
    const characterConverter = dependencies.convertCharacters ?? convertCharacters
    const characterElectionConverter = dependencies.convertCharacterElections
        ?? convertCharacterElections
    const gachaConverter = dependencies.convertGachas ?? convertGachas
    const gameplayConverter = dependencies.convertGameplayTables ?? convertGameplayTables
    const shopConverter = dependencies.convertShops ?? convertShops
    const skillEffectConverter = dependencies.convertSkillEffects ?? convertSkillEffects
    const rewardConverter = dependencies.convertRewards ?? convertRewards
    const questConverter = dependencies.convertQuests ?? convertQuests
    const bundledImporter = dependencies.importBundledTable ?? importBundledTable

    return Object.freeze({
        async build(context: ContentTableBuildContext): Promise<ReadonlyMap<string, unknown>> {
            const unsupportedConverterIds = [...new Set(context.definitions
                .map(definition => definition.converterId)
                .filter(converterId => !SUPPORTED_CONVERTER_IDS.has(converterId)))]
                .sort()
            if (unsupportedConverterIds.length > 0) {
                throw new Error(`unsupported converterId: ${unsupportedConverterIds.join(", ")}`)
            }
            const staticPaths = context.definitions.flatMap(definition => (
                definition.converterId === "character"
                    || definition.converterId === "character-election"
                    || definition.converterId === "gacha"
                    || definition.converterId === "gameplay"
                    || definition.converterId === "shop"
                    || definition.converterId === "skill-effects"
                    || definition.converterId === "reward"
                    || definition.converterId === "quest"
                    || directOrderedMapDepth(definition.converterId) !== null
                    ? definition.sourceOrderedMaps
                    : []
            ))
            const reader = new StrictOrderedMapReader(context, staticPaths)
            await authorizeDynamicSources(reader, context.definitions)

            const values = new Map<string, unknown>()
            const converterIds = new Set(context.definitions.map(definition => definition.converterId))
            const bundledCache = new Map<string, Promise<unknown>>()
            const readBundled = (tableName: string): Promise<unknown> => {
                const cached = bundledCache.get(tableName)
                if (cached) return cached
                const pending = bundledImporter(context.paths.contentRuntimeDir, tableName)
                bundledCache.set(tableName, pending)
                return pending
            }
            if (converterIds.has("character")) {
                addConverterOutput(
                    values,
                    "character",
                    await runCharacterConverter(reader, characterConverter),
                )
            }
            if (converterIds.has("character-election")) {
                addConverterOutput(
                    values,
                    "character-election",
                    await runCharacterElectionConverter(reader, characterElectionConverter),
                )
            }
            if (converterIds.has("gacha")) {
                addConverterOutput(values, "gacha", await gachaConverter(reader))
            }
            if (converterIds.has("gameplay")) {
                addConverterOutput(values, "gameplay", await gameplayConverter(reader))
            }
            if (converterIds.has("shop")) {
                addConverterOutput(values, "shop", await shopConverter(reader))
            }
            if (converterIds.has("skill-effects")) {
                addConverterOutput(
                    values,
                    "skill-effects",
                    await runSkillEffectConverter(reader, skillEffectConverter),
                )
            }
            if (converterIds.has("reward")) {
                addConverterOutput(values, "reward", await rewardConverter(reader))
            }
            if (converterIds.has("quest")) {
                addConverterOutput(values, "quest", await questConverter(reader, {
                    practiceQuests: await readBundled("practice_quest.json") as Readonly<
                        Record<string, { readonly name?: unknown }>
                    >,
                }))
            }

            const directDefinitions = context.definitions.filter(definition => (
                directOrderedMapDepth(definition.converterId) !== null
            ))
            const directEntries = await mapWithConcurrency(
                directDefinitions,
                RELEASE_BUILD_IO_CONCURRENCY,
                async definition => {
                    if (definition.sourceOrderedMaps.length !== 1) {
                        throw new Error(
                            `direct OrderedMap table must declare one source: ${definition.tableName}`,
                        )
                    }
                    const depth = directOrderedMapDepth(definition.converterId)
                    if (depth === null) throw new Error(`invalid direct converter: ${definition.converterId}`)
                    return [
                        definition.tableName,
                        convertOrderedMapJson(
                            await reader.readDynamic(definition.sourceOrderedMaps[0]),
                            depth,
                        ),
                    ] as const
                },
            )
            for (const [tableName, value] of directEntries) {
                if (values.has(tableName)) {
                    throw new Error(`content table was produced twice: ${tableName}`)
                }
                values.set(tableName, value)
            }

            const importedDefinitions = context.definitions.filter(definition => (
                definition.converterId === "bundled-json"
                || definition.converterId === "server-json"
            ))
            const importedEntries = await mapWithConcurrency(
                importedDefinitions,
                RELEASE_BUILD_IO_CONCURRENCY,
                async definition => ([
                    definition.tableName,
                    await readBundled(definition.tableName),
                ] as const),
            )
            for (const [tableName, value] of importedEntries) {
                if (values.has(tableName)) {
                    throw new Error(`content table was produced twice: ${tableName}`)
                }
                values.set(tableName, value)
            }

            const expected = new Set(
                context.definitions.map(definition => definition.tableName),
            )
            const missing = [...expected].filter(tableName => !values.has(tableName)).sort()
            const extra = [...values.keys()].filter(tableName => !expected.has(tableName)).sort()
            if (missing.length > 0 || extra.length > 0) {
                const details = [
                    ...(missing.length === 0 ? [] : [`missing tables: ${missing.join(", ")}`]),
                    ...(extra.length === 0 ? [] : [`extra tables: ${extra.join(", ")}`]),
                ]
                throw new Error(
                    `default content builder output does not match registry (${details.join("; ")})`,
                )
            }
            return new Map(context.definitions.map(definition => (
                [definition.tableName, values.get(definition.tableName)] as const
            )))
        },
    })
}
