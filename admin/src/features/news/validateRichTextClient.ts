// 公告 RichText 客户端预校验：与服务端 src/lib/news-rich-text.ts 同构的白名单镜像。
// 服务端只回笼统的「公告内容无效」，这里给出精确到行/标签的原因，纯前端零依赖。
const CONTAINER_TAGS = new Set([
    "p", "div", "h1", "h2", "h3", "ul", "ol", "li",
    "table", "tr", "th", "td",
])
const VOID_TAGS = new Set(["br", "hr"])
const FORBIDDEN_MARKERS = [
    "http://",
    "https://",
    "www.",
    "scene/",
    "dialog/",
    "::associate_token::",
] as const

export function validateRichTextClient(source: string): { ok: true } | { ok: false; reason: string } {
    if (source.trim().length < 1) return { ok: false, reason: "请输入公告内容" }
    if (source.length > 20000) return { ok: false, reason: "公告内容过长（上限 20000 字符）" }
    const forbidden = FORBIDDEN_MARKERS.find(marker => source.includes(marker))
    if (forbidden !== undefined) {
        return { ok: false, reason: `客户端不支持链接与外部引用（含 ${forbidden}…），请删除` }
    }

    const openStack: { name: string; line: number }[] = []
    let cursor = 0
    let line = 1
    while (cursor < source.length) {
        const opening = source.indexOf("<", cursor)
        if (opening < 0) break
        line += source.slice(cursor, opening).split("\n").length - 1
        const end = source.indexOf(">", opening)
        if (end < 0) return { ok: false, reason: `第 ${line} 行有未闭合的 <（标签语法不完整）` }
        const raw = source.slice(opening + 1, end)
        cursor = end + 1
        if (raw.startsWith("/")) {
            const name = raw.slice(1)
            if (!/^[a-z][a-z0-9]*$/.test(name)) {
                return { ok: false, reason: `第 ${line} 行的结束标签 </${name}> 不是合法标签` }
            }
            const top = openStack.pop()
            if (top === undefined || top.name !== name) {
                return { ok: false, reason: `第 ${line} 行的 </${name}> 标签配对不正确（先处理上方未闭合的${top ? ` <${top.name}>` : "文本"}）` }
            }
        } else {
            const selfClosing = raw.endsWith("/")
            const name = selfClosing ? raw.slice(0, -1) : raw
            if (!/^[a-z][a-z0-9]*$/.test(name)) {
                return { ok: false, reason: `第 ${line} 行的标签带有属性或非法字符（如 <${raw}>）——只支持无属性的 ${[...CONTAINER_TAGS, ...VOID_TAGS].join("/")}` }
            }
            if (CONTAINER_TAGS.has(name)) {
                if (selfClosing) return { ok: false, reason: `第 ${line} 行的 <${name}/> 应写成 <${name}>…</${name}>` }
                openStack.push({ name, line })
            } else if (VOID_TAGS.has(name)) {
                if (!selfClosing && raw !== name) {
                    return { ok: false, reason: `第 ${line} 行的 <${raw}> 不支持属性，应写成 <${name}/>` }
                }
            } else {
                return { ok: false, reason: `第 ${line} 行的 <${name}> 标签不受客户端支持（可用：p/div/h1-h3/ul/ol/li/table/tr/th/td/br/hr）` }
            }
        }
    }
    if (openStack.length > 0) {
        const top = openStack.at(-1)
        return { ok: false, reason: `<${top?.name}> 标签（第 ${top?.line} 行）未闭合` }
    }
    return { ok: true }
}
