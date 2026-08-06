import { readFileSync } from "fs"
import path from "path"
import { hasForcedNewsDeliverySync } from "../data/domains/news"
import { getServerTime } from "../utils"
import { isNewsVisibleAt } from "./news-visibility"

export interface NewsItem {
    readonly id: number
    readonly title: string
    readonly date: string
    readonly label: number
    readonly thumbnail: number
    readonly thumbnail_path: string | null
    readonly added_time: string | null
    readonly html: string
    readonly forced: boolean
}

export function loadNews(): NewsItem[] {
    try {
        const raw = readFileSync(path.join(__dirname, "..", "..", "assets", "news.json"), "utf-8")
        const items = JSON.parse(raw) as any[]
        return items.map((news: any) => ({
            id: news.id,
            title: news.title || "",
            date: news.date || new Date().toISOString().replace("T", " ").substring(0, 19),
            label: news.label || 1,
            thumbnail: news.thumbnail || 1,
            thumbnail_path: news.thumbnail_path || null,
            added_time: news.added_time || null,
            html: news.html || "",
            forced: news.forced === true,
        }))
    } catch {
        return []
    }
}

export function loadVisibleNews(nowMs = getServerTime() * 1000): NewsItem[] {
    return loadNews().filter(news => isNewsVisibleAt(news, nowMs))
}

export function findPendingForcedNews(
    playerId: number,
    nowMs = getServerTime() * 1000,
): NewsItem | null {
    return loadVisibleNews(nowMs).find(news => (
        news.forced && !hasForcedNewsDeliverySync(playerId, news.id)
    )) ?? null
}

export function toClientNews(news: NewsItem) {
    return {
        id: news.id,
        title: news.title,
        date: news.date,
        html: news.html,
        label: news.label,
        thumbnail: news.thumbnail,
        thumbnail_path: news.thumbnail_path,
        added_time: news.added_time,
    }
}
