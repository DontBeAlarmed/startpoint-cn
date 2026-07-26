import * as path from "node:path"
import { runContentAssetAudit, type ContentAssetAuditReport } from "./runner"
import { ContentAssetAuditError } from "./types"

export type ContentAssetAuditOutputFormat = "text" | "json"

export interface ContentAssetAuditCliArguments {
    readonly sourceRoot: string
    readonly runtimeRoot: string
    readonly format: ContentAssetAuditOutputFormat
}

function argumentError(message: string): never {
    throw new ContentAssetAuditError("CONTENT_ASSET_AUDIT_ARGUMENTS", message)
}

export function parseContentAssetAuditArguments(
    argv: readonly string[],
    projectRoot: string,
): ContentAssetAuditCliArguments {
    let sourceRoot: string | undefined
    let runtimeRoot = path.resolve(projectRoot, "assets")
    let format: ContentAssetAuditOutputFormat = "text"
    const seen = new Set<string>()
    for (let index = 0; index < argv.length; index += 2) {
        const name = argv[index]
        const value = argv[index + 1]
        if (!value || !["--source-root", "--runtime-root", "--format"].includes(name)) {
            argumentError("expected --source-root with optional --runtime-root and --format")
        }
        if (seen.has(name)) argumentError(`duplicate argument: ${name}`)
        seen.add(name)
        if (name === "--source-root") sourceRoot = path.resolve(projectRoot, value)
        else if (name === "--runtime-root") runtimeRoot = path.resolve(projectRoot, value)
        else if (value === "text" || value === "json") format = value
        else argumentError("--format must be text or json")
    }
    if (sourceRoot === undefined) argumentError("--source-root is required")
    return { sourceRoot, runtimeRoot, format }
}

export function formatContentAssetAuditReport(
    report: ContentAssetAuditReport,
    format: ContentAssetAuditOutputFormat,
): string {
    if (format === "json") return `${JSON.stringify(report)}\n`
    return [
        `DONE [CONTENT_ASSET_AUDIT_OK] source=${report.sourceVersion}`,
        `deep=${report.deepComparedTableCount}/${report.deepComparedTableCount}`,
        `registry=${report.readableRuntimeTableCount}/${report.registryTableCount}`,
        `keys=${report.deepComparedKeyCount}`,
        `awake=${report.missionContracts.awakeCharacterCount}`,
    ].join(" ") + "\n"
}

interface ContentAssetAuditCliDependencies {
    readonly projectRoot?: string
    readonly stdout?: Pick<NodeJS.WriteStream, "write">
    readonly stderr?: Pick<NodeJS.WriteStream, "write">
    readonly runAudit?: typeof runContentAssetAudit
}

function safeDiagnostic(value: string | null): string | null {
    return value !== null
        && !path.isAbsolute(value)
        && /^[A-Za-z0-9_./-]+$/.test(value)
        && !value.split("/").includes("..")
        ? value
        : null
}

export function main(
    argv: readonly string[] = process.argv.slice(2),
    dependencies: ContentAssetAuditCliDependencies = {},
): number {
    const projectRoot = dependencies.projectRoot ?? path.resolve(__dirname, "../../..")
    const stdout = dependencies.stdout ?? process.stdout
    const stderr = dependencies.stderr ?? process.stderr
    try {
        const options = parseContentAssetAuditArguments(argv, projectRoot)
        const report = (dependencies.runAudit ?? runContentAssetAudit)(options)
        stdout.write(formatContentAssetAuditReport(report, options.format))
        return 0
    } catch (error) {
        const code = error instanceof ContentAssetAuditError
            ? error.code
            : "CONTENT_ASSET_AUDIT_FAILED"
        const side = error instanceof ContentAssetAuditError ? error.inputSide : null
        const tableName = error instanceof ContentAssetAuditError
            ? safeDiagnostic(error.tableName)
            : null
        const diagnostics = [
            side === null ? null : `side=${side}`,
            tableName === null ? null : `table=${tableName}`,
        ].filter((value): value is string => value !== null)
        stderr.write(
            `BLOCKED [${code}] content asset audit failed${diagnostics.length === 0 ? "" : ` ${diagnostics.join(" ")}`}\n`,
        )
        return code === "CONTENT_ASSET_AUDIT_ARGUMENTS" ? 2 : 1
    }
}
