// Node 20 and 22 disagree on how `node --test <directory>` is resolved on
// Windows (22 treats the argument as a glob and then tries to execute the
// directory as a module), so enumerate the compiled test files explicitly.
import { readdirSync } from "node:fs"
import { spawnSync } from "node:child_process"
import { join, resolve } from "node:path"

const root = resolve(import.meta.dirname, "..", "out", "tests")
const files = readdirSync(root, { recursive: true })
    .map(String)
    .filter(name => name.endsWith(".test.js"))
    .map(name => join(root, name))
    .sort()

if (files.length === 0) {
    throw new Error(`No compiled test files under ${root}; run build:server first`)
}

const result = spawnSync(process.execPath, ["--test", ...files], { stdio: "inherit" })
process.exit(result.status ?? 1)
