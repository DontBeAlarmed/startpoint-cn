import {
    convertCharacters,
    type CharacterConversionInput,
    type CharacterConversionOutput,
} from "../converters/character"
import {
    convertGachas,
    type GachaConversionOutput,
    type GachaSourceReader,
} from "../converters/gacha"
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
const SUPPORTED_CONVERTER_IDS = new Set([
    "character",
    "gacha",
    "shop",
    "skill-effects",
    "bundled-json",
    "server-json",
])

export interface DefaultContentTableBuilderDependencies {
    readonly convertCharacters?: (
        input: CharacterConversionInput,
    ) => CharacterConversionOutput | Promise<CharacterConversionOutput>
    readonly convertGachas?: (
        reader: GachaSourceReader,
    ) => GachaConversionOutput | Promise<GachaConversionOutput>
    readonly convertShops?: (
        reader: ShopSourceReader,
    ) => ShopConversionOutput | Promise<ShopConversionOutput>
    readonly convertSkillEffects?: (
        input: SkillEffectConversionInput,
    ) => SkillEffectConversionOutput | Promise<SkillEffectConversionOutput>
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

class StrictOrderedMapReader implements GachaSourceReader, ShopSourceReader {
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
    const gachaConverter = dependencies.convertGachas ?? convertGachas
    const shopConverter = dependencies.convertShops ?? convertShops
    const skillEffectConverter = dependencies.convertSkillEffects ?? convertSkillEffects
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
                    || definition.converterId === "gacha"
                    || definition.converterId === "shop"
                    || definition.converterId === "skill-effects"
                    ? definition.sourceOrderedMaps
                    : []
            ))
            const reader = new StrictOrderedMapReader(context, staticPaths)
            await authorizeDynamicSources(reader, context.definitions)

            const values = new Map<string, unknown>()
            const converterIds = new Set(context.definitions.map(definition => definition.converterId))
            if (converterIds.has("character")) {
                addConverterOutput(
                    values,
                    "character",
                    await runCharacterConverter(reader, characterConverter),
                )
            }
            if (converterIds.has("gacha")) {
                addConverterOutput(values, "gacha", await gachaConverter(reader))
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

            const importedDefinitions = context.definitions.filter(definition => (
                definition.converterId === "bundled-json"
                || definition.converterId === "server-json"
            ))
            const importedEntries = await mapWithConcurrency(
                importedDefinitions,
                RELEASE_BUILD_IO_CONCURRENCY,
                async definition => ([
                    definition.tableName,
                    await bundledImporter(
                        context.paths.contentRuntimeDir,
                        definition.tableName,
                    ),
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
