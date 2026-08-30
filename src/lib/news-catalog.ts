import {
    getVisibleNewsSync,
    listVisibleNewsSync,
    type ServerNewsRow,
} from "../data/domains/news"
import { getRealNow } from "../runtime/time/game-time"

export interface ClientNewsItem {
    readonly id: number
    readonly title: string
    readonly date: string
    readonly html: string
    readonly label: number
    readonly thumbnail: number
    readonly thumbnail_path: null
    readonly added_time: null
}

export function toCnClientNewsDate(iso: string): string {
    const shifted = new Date(Date.parse(iso) + 8 * 60 * 60 * 1000)
    return shifted.toISOString().slice(0, 19).replace("T", " ")
}

export function toClientNews(row: ServerNewsRow): ClientNewsItem {
    return {
        id: row.id,
        title: row.title,
        date: toCnClientNewsDate(row.publishedAtReal),
        html: row.bodyRichText,
        label: row.label,
        thumbnail: row.thumbnail,
        thumbnail_path: null,
        added_time: null,
    }
}

export function listVisibleNewsForClient(input: {
    category: 1 | 2 | 3
    page: number
}): { rows: readonly ServerNewsRow[]; totalCount: number } {
    return listVisibleNewsSync({
        category: input.category,
        nowIso: getRealNow().toISOString(),
        page: input.page,
        pageSize: 20,
    })
}

export function getVisibleNewsForClient(id: number): ServerNewsRow | null {
    return getVisibleNewsSync(id, getRealNow().toISOString())
}
