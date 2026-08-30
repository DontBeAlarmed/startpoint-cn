"use strict"

const assert = require("node:assert/strict")
const fs = require("node:fs")
const path = require("node:path")

const appPath = path.join(__dirname, "../admin/src/App.tsx")
const pagePath = path.join(__dirname, "../admin/src/pages/News.tsx")
const editorPath = path.join(__dirname, "../admin/src/features/news/NewsEditor.tsx")
const typesPath = path.join(__dirname, "../admin/src/features/news/types.ts")

assert.equal(fs.existsSync(pagePath), true, "公告页面应独立拆分")
assert.equal(fs.existsSync(editorPath), true, "公告编辑器应独立拆分")
assert.equal(fs.existsSync(typesPath), true, "公告类型应独立拆分")

const app = fs.readFileSync(appPath, "utf8")
const page = fs.readFileSync(pagePath, "utf8")
const editor = fs.readFileSync(editorPath, "utf8")
const types = fs.readFileSync(typesPath, "utf8")

assert.match(app, /key: "\/news"/)
assert.match(app, /label: "公告"/)
assert.match(app, /<Route path="\/news" element=\{<News \/>\} \/>/)

for (const source of [page, editor]) {
    assert.match(source, /useMutation/, "公告页面应使用 TanStack Query mutation")
}
assert.match(page, /useQuery/)
assert.match(page, /queryKey: \["adminNews", page, pageSize\]/)
assert.match(page, /apiGet<NewsPage>\(`\/api\/news\?page=\$\{page\}&pageSize=\$\{pageSize\}`\)/)

for (const value of [1, 2, 3]) {
    assert.match(editor, new RegExp(`value: ${value}, label: "`), `缺少公告分类选项 ${value}`)
}
assert.equal(page.includes('1: "主题"'), true, "分类 1 必须是主题公告")
assert.equal(page.includes('2: "活动"'), true, "分类 2 必须是活动公告")
assert.equal(page.includes('3: "问题"'), true, "分类 3 必须是问题公告")
assert.equal(editor.includes('value: 1, label: "主题公告"'), true, "编辑器分类 1 必须是主题公告")
assert.equal(editor.includes('value: 2, label: "活动公告"'), true, "编辑器分类 2 必须是活动公告")
assert.equal(editor.includes('value: 3, label: "问题公告"'), true, "编辑器分类 3 必须是问题公告")
for (const source of [page, editor]) {
    assert.equal(source.includes("系统公告"), false, "普通公告界面不得把分类 3 显示为系统公告")
}
assert.match(
    editor,
    /enabled: news\?\.enabled \?\? false/,
    "新建公告默认必须是停用草稿",
)
assert.match(editor, /LABEL_OPTIONS = Array\.from\(\{ length: 8 \}, \(_, index\) => \(\{\n    value: index \+ 1,/)
assert.match(editor, /THUMBNAIL_OPTIONS = Array\.from\(\{ length: 13 \}, \(_, index\) => \(\{\n    value: index \+ 1,/)

assert.match(editor, /const \{ TextArea \} = Input/)
assert.match(editor, /<TextArea[\s\S]*value=\{draft\.bodyRichText\}/)
assert.match(
    editor,
    /<iframe\s+title="公告预览"\s+sandbox=""\s+srcDoc=\{draft\.bodyRichText\}\s+\/>/,
    "公告预览必须使用空 sandbox iframe",
)
assert.match(page, /物理删除/)
assert.match(page, /公告已被其他操作修改，请刷新/)
assert.match(page, /queryClient\.invalidateQueries\(\{ queryKey: \["adminNews"\] \}\)/)
assert.match(page, /queryClient\.invalidateQueries\(\{ queryKey: \["adminNewsDetail", .*?\] \}\)/)

for (const field of [
    "id: number",
    "category: 1 | 2 | 3",
    "title: string",
    "publishedAtReal: string",
    "bodyRichText: string",
    "label: number",
    "thumbnail: number",
    "enabled: boolean",
    "revision: number",
    "createdAt: string",
    "updatedAt: string",
]) {
    assert.match(types, new RegExp(field.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")))
}
assert.match(types, /export type NewsDraft = Pick<AdminNewsRow,/)

console.log("admin news UI source tests passed")
