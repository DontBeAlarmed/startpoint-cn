import { existsSync, renameSync, rmSync, writeFileSync } from "node:fs"
import { dirname, resolve } from "node:path"

const root = resolve(import.meta.dirname, "..")
const output = resolve(root, "out/cn-server.js")
const stamp = resolve(dirname(output), ".cn-server-build-stamp")
const temporary = `${stamp}.${process.pid}.tmp`

if (!existsSync(output)) {
    throw new Error(`Compiled CN entry is missing: ${output}`)
}

try {
    writeFileSync(temporary, `${JSON.stringify({
        schema_version: 1,
        entry: "out/cn-server.js",
        node: process.versions.node,
        recorded_at_utc: new Date().toISOString(),
    })}\n`, { encoding: "utf8", flag: "wx" })
    renameSync(temporary, stamp)
} finally {
    rmSync(temporary, { force: true })
}
