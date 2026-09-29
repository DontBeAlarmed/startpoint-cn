import { ReactNode, useEffect, useState } from "react"

/**
 * 公告缩略图与 RichText 简易渲染的共享展示层（列表实图列 + 编辑器拟真预览）。
 * 纯前端字符串/展示处理，不涉及任何接口与表单逻辑。
 */

// 缩略图 1-13 是客户端素材编号；后台没有可解析的素材 URL，约定放
// /admin/img/news/{n}.png（admin/public/img/news/），缺失时回退到审查稿
// 同款渐变占位块（five-pages-review #p-news）。
const THUMB_GRADIENTS = [
    "linear-gradient(135deg,#cfe3f7,#9cc3ec)",
    "linear-gradient(135deg,#f7e9cf,#ecc98f)",
    "linear-gradient(135deg,#d9f0e1,#9ed9b8)",
    "linear-gradient(135deg,#f7dcd4,#ecb9a8)",
    "linear-gradient(135deg,#e6dcf7,#c3b1ec)",
]

export function NewsThumb({ thumbnail, className }: { thumbnail: number; className?: string }) {
    const [failed, setFailed] = useState(false)

    useEffect(() => {
        setFailed(false)
    }, [thumbnail])

    const gradient = THUMB_GRADIENTS[(Math.max(1, thumbnail) - 1) % THUMB_GRADIENTS.length]
    if (failed) {
        return (
            <span
                className={`admin-news-thumb ${className ?? ""}`}
                style={{ backgroundImage: gradient }}
                aria-label={`缩略图 ${thumbnail}`}
            />
        )
    }
    return (
        <img
            className={`admin-news-thumb ${className ?? ""}`}
            src={`${import.meta.env.BASE_URL}img/news/${thumbnail}.png`}
            alt={`缩略图 ${thumbnail}`}
            loading="lazy"
            onError={() => setFailed(true)}
        />
    )
}

// 与 src/lib/news-rich-text.ts 的校验集合保持一致：只渲染允许的容器/void 标签，
// 不认识的片段一律按纯文本转义展示。
const BLOCK_TAGS = new Set(["p", "div", "ul", "ol", "table", "tr", "th", "td"])
const HEADING_TAGS: Record<string, number> = { h1: 1, h2: 2, h3: 3 }

interface InlineParse {
    color: string | null
    bold: boolean
}

function parseInlineNodes(source: string, base: InlineParse): ReactNode[] {
    const nodes: ReactNode[] = []
    const pattern = /\[color=([0-9a-fA-F]{6})\]([\s\S]*?)\[\/color\]|\[b\]([\s\S]*?)\[\/b\]/g
    let cursor = 0
    let match: RegExpExecArray | null
    while ((match = pattern.exec(source)) !== null) {
        nodes.push(...parsePlainNodes(source.slice(cursor, match.index), base))
        if (match[1] !== undefined) {
            nodes.push(...parsePlainNodes(match[2], { ...base, color: `#${match[1].toLowerCase()}` }))
        } else {
            nodes.push(...parsePlainNodes(match[3], { ...base, bold: true }))
        }
        cursor = match.index + match[0].length
    }
    nodes.push(...parsePlainNodes(source.slice(cursor), base))
    return nodes
}

function parsePlainNodes(source: string, style: InlineParse): ReactNode[] {
    const nodes: ReactNode[] = []
    const lines = source.split("\n")
    lines.forEach((line, index) => {
        if (index > 0) nodes.push(<br key={`br-${nodes.length}`} />)
        if (line === "") return
        nodes.push(
            style.color || style.bold
                ? <span key={`t-${nodes.length}`} style={{ color: style.color ?? undefined, fontWeight: style.bold ? 700 : undefined }}>{line}</span>
                : line,
        )
    })
    return nodes
}

interface BlockState {
    tag: string | null
    nodes: ReactNode[]
}

function flushBlock(blocks: ReactNode[], state: BlockState, key: string) {
    if (state.tag === null && state.nodes.length === 0) return
    const content = state.nodes
    if (state.tag !== null && state.tag in HEADING_TAGS) {
        const level = HEADING_TAGS[state.tag]
        blocks.push(<div key={key} style={{ fontWeight: 700, fontSize: `${17 - level}px`, lineHeight: 1.5 }}>{content}</div>)
    } else if (state.tag === "li") {
        blocks.push(<div key={key} className="news-preview-li">{content}</div>)
    } else if (state.tag !== null) {
        blocks.push(<div key={key} style={{ marginBottom: 6 }}>{content}</div>)
    } else if (content.length > 0) {
        blocks.push(<div key={key}>{content}</div>)
    }
    state.tag = null
    state.nodes = []
}

/** RichText 简易渲染：允许标签的块级布局 + [color]/[b] 标签 + 换行。 */
export function renderNewsRichText(source: string): ReactNode[] {
    const blocks: ReactNode[] = []
    const state: BlockState = { tag: null, nodes: [] }
    const pattern = /<(\/?)([a-z][a-z0-9]*)\/?>/g
    let cursor = 0
    let index = 0
    let match: RegExpExecArray | null
    while ((match = pattern.exec(source)) !== null) {
        const text = source.slice(cursor, match.index)
        if (text !== "") state.nodes.push(...parseInlineNodes(text, { color: null, bold: false }))
        const [, closing, name] = match
        if (name === "br") {
            state.nodes.push(<br key={`br-tag-${index++}`} />)
        } else if (name === "hr") {
            flushBlock(blocks, state, `b-${index++}`)
            blocks.push(<hr key={`hr-${index++}`} className="news-preview-hr" />)
        } else if (BLOCK_TAGS.has(name) || name in HEADING_TAGS || name === "li") {
            if (closing) flushBlock(blocks, state, `b-${index++}`)
            else {
                flushBlock(blocks, state, `b-${index++}`)
                state.tag = name
            }
        }
        cursor = match.index + match[0].length
    }
    const rest = source.slice(cursor)
    if (rest !== "") state.nodes.push(...parseInlineNodes(rest, { color: null, bold: false }))
    flushBlock(blocks, state, `b-end`)
    return blocks.length > 0 ? blocks : ["（暂无正文）"]
}
