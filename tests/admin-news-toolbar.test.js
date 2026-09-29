"use strict"

// 公告正文工具栏（路线 B）：源码断言 + 纯函数行为断言。
// - richTextToolbar.ts 通过 esbuild 转译后真实执行 insertAround/colorFragment；
// - NewsEditor.tsx 断言按钮接线（type="button"、ref/选区恢复、受控 value 不变）；
// - 工具栏片段必须落在 src/lib/news-rich-text.ts 的白名单内，且无 http/https 输出路径。

const assert = require("node:assert/strict")
const fs = require("node:fs")
const path = require("node:path")
const esbuild = require("esbuild")

const rootDir = path.join(__dirname, "..")
const toolbarModulePath = path.join(rootDir, "admin/src/features/news/richTextToolbar.ts")
const editorPath = path.join(rootDir, "admin/src/features/news/NewsEditor.tsx")
const serverRichTextPath = path.join(rootDir, "src/lib/news-rich-text.ts")

assert.equal(fs.existsSync(toolbarModulePath), true, "工具栏纯函数模块应存在")

const toolbarSource = fs.readFileSync(toolbarModulePath, "utf8")
const editor = fs.readFileSync(editorPath, "utf8")
const serverRichTextSource = fs.readFileSync(serverRichTextPath, "utf8")

// ── 1. 行为断言：转译 TS 模块并真实执行 ────────────────────────────────────
const transformed = esbuild.transformSync(toolbarSource, { loader: "ts", format: "cjs" }).code
const toolbarModule = { exports: {} }
new Function("exports", "require", "module", transformed)(toolbarModule.exports, () => {
    throw new Error("richTextToolbar.ts 不应引入任何依赖")
}, toolbarModule)
const { insertAround, colorFragment, NEWS_COLOR_PALETTE, NEWS_TOOLBAR_ACTIONS } = toolbarModule.exports

assert.equal(typeof insertAround, "function", "insertAround 应可执行")

// 有选区：open+选区+close，选区保持选中（中文文本下 code unit 精确）
assert.deepEqual(insertAround("活动公告正文", 2, 4, "[b]", "[/b]"), {
    text: "活动[b]公告[/b]正文",
    selStart: 5,
    selEnd: 7,
})
assert.equal(insertAround("活动公告正文", 2, 4, "[b]", "[/b]").text.slice(5, 7), "公告", "保持选中的正是原选中文本")

// 无选区：open+placeholder+close，placeholder 选中（键入即替换）
assert.deepEqual(insertAround("", 0, 0, "<p>", "</p>", "段落内容"), {
    text: "<p>段落内容</p>",
    selStart: 3,
    selEnd: 7,
})

// placeholder 缺省为空串：空配对插入，光标停在配对中间
assert.deepEqual(insertAround("<p></p>", 3, 3, "[b]", "[/b]"), {
    text: "<p>[b][/b]</p>",
    selStart: 6,
    selEnd: 6,
})

// 反向选区归一化
assert.deepEqual(insertAround("abcd", 3, 1, "[b]", "[/b]"), {
    text: "a[b]bc[/b]d",
    selStart: 4,
    selEnd: 6,
})

// 越界位置钳制到 [0, source.length]
assert.deepEqual(insertAround("ab", -5, 99, "[b]", "[/b]"), {
    text: "[b]ab[/b]",
    selStart: 3,
    selEnd: 5,
})

// void 片段（close 为空、无 placeholder）：插入后光标落在片段之后
assert.deepEqual(insertAround("A<br/>B", 7, 7, "<hr/>", ""), {
    text: "A<br/>B<hr/>",
    selStart: 12,
    selEnd: 12,
})

// 中间插入：光标定位逐 code unit 精确
assert.deepEqual(insertAround("步骤一", 2, 2, "[b]", "[/b]", "x"), {
    text: "步骤[b]x[/b]一",
    selStart: 5,
    selEnd: 6,
})

// colorFragment：只保留十六进制字符并截断到 6 位
assert.deepEqual(colorFragment("FFD335"), {
    open: "[color=FFD335]",
    close: "[/color]",
    placeholder: "着色文本",
})
assert.equal(colorFragment("#ffd335!").open, "[color=ffd335]")
assert.equal(colorFragment("FFD335EXTRA").open, "[color=FFD335]")

// ── 2. 白名单一致性：与服务端 src/lib/news-rich-text.ts 同源 ───────────────
function extractTagSet(source, setName) {
    const match = source.match(new RegExp(`${setName} = new Set\\(\\[([\\s\\S]*?)\\]\\)`))
    assert.notEqual(match, null, `服务端应定义 ${setName}`)
    return new Set(Array.from(match[1].matchAll(/"([a-z0-9]+)"/g), m => m[1]))
}
const containerTags = extractTagSet(serverRichTextSource, "CONTAINER_TAGS")
const voidTags = extractTagSet(serverRichTextSource, "VOID_TAGS")
assert.equal(containerTags.has("p"), true)
assert.equal(voidTags.has("hr"), true)

// 片段里的每个 token 必须是白名单容器标签（非自闭合）、void 标签（必须自闭合）
// 或 [b]/[/b]/[color=hex]/[/color] 方括号标记；不许夹带裸文本或白名单外标记。
function assertFragmentAllowed(fragment, origin) {
    for (const piece of [fragment.open, fragment.close]) {
        const tagTokens = piece.match(/<[^>]*>/g) ?? []
        for (const token of tagTokens) {
            const raw = token.slice(1, -1)
            const selfClosing = raw.endsWith("/")
            let inner = selfClosing ? raw.slice(0, -1) : raw
            const isClosing = inner.startsWith("/")
            if (isClosing) inner = inner.slice(1)
            assert.match(inner, /^[a-z][a-z0-9]*$/, `${origin}: 标签名非法 ${token}`)
            if (isClosing) {
                assert.equal(containerTags.has(inner), true, `${origin}: 闭合标签必须是白名单容器 ${token}`)
                assert.equal(selfClosing, false, `${origin}: 闭合标签不得自闭合 ${token}`)
            } else if (containerTags.has(inner)) {
                assert.equal(selfClosing, false, `${origin}: 容器标签不得自闭合 ${token}`)
            } else {
                assert.equal(voidTags.has(inner), true, `${origin}: 标签不在白名单 ${token}`)
                assert.equal(selfClosing, true, `${origin}: void 标签必须自闭合 ${token}`)
            }
        }
        const bracketTokens = piece.match(/\[[^\]]*\]/g) ?? []
        for (const token of bracketTokens) {
            assert.match(token, /^\[(?:b|\/b|color=[0-9a-fA-F]{6}|\/color)\]$/, `${origin}: 方括号标记非法 ${token}`)
        }
        const residue = piece.replace(/<[^>]*>/g, "").replace(/\[[^\]]*\]/g, "")
        assert.equal(residue, "", `${origin}: 片段不得夹带裸文本`)
    }
}

assert.equal(NEWS_TOOLBAR_ACTIONS.length, 6, "工具栏应有 6 个标签动作（加粗/段落/标题/列表/换行/分隔线）")
for (const action of NEWS_TOOLBAR_ACTIONS) {
    assertFragmentAllowed(action, `动作 ${action.key}`)
}
assert.deepEqual(
    NEWS_TOOLBAR_ACTIONS.map(action => action.key),
    ["bold", "paragraph", "heading", "list", "line-break", "divider"],
)

assert.equal(NEWS_COLOR_PALETTE.length, 6, "色板应有 6 个预设色")
for (const color of NEWS_COLOR_PALETTE) {
    assert.match(color.hex, /^[0-9A-F]{6}$/, `预设色必须是 6 位 hex: ${color.hex}`)
    assertFragmentAllowed(colorFragment(color.hex), `色板 ${color.label}`)
}

// ── 3. 源码断言：NewsEditor.tsx 接线 ──────────────────────────────────────
// 所有按钮都是 type="button"（严禁触发表单提交）
const buttonOpenings = editor.match(/<button(?=[\s>])/g) ?? []
const typedButtons = editor.match(/<button type="button"/g) ?? []
assert.notEqual(buttonOpenings.length, 0, "工具栏应有按钮")
assert.equal(buttonOpenings.length, typedButtons.length, "每个 <button> 都必须是 type=\"button\"")

// 无 http/https 输出路径
for (const [source, label] of [[editor, "NewsEditor.tsx"], [toolbarSource, "richTextToolbar.ts"]]) {
    for (const marker of ["http://", "https://", "www."]) {
        assert.equal(source.includes(marker), false, `${label} 不得包含 ${marker}`)
    }
}

// 工具栏渲染在正文 Form.Item 内、TextArea 之前
const toolbarAt = editor.indexOf('className="news-toolbar"')
const textAreaAt = editor.indexOf("<TextArea")
assert.equal(toolbarAt > -1 && textAreaAt > -1 && toolbarAt < textAreaAt, true, "工具栏必须渲染在 TextArea 之前")
assert.equal(editor.includes('extra="使用客户端 RichText 标签，不支持属性和外部链接。"'), true, "正文 Form.Item 说明保留")
assert.match(editor, /role="toolbar"/)

// textarea 接线：DOM ref 读选区，纯函数计算插入，既有 onChange 通道写回
assert.match(editor, /bodyAreaRef = useRef<HTMLTextAreaElement \| null>\(null\)/)
assert.match(editor, /instance\?\.resizableTextArea\?\.textArea/)
assert.match(editor, /area\.selectionStart/, "插入点应来自原生 selectionStart")
assert.match(editor, /area\.selectionEnd/, "插入点应来自原生 selectionEnd")
assert.match(editor, /insertAround\(/, "应调用 insertAround 计算插入")
assert.match(editor, /update\("bodyRichText", result\.text\)/, "新文本必须走既有 onChange 通道写回")
// 原生 setter 同步写回 + input 事件走受控 onChange（避免受控重渲染光标竞态）
assert.match(editor, /nativeValueSetter\.call\(area, result\.text\)/, "原生 setter 同步写回")
assert.match(editor, /dispatchEvent\(new Event\("input", \{ bubbles: true \}\)\)/, "input 事件走受控通道")
assert.match(editor, /area\.focus\(\)/, "点击后焦点返回 textarea")
assert.match(editor, /area\.setSelectionRange\(result\.selStart, result\.selEnd\)/, "必须恢复选区")
assert.match(editor, /onMouseDown=\{event => event\.preventDefault\(\)\}/, "mousedown preventDefault 保持 textarea 焦点与选区")

// 受控 textarea 完全不变（Form.Item value/onChange 通道）
assert.match(editor, /<TextArea[\s\S]*?value=\{draft\.bodyRichText\}[\s\S]*?onChange=\{event => update\("bodyRichText", event\.target\.value\)\}/)
// 预览与提交零改动
assert.match(editor, /renderNewsRichText\(draft\.bodyRichText\)/)
assert.match(editor, /srcDoc=\{draft\.bodyRichText\}/)

// 纯函数模块关键分支存在（配对/占位）
assert.match(toolbarSource, /placeholder = ""/, "placeholder 缺省空串")
assert.match(toolbarSource, /if \(start > end\)/, "反向选区归一化分支")
assert.match(toolbarSource, /if \(end > start\)/, "有选区/无选区分支")

// 色板不引第三方组件，用 span 色块 + 极简 button
assert.match(editor, /news-toolbar-palette/)
assert.match(editor, /news-toolbar-swatch/)
assert.match(editor, /background: `#\$\{color\.hex\}`/)

console.log("admin news toolbar tests passed")


// ── 客户端 RichText 预校验 (validateRichTextClient): 与服务端同构的精确报错 ──
const { execSync } = require("node:child_process")
const os = require("node:os")
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "news-validate-"))
const outFile = path.join(tmp, "validate.cjs")
execSync(`npx esbuild ${JSON.stringify(path.join(__dirname, "../admin/src/features/news/validateRichTextClient.ts"))} --bundle --format=cjs --outfile=${JSON.stringify(outFile)} --log-level=error`, { cwd: path.join(__dirname, "..") })
const { validateRichTextClient } = require(outFile)

assert.deepStrictEqual(validateRichTextClient("[b]测试[/b]修复若干问题\n<p>好</p>"), { ok: true }, "用户实测正文应通过")
assert.equal(validateRichTextClient("<p>好").ok, false, "未闭合应拒绝")
assert.match(validateRichTextClient("<p>好").reason, /未闭合/)
assert.match(validateRichTextClient('<p class="x">好</p>').reason, /带有属性或非法字符/)
assert.match(validateRichTextClient("<script>好</script>").reason, /不受客户端支持/)
assert.match(validateRichTextClient("看 https://example.com").reason, /不支持链接与外部引用/)
assert.equal(validateRichTextClient("纯文本无标签").ok, true, "纯文本应通过")
console.log("admin news client rich-text validation tests passed")
