import { deepFreeze } from "../content/deep-freeze"
import {
    getContentSnapshot,
    type ReadonlyContentRepository,
} from "../content/runtime/content-snapshot"
import { getVirtualNow } from "../runtime/time/game-time"

const SHORT_TERM_MAX_DAYS = 60
const CHARACTER_GACHA_TYPE = 0
const NORMAL_PAGE_KIND = 0

interface RawGachaPoolItem {
    id: number
    rank: number
    odds: number
    isRateUp?: boolean
    isLimited?: boolean
    isExchangeable?: boolean
    rarity?: number
}

interface RawGacha {
    type: number
    pageKind?: number
    startDate: string
    endDate: string
    name?: string
    pool?: Record<string, RawGachaPoolItem[]>
}

interface CharacterMeta {
    rarity?: number
    element?: number
}

type CharacterTextRows = Record<string, readonly (readonly string[])[]>

export interface ClairvoyanceCharacter {
    id: number
    name: string
    title: string
    rarity: number | null
    element: number | null
    rank: number
    odds: number
    isLimited: boolean
    isExchangeable: boolean
}

export interface ClairvoyanceGacha {
    id: number
    name: string
    type: "character"
    pageKind: number
    startDate: string
    endDate: string
    startTime: string
    endTime: string
    durationDays: number
    rateUpCharacters: ClairvoyanceCharacter[]
}

export interface ClairvoyanceSearchRow {
    characterId: number
    name: string
    title: string
    gachas: Array<Pick<ClairvoyanceGacha, "id" | "name" | "startDate" | "endDate">>
}

export interface ClairvoyanceTimeline {
    scope: "short-up-character-gacha"
    currentTime: string
    current: ClairvoyanceGacha[]
    timeline: ClairvoyanceGacha[]
    searchIndex: ClairvoyanceSearchRow[]
}

interface StaticClairvoyanceTimeline {
    readonly timeline: ClairvoyanceGacha[]
    readonly searchIndex: ClairvoyanceSearchRow[]
}

const staticTimelineByRepository = new WeakMap<ReadonlyContentRepository, StaticClairvoyanceTimeline>()

function parseCdnDate(value: string): Date {
    return new Date(`${value.replace(" ", "T")}+08:00`)
}

function durationDays(startDate: string, endDate: string): number {
    return (parseCdnDate(endDate).getTime() - parseCdnDate(startDate).getTime()) / 86400_000
}

function getCharacterName(
    characterText: CharacterTextRows,
    characterId: number,
): { name: string; title: string } {
    const text = characterText[String(characterId)]?.[0]
    return {
        name: text?.[0] || `#${characterId}`,
        title: text?.[3] || "",
    }
}

function toRateUpCharacters(
    rawGacha: RawGacha,
    characterMeta: Record<string, CharacterMeta>,
    characterText: CharacterTextRows,
): ClairvoyanceCharacter[] {
    const byId = new Map<number, RawGachaPoolItem>()
    for (const pool of Object.values(rawGacha.pool ?? {})) {
        for (const item of pool) {
            if (!item.isRateUp || byId.has(item.id)) continue
            byId.set(item.id, item)
        }
    }
    return [...byId.values()]
        .sort((a, b) => b.rank - a.rank || a.id - b.id)
        .map((item) => {
            const text = getCharacterName(characterText, item.id)
            const meta = characterMeta[String(item.id)]
            return {
                id: item.id,
                name: text.name,
                title: text.title,
                rarity: item.rarity ?? meta?.rarity ?? null,
                element: meta?.element ?? null,
                rank: item.rank,
                odds: item.odds,
                isLimited: item.isLimited ?? false,
                isExchangeable: item.isExchangeable ?? false,
            }
        })
}

function toGacha(
    id: string,
    rawGacha: RawGacha,
    characterMeta: Record<string, CharacterMeta>,
    characterText: CharacterTextRows,
): ClairvoyanceGacha | null {
    if (rawGacha.type !== CHARACTER_GACHA_TYPE) return null
    const pageKind = rawGacha.pageKind ?? NORMAL_PAGE_KIND
    if (pageKind !== NORMAL_PAGE_KIND) return null
    const days = durationDays(rawGacha.startDate, rawGacha.endDate)
    if (days <= 0 || days > SHORT_TERM_MAX_DAYS) return null
    const rateUpCharacters = toRateUpCharacters(rawGacha, characterMeta, characterText)
    if (rateUpCharacters.length === 0) return null
    return {
        id: Number(id),
        name: rawGacha.name || `卡池 #${id}`,
        type: "character",
        pageKind,
        startDate: rawGacha.startDate,
        endDate: rawGacha.endDate,
        startTime: parseCdnDate(rawGacha.startDate).toISOString(),
        endTime: parseCdnDate(rawGacha.endDate).toISOString(),
        durationDays: Math.round(days * 10) / 10,
        rateUpCharacters,
    }
}

function buildSearchIndex(timeline: ClairvoyanceGacha[]): ClairvoyanceSearchRow[] {
    const byCharacter = new Map<number, ClairvoyanceSearchRow>()
    for (const gacha of timeline) {
        for (const character of gacha.rateUpCharacters) {
            const row = byCharacter.get(character.id) ?? {
                characterId: character.id,
                name: character.name,
                title: character.title,
                gachas: [],
            }
            row.gachas.push({
                id: gacha.id,
                name: gacha.name,
                startDate: gacha.startDate,
                endDate: gacha.endDate,
            })
            byCharacter.set(character.id, row)
        }
    }
    return [...byCharacter.values()].sort((a, b) => a.characterId - b.characterId)
}

function buildStaticTimeline(repository: ReadonlyContentRepository): StaticClairvoyanceTimeline {
    const gachas = repository.table<Record<string, RawGacha>>("gacha.json")
    const characterMeta = repository.table<Record<string, CharacterMeta>>("character.json")
    const characterText = repository.table<CharacterTextRows>("cdndata/character_text.json")
    const timeline = Object.entries(gachas)
        .map(([id, rawGacha]) => toGacha(id, rawGacha, characterMeta, characterText))
        .filter((gacha): gacha is ClairvoyanceGacha => gacha !== null)
        .sort((a, b) => a.startTime.localeCompare(b.startTime) || a.id - b.id)
    return deepFreeze({ timeline, searchIndex: buildSearchIndex(timeline) })
}

function getStaticTimeline(repository: ReadonlyContentRepository): StaticClairvoyanceTimeline {
    const cached = staticTimelineByRepository.get(repository)
    if (cached !== undefined) return cached
    const built = buildStaticTimeline(repository)
    staticTimelineByRepository.set(repository, built)
    return built
}

export function buildShortUpCharacterGachaTimeline(now: Date = getVirtualNow()): ClairvoyanceTimeline {
    const repository = getContentSnapshot().repository
    const staticTimeline = getStaticTimeline(repository)
    const nowMs = now.getTime()
    return {
        scope: "short-up-character-gacha",
        currentTime: now.toISOString(),
        current: staticTimeline.timeline.filter((gacha) =>
            Date.parse(gacha.startTime) <= nowMs
            && Date.parse(gacha.endTime) >= nowMs
        ),
        timeline: staticTimeline.timeline,
        searchIndex: staticTimeline.searchIndex,
    }
}
