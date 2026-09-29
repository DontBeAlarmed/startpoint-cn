// 公告正文工具栏的纯函数模块：只负责"在光标处插入白名单 RichText 片段"的
// 文本与选区计算。textarea 仍是唯一事实源，这里不持有任何编辑器状态。
// 白名单与 src/lib/news-rich-text.ts 保持一致：容器标签（无属性、须配对）、
// void 标签 <br/>/<hr/>、方括号标记 [b]…[/b] 与 [color=xxxxxx]…[/color]。

export interface RichTextFragment {
    open: string
    close: string
    placeholder?: string
}

export interface RichTextInsertion {
    text: string
    selStart: number
    selEnd: number
}

export interface NewsToolbarAction extends RichTextFragment {
    key: string
    label: string
    title: string
}

export interface NewsColorOption {
    hex: string
    label: string
}

// 预设色板与 admin 主题 token 同源（审查稿五属性配色 + 白）。
export const NEWS_COLOR_PALETTE: readonly NewsColorOption[] = [
    { hex: "FFD335", label: "星黄" },
    { hex: "4FA8E8", label: "水蓝" },
    { hex: "2FA85C", label: "风绿" },
    { hex: "D99A00", label: "雷黄" },
    { hex: "E8544A", label: "火红" },
    { hex: "FFFFFF", label: "白" },
]

export const NEWS_TOOLBAR_ACTIONS: readonly NewsToolbarAction[] = [
    { key: "bold", label: "加粗", title: "加粗 [b]…[/b]", open: "[b]", close: "[/b]", placeholder: "加粗文本" },
    { key: "paragraph", label: "P", title: "段落 <p>…</p>", open: "<p>", close: "</p>", placeholder: "段落内容" },
    { key: "heading", label: "H2", title: "标题 <h2>…</h2>", open: "<h2>", close: "</h2>", placeholder: "标题内容" },
    { key: "list", label: "列表", title: "列表 <ul><li>…</li></ul>", open: "<ul><li>", close: "</li></ul>", placeholder: "列表项" },
    { key: "line-break", label: "换行", title: "换行 <br/>", open: "<br/>", close: "" },
    { key: "divider", label: "分隔线", title: "分隔线 <hr/>", open: "<hr/>", close: "" },
]

// 由预设色生成 [color=hex]…[/color] 片段；hex 只保留十六进制字符并截断到 6 位，
// 保证产物永远是合法的 6 位 hex 标记。
export function colorFragment(hex: string): RichTextFragment {
    const normalized = hex.replace(/[^0-9a-fA-F]/g, "").slice(0, 6)
    return { open: `[color=${normalized}]`, close: "[/color]", placeholder: "着色文本" }
}

// 在 [selStart, selEnd) 处插入 open…close：
// - 有选区 → open+选区+close，选区保持选中（可继续键入覆盖）；
// - 无选区 → open+placeholder+close，placeholder 选中，键入即替换；
// - close 为空（void 标签）时光标落在片段之后。
// 位置全部按 UTF-16 code unit 计算，与 textarea 的 selectionStart/End、
// String.slice/setSelectionRange 同一坐标系，中文文本同样精确。
export function insertAround(
    source: string,
    selStart: number,
    selEnd: number,
    open: string,
    close: string,
    placeholder = "",
): RichTextInsertion {
    let start = Math.max(0, Math.min(selStart, source.length))
    let end = Math.max(0, Math.min(selEnd, source.length))
    if (start > end) {
        ;[start, end] = [end, start]
    }

    const head = source.slice(0, start)
    const tail = source.slice(end)
    const offset = start + open.length

    if (end > start) {
        const selected = source.slice(start, end)
        return {
            text: `${head}${open}${selected}${close}${tail}`,
            selStart: offset,
            selEnd: offset + selected.length,
        }
    }

    return {
        text: `${head}${open}${placeholder}${close}${tail}`,
        selStart: offset,
        selEnd: offset + placeholder.length,
    }
}
