import { deepFreeze } from "../content/deep-freeze"
import {
    getContentSnapshot,
    type ReadonlyContentRepository,
} from "../content/runtime/content-snapshot"

export type EncyclopediaContent = Readonly<Record<string, Readonly<{ read: true }>>>

const catalogs = new WeakMap<ReadonlyContentRepository, EncyclopediaContent>()

export function getEncyclopediaContent(
    repository: ReadonlyContentRepository = getContentSnapshot().repository,
): EncyclopediaContent {
    const cached = catalogs.get(repository)
    if (cached !== undefined) return cached
    const raw = repository.table<unknown>("encyclopedia.json")
    if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
        throw new TypeError("invalid encyclopedia content: root must be an object")
    }
    if (Object.keys(raw).length === 0) {
        throw new TypeError("invalid encyclopedia content: root must not be empty")
    }
    for (const [id, value] of Object.entries(raw)) {
        if (!/^[1-9]\d*$/.test(id) || !Number.isSafeInteger(Number(id))
            || value === null || typeof value !== "object" || Array.isArray(value)
            || (value as Record<string, unknown>).read !== true) {
            throw new TypeError(`invalid encyclopedia content: malformed entry ${id}`)
        }
    }
    const catalog = deepFreeze(raw) as EncyclopediaContent
    catalogs.set(repository, catalog)
    return catalog
}
