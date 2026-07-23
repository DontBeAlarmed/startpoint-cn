#!/usr/bin/env node

const fs = require("node:fs")
const path = require("node:path")
const { spawnSync } = require("node:child_process")

const REQUIRED_READMES = [
    "README.md",
    "docs/README.md",
    "docs/admin/README.md",
    "docs/cdn/README.md",
    "docs/development/README.md",
    "docs/getting-started/README.md",
    "docs/protocol/README.md",
    "docs/reference/README.md",
    "docs/runtime/README.md",
    "docs/status/README.md",
    "docs/systems/README.md",
]

function toPosix(filePath) {
    return filePath.split(path.sep).join("/")
}

function listTrackedFiles(rootDir) {
    const result = spawnSync(
        "git",
        ["ls-files", "--cached", "--others", "--exclude-standard", "--", "*.md"],
        {
            cwd: rootDir,
            encoding: "utf8",
        },
    )
    if (result.error) throw result.error
    if (result.status !== 0) {
        throw new Error(result.stderr.trim() || "无法读取 Git 文档清单")
    }
    return result.stdout.split(/\r?\n/)
        .filter(Boolean)
        .map(toPosix)
        .filter(isDocumentationFile)
}

function isDocumentationFile(file) {
    return file.endsWith(".md")
}

function isForbiddenProcessDocument(file) {
    const basename = path.posix.basename(file)
    return basename === "CLAUDE.md"
        || /(?:^|\/)plans\//u.test(file)
        || file.startsWith("docs/superpowers/specs/")
        || file.startsWith("docs/refactoring/")
        || file.startsWith("docs/optimization/")
        || basename.endsWith("-plan.md")
}

function isForbiddenRouteCapture(file) {
    return file.startsWith("docs/routes/")
        || file.startsWith("docs/reference/routes/")
}

function readDestination(source, start, { inline = false } = {}) {
    let index = start
    while (index < source.length && /\s/u.test(source[index])) index++
    if (index >= source.length) return null

    if (source[index] === "<") {
        let target = ""
        for (index++; index < source.length; index++) {
            const character = source[index]
            if (character === "\\" && index + 1 < source.length) {
                target += source[++index]
                continue
            }
            if (character === ">") return { end: index + 1, target }
            if (character === "\n") return null
            target += character
        }
        return null
    }

    let depth = 0
    let target = ""
    for (; index < source.length; index++) {
        const character = source[index]
        if (character === "\\" && index + 1 < source.length) {
            target += source[++index]
            continue
        }
        if (character === "(") {
            depth++
            target += character
            continue
        }
        if (character === ")") {
            if (inline && depth === 0) return { end: index, target }
            if (depth > 0) depth--
            target += character
            continue
        }
        if (/\s/u.test(character) && depth === 0) {
            return { end: index, target }
        }
        target += character
    }
    return target ? { end: index, target } : null
}

function extractLinkTargets(markdown) {
    const targets = []

    for (let index = 0; index < markdown.length - 1; index++) {
        if (markdown[index] !== "]" || markdown[index + 1] !== "(") continue
        const parsed = readDestination(markdown, index + 2, { inline: true })
        if (parsed?.target) targets.push(parsed.target)
        if (parsed) index = parsed.end
    }

    const definitionPattern = /^[ \t]{0,3}\[[^\]\n]+\]:[ \t]*(.*)$/gmu
    for (const match of markdown.matchAll(definitionPattern)) {
        const parsed = readDestination(match[1], 0)
        if (parsed?.target) targets.push(parsed.target)
    }

    return targets
}

function relativeFileTarget(target) {
    if (target.startsWith("#") || target.startsWith("/")) return null
    if (/^[a-z][a-z\d+.-]*:/iu.test(target)) return null
    const withoutFragment = target.split("#", 1)[0].split("?", 1)[0]
    if (!withoutFragment) return null
    try {
        return decodeURIComponent(withoutFragment)
    } catch {
        return withoutFragment
    }
}

function inspectExactPath(rootDir, absoluteTarget) {
    const relative = path.relative(rootDir, absoluteTarget)
    if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
        return { kind: "outside" }
    }

    let current = rootDir
    for (const segment of relative.split(path.sep).filter(Boolean)) {
        if (!fs.existsSync(current) || !fs.statSync(current).isDirectory()) {
            return { kind: "missing" }
        }
        const entries = fs.readdirSync(current)
        if (entries.includes(segment)) {
            current = path.join(current, segment)
            continue
        }
        const caseMatch = entries.find(entry => entry.toLocaleLowerCase("en-US") === segment.toLocaleLowerCase("en-US"))
        if (caseMatch) return { actual: caseMatch, expected: segment, kind: "case" }
        return { kind: "missing" }
    }
    return fs.existsSync(current) ? { kind: "ok" } : { kind: "missing" }
}

function resolveIndexedTargets(rootDir, readmeFile, markdown) {
    const readmeDirectory = path.dirname(path.join(rootDir, readmeFile))
    const targets = new Set()
    for (const rawTarget of extractLinkTargets(markdown)) {
        const target = relativeFileTarget(rawTarget)
        if (!target) continue
        const absolute = path.resolve(readmeDirectory, target)
        targets.add(toPosix(path.relative(rootDir, absolute)))
    }
    return targets
}

function checkDocumentation({ rootDir, trackedFiles = listTrackedFiles(rootDir) }) {
    const normalizedRoot = path.resolve(rootDir)
    const candidateDocs = [...new Set(trackedFiles.map(toPosix).filter(isDocumentationFile))].sort()
    const candidateSet = new Set(candidateDocs)
    const errors = []

    for (const file of candidateDocs) {
        if (isForbiddenProcessDocument(file)) {
            errors.push(`禁止提交过程文档: ${file}`)
        }
        if (isForbiddenRouteCapture(file)) {
            errors.push(`禁止提交原始路由抓包: ${file}`)
        }
    }

    for (const readme of REQUIRED_READMES) {
        if (!candidateSet.has(readme)) {
            errors.push(`主目录缺少 README: ${readme}`)
        }
    }

    const markdownByFile = new Map()
    for (const file of candidateDocs) {
        const absoluteFile = path.join(normalizedRoot, file)
        if (!fs.existsSync(absoluteFile)) continue
        const markdown = fs.readFileSync(absoluteFile, "utf8")
        markdownByFile.set(file, markdown)
        const sourceDirectory = path.dirname(absoluteFile)

        for (const rawTarget of extractLinkTargets(markdown)) {
            const target = relativeFileTarget(rawTarget)
            if (!target) continue
            const absoluteTarget = path.resolve(sourceDirectory, target)
            const inspection = inspectExactPath(normalizedRoot, absoluteTarget)
            if (inspection.kind === "case") {
                errors.push(`路径大小写不一致: ${file} -> ${rawTarget}（实际为 ${inspection.actual}）`)
            } else if (inspection.kind === "missing") {
                errors.push(`链接目标不存在: ${file} -> ${rawTarget}`)
            } else if (inspection.kind === "outside") {
                errors.push(`链接越出仓库目录: ${file} -> ${rawTarget}`)
            }
        }
    }

    for (const readme of REQUIRED_READMES.filter(file => file.startsWith("docs/"))) {
        const markdown = markdownByFile.get(readme)
        if (markdown === undefined) continue
        const directory = path.posix.dirname(readme)
        const indexedTargets = resolveIndexedTargets(normalizedRoot, readme, markdown)
        for (const file of candidateDocs) {
            if (file === readme || path.posix.dirname(file) !== directory) continue
            if (!indexedTargets.has(file)) {
                errors.push(`未被同目录 README 索引: ${file}`)
            }
        }
    }

    return [...new Set(errors)].sort()
}

function main() {
    const rootDir = path.resolve(__dirname, "..")
    const trackedFiles = listTrackedFiles(rootDir)
    const errors = checkDocumentation({ rootDir, trackedFiles })
    if (errors.length > 0) {
        process.stderr.write(`${errors.map(error => `- ${error}`).join("\n")}\n`)
        return 1
    }
    const documentCount = trackedFiles.filter(isDocumentationFile).length
    process.stdout.write(`文档检查通过: ${documentCount} 份 Markdown\n`)
    return 0
}

if (require.main === module) process.exitCode = main()

module.exports = {
    REQUIRED_READMES,
    checkDocumentation,
    extractLinkTargets,
    inspectExactPath,
    isForbiddenProcessDocument,
    isForbiddenRouteCapture,
    listTrackedFiles,
    main,
}
