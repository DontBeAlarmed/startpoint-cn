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

// CN 1.8.1 NewsDetailDialog 将 news.html 交给 RichTextLayoutParser（flash.Xml.parse，
// 严格 XML 单根）并按完整 <html><body> 文档下钻（客户端自带 fixture 即完整文档，
// parseChild 分支表不含 html/body）。存储层只保存正文片段，且 validateNewsRichText
// 允许多根片段，因此仅在此客户端投影层包装 shell；已完整包装的内容原样透传。
export function toClientNewsHtml(bodyRichText: string): string {
    const trimmed = bodyRichText.trim()
    if (trimmed === "") return "<html><body></body></html>"
    if (/^<(?:!doctype\s+html|html[\s>]|body[\s>])/i.test(trimmed)) return trimmed
    return `<html><body>${trimmed}</body></html>`
}

export function toClientNews(row: ServerNewsRow): ClientNewsItem {
    return {
        id: row.id,
        title: row.title,
        date: toCnClientNewsDate(row.publishedAtReal),
        html: toClientNewsHtml(row.bodyRichText),
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
