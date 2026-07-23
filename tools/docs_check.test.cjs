const assert = require("node:assert/strict")
const { spawnSync } = require("node:child_process")
const fs = require("node:fs")
const os = require("node:os")
const path = require("node:path")
const test = require("node:test")

const REQUIRED_DOC_DIRECTORIES = [
    "admin",
    "cdn",
    "development",
    "getting-started",
    "protocol",
    "reference",
    "runtime",
    "status",
    "systems",
]

function loadChecker() {
    try {
        return require("./docs_check.cjs").checkDocumentation
    } catch (error) {
        assert.fail(`文档检查器不可用: ${error.message}`)
    }
}

function write(root, relativePath, content) {
    const filePath = path.join(root, relativePath)
    fs.mkdirSync(path.dirname(filePath), { recursive: true })
    fs.writeFileSync(filePath, `${content.trim()}\n`, "utf8")
}

function createValidFixture(t) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "starpoint-docs-check-"))
    t.after(() => fs.rmSync(root, { recursive: true, force: true }))

    write(root, "README.md", "# 示例项目\n\n- [项目文档](./docs/README.md)")
    const rootLinks = ["[架构](./architecture.md)"]
    for (const directory of REQUIRED_DOC_DIRECTORIES) {
        rootLinks.push(`[${directory}](./${directory}/README.md)`)
    }
    write(root, "docs/README.md", `# 文档\n\n${rootLinks.join("\n")}`)
    write(root, "docs/architecture.md", "# 当前架构\n\n这是当前架构说明。")

    for (const directory of REQUIRED_DOC_DIRECTORIES) {
        write(root, `docs/${directory}/README.md`, `# ${directory} 文档\n\n当前目录入口。`)
    }

    return root
}

function trackedMarkdown(root) {
    const files = []
    function visit(directory) {
        for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
            const entryPath = path.join(directory, entry.name)
            if (entry.isDirectory()) visit(entryPath)
            if (entry.isFile() && entry.name.endsWith(".md")) {
                files.push(path.relative(root, entryPath).split(path.sep).join("/"))
            }
        }
    }
    visit(root)
    return files.sort()
}

test("正常中文文档树通过", t => {
    const checkDocumentation = loadChecker()
    const root = createValidFixture(t)

    assert.deepEqual(checkDocumentation({ rootDir: root, trackedFiles: trackedMarkdown(root) }), [])
})

test("候选清单包含 tracked 与未忽略的未跟踪 Markdown", t => {
    const { listTrackedFiles } = require("./docs_check.cjs")
    const root = createValidFixture(t)
    write(root, ".gitignore", "ignored.md")
    write(root, "ignored.md", "# 忽略文档")
    const initialized = spawnSync("git", ["init", "--quiet"], { cwd: root, encoding: "utf8" })
    assert.equal(initialized.status, 0, initialized.stderr)
    const added = spawnSync("git", ["add", "README.md"], { cwd: root, encoding: "utf8" })
    assert.equal(added.status, 0, added.stderr)

    const candidates = listTrackedFiles(root)
    assert.ok(candidates.includes("README.md"))
    assert.ok(candidates.includes("docs/runtime/README.md"))
    assert.equal(candidates.includes("ignored.md"), false)
})

test("相对文件链接缺失时失败", t => {
    const checkDocumentation = loadChecker()
    const root = createValidFixture(t)
    fs.appendFileSync(path.join(root, "docs", "README.md"), "\n[缺失文档](./missing.md)\n")

    const errors = checkDocumentation({ rootDir: root, trackedFiles: trackedMarkdown(root) })

    assert.ok(errors.some(error => error.includes("链接目标不存在") && error.includes("missing.md")))
})

test("路径大小写不一致时在大小写不敏感文件系统上也失败", t => {
    const checkDocumentation = loadChecker()
    const root = createValidFixture(t)
    fs.appendFileSync(path.join(root, "docs", "README.md"), "\n[错误大小写](./Architecture.md)\n")

    const errors = checkDocumentation({ rootDir: root, trackedFiles: trackedMarkdown(root) })

    assert.ok(errors.some(error => error.includes("路径大小写不一致") && error.includes("Architecture.md")))
})

test("引用式链接定义目标缺失时失败", t => {
    const checkDocumentation = loadChecker()
    const root = createValidFixture(t)
    fs.appendFileSync(path.join(root, "docs", "README.md"), "\n参见[缺失文档][missing-doc]。\n\n[missing-doc]: ./missing-reference.md\n")

    const errors = checkDocumentation({ rootDir: root, trackedFiles: trackedMarkdown(root) })

    assert.ok(errors.some(error => error.includes("链接目标不存在") && error.includes("missing-reference.md")))
})

test("含括号的内联目标缺失时保留完整路径", t => {
    const checkDocumentation = loadChecker()
    const root = createValidFixture(t)
    fs.appendFileSync(path.join(root, "docs", "README.md"), "\n[缺失括号文档](./a(b).md)\n")

    const errors = checkDocumentation({ rootDir: root, trackedFiles: trackedMarkdown(root) })

    assert.ok(errors.some(error => error.includes("链接目标不存在") && error.includes("./a(b).md")))
    assert.equal(errors.some(error => error.includes("./a(b") && !error.includes("./a(b).md")), false)
})

test("含括号和尖括号的现有目标通过并计入索引", t => {
    const checkDocumentation = loadChecker()
    const root = createValidFixture(t)
    write(root, "docs/a(b).md", "# 括号文档")
    write(root, "docs/含 空格.md", "# 空格文档")
    fs.appendFileSync(path.join(root, "docs", "README.md"), "\n[括号文档](./a(b).md)\n[空格文档](<./含 空格.md>)\n")

    assert.deepEqual(checkDocumentation({ rootDir: root, trackedFiles: trackedMarkdown(root) }), [])
})

test("tracked 过程文档路径进入仓库时失败", t => {
    const checkDocumentation = loadChecker()
    const root = createValidFixture(t)
    const forbiddenFiles = [
        "CLAUDE.md",
        "release-plan.md",
        ".omo/plans/example.md",
        "feature/plans/example.md",
        "docs/superpowers/specs/example.md",
        "docs/example-plan.md",
        "docs/refactoring/example.md",
        "docs/optimization/example.md",
    ]

    const errors = checkDocumentation({
        rootDir: root,
        trackedFiles: [...trackedMarkdown(root), ...forbiddenFiles],
    })

    for (const file of forbiddenFiles) {
        assert.ok(errors.some(error => error.includes("禁止提交过程文档") && error.includes(file)))
    }
})

test("原始路由抓包目录禁止提交", t => {
    const checkDocumentation = loadChecker()
    const root = createValidFixture(t)
    const captures = [
        "docs/routes/legacy-example.md",
        "docs/reference/routes/example.md",
    ]
    for (const capture of captures) write(root, capture, "# 原始请求样本")

    const errors = checkDocumentation({ rootDir: root, trackedFiles: trackedMarkdown(root) })

    for (const capture of captures) {
        assert.ok(errors.some(error => error.includes("禁止提交原始路由抓包") && error.includes(capture)))
    }
})

test("当前仓库文档门禁通过并扫描全仓可提交 Markdown", () => {
    const { checkDocumentation, listTrackedFiles } = require("./docs_check.cjs")
    const root = path.resolve(__dirname, "..")
    const trackedFiles = listTrackedFiles(root)

    assert.ok(trackedFiles.includes("CODE_OF_CONDUCT.md"))
    assert.ok(trackedFiles.includes("client-patch/README.md"))
    assert.ok(trackedFiles.includes("tools/gacha-faithful/README.md"))
    assert.equal(trackedFiles.some(file => file.startsWith("docs/routes/")), false)
    assert.equal(trackedFiles.some(file => file.startsWith("docs/reference/routes/")), false)
    const gitleaksConfig = fs.readFileSync(path.join(root, ".gitleaks.toml"), "utf8")
    assert.doesNotMatch(gitleaksConfig, /docs\/(?:reference\/)?routes\//u)
    assert.deepEqual(checkDocumentation({ rootDir: root, trackedFiles }), [])
})

test("要求的主目录缺少 README 时失败", t => {
    const checkDocumentation = loadChecker()
    const root = createValidFixture(t)
    fs.rmSync(path.join(root, "docs", "runtime", "README.md"))

    const errors = checkDocumentation({ rootDir: root, trackedFiles: trackedMarkdown(root) })

    assert.ok(errors.some(error => error.includes("主目录缺少 README") && error.includes("docs/runtime/README.md")))
})

test("current 文档未被同目录 README 索引时失败", t => {
    const checkDocumentation = loadChecker()
    const root = createValidFixture(t)
    write(root, "docs/systems/new-system.md", "# 新系统\n\n尚未加入目录索引。")

    const errors = checkDocumentation({ rootDir: root, trackedFiles: trackedMarkdown(root) })

    assert.ok(errors.some(error => error.includes("未被同目录 README 索引") && error.includes("new-system.md")))
})
