"use strict"

const assert = require("node:assert/strict")
const fs = require("node:fs")
const os = require("node:os")
const path = require("node:path")
const { spawnSync } = require("node:child_process")
const test = require("node:test")
const Fastify = require("fastify")

require("ts-node/register/transpile-only")

const {
    characterFullShotPath,
    hashedAssetPath,
} = require("../src/content/cdn/asset-path-hash")
const {
    MediumArchiveIndex,
    isMediumPhysicalPath,
    toBrowserPng,
} = require("../src/content/cdn/medium-archive-index")
const contentRoutes = require("../src/routes/web_api/content")

// ── 哈希：对调查报告已验证样例做回归锚定 ─────────────────────────────────
// character/alk/ui/full_shot_1440_1920_0.png → medium_upload/6f/3c819e…
// (实存于 archive-medium-full/pinball-1.4.0-71-ec674b95.zip，PNG 939x1727)
test("hashedAssetPath replicates AssetPathTools for the verified alk sample", () => {
    assert.equal(
        hashedAssetPath("character/alk/ui/full_shot_1440_1920_0.png"),
        "6f/3c819ed0275e5f5b47073e58159c54e3e6839e",
    )
})

test("hashedAssetPath normalizes separators and leading slashes before hashing", () => {
    assert.equal(
        hashedAssetPath("/character\\alk//ui/full_shot_1440_1920_0.png"),
        hashedAssetPath("character/alk/ui/full_shot_1440_1920_0.png"),
    )
})

test("characterFullShotPath builds the medium full_shot logical path", () => {
    assert.equal(
        characterFullShotPath("alk", 0),
        "character/alk/ui/full_shot_1440_1920_0.png",
    )
    assert.equal(
        characterFullShotPath("alk", 1),
        "character/alk/ui/full_shot_1440_1920_1.png",
    )
})

// ── PNG 签名：流内小写 png 三字节 → 浏览器合法签名 ───────────────────────
function storedMediumPng() {
    return Buffer.concat([
        Buffer.from([0x89, 0x70, 0x6e, 0x67, 0x0d, 0x0a, 0x1a, 0x0a]),
        Buffer.from("payload-body"),
    ])
}

test("toBrowserPng patches the lowercase png bytes into the signature", () => {
    const patched = toBrowserPng(storedMediumPng())
    assert.deepEqual([...patched.subarray(0, 8)], [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
    assert.equal(patched.length, storedMediumPng().length)
    assert.equal(patched.subarray(8).toString(), "payload-body")
})

test("toBrowserPng leaves conforming payloads untouched", () => {
    const conforming = Buffer.concat([
        Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
        Buffer.from("already-fine"),
    ])
    assert.deepEqual([...toBrowserPng(conforming)], [...conforming])
})

// ── 索引：惰性构建 + medium_upload 物理路径过滤 ──────────────────────────
function fakeArchive(entries) {
    return {
        files: entries.map(([entryPath, type = "File"]) => ({ path: entryPath, type })),
    }
}

test("MediumArchiveIndex maps medium_upload entries across archives lazily", async () => {
    const opened = new Set()
    const index = new MediumArchiveIndex("/cdn/archive-medium-full", {
        listArchives: async () => ["/cdn/archive-medium-full/a.zip", "/cdn/archive-medium-full/b.zip"],
        openArchive: async zipPath => {
            opened.add(zipPath)
            if (zipPath.endsWith("a.zip")) {
                return fakeArchive([
                    ["production/medium_upload/6f/3c819ed0275e5f5b47073e58159c54e3e6839e"],
                    ["production/upload/6f/ffffffffffffffffffffffffffffffffffffffff"],
                    ["production/medium_upload/6f/dir", "Directory"],
                ])
            }
            return fakeArchive([
                ["production/medium_upload/00/0190c6a9f104a08bd36ca6be29ad7dd7ff27f7"],
            ])
        },
        readEntry: async (zipPath, entryName) => Buffer.from(`${zipPath}::${entryName}`),
    })
    assert.equal(await index.size(), 2)
    const alkLocation = await index.locate("production/medium_upload/6f/3c819ed0275e5f5b47073e58159c54e3e6839e")
    assert.equal(alkLocation?.zipPath, "/cdn/archive-medium-full/a.zip")
    const bLocation = await index.locate("production/medium_upload/00/0190c6a9f104a08bd36ca6be29ad7dd7ff27f7")
    assert.equal(bLocation?.entryName,
        "production/medium_upload/00/0190c6a9f104a08bd36ca6be29ad7dd7ff27f7")
    assert.equal(await index.locate("production/upload/6f/ffffffffffffffffffffffffffffffffffffffff"), null)
    assert.equal(await index.locate("../../etc/passwd"), null)
    const payload = await index.read("production/medium_upload/00/0190c6a9f104a08bd36ca6be29ad7dd7ff27f7")
    assert.equal(payload.toString("utf8"), "/cdn/archive-medium-full/b.zip::production/medium_upload/00/0190c6a9f104a08bd36ca6be29ad7dd7ff27f7")
    assert.ok(opened.size >= 1)
})

test("MediumArchiveIndex degrades a missing archive directory to an empty index", async () => {
    const index = new MediumArchiveIndex("/cdn/absent", {
        listArchives: async directory => {
            throw Object.assign(new Error(`ENOENT: ${directory}`), { code: "ENOENT" })
        },
    })
    assert.equal(await index.size(), 0)
    assert.equal(await index.locate("production/medium_upload/6f/3c819ed0275e5f5b47073e58159c54e3e6839e"), null)
    assert.equal(await index.read("production/medium_upload/6f/3c819ed0275e5f5b47073e58159c54e3e6839e"), null)
})

test("MediumArchiveIndex.read swallows entry read failures as null", async () => {
    const index = new MediumArchiveIndex("/cdn/archive-medium-full", {
        listArchives: async () => ["/cdn/archive-medium-full/a.zip"],
        openArchive: async () => fakeArchive([
            ["production/medium_upload/6f/3c819ed0275e5f5b47073e58159c54e3e6839e"],
        ]),
        readEntry: async () => {
            throw new Error("zip data corrupted")
        },
    })
    assert.equal(await index.read("production/medium_upload/6f/3c819ed0275e5f5b47073e58159c54e3e6839e"), null)
})

test("isMediumPhysicalPath enforces the shard layout", () => {
    assert.ok(isMediumPhysicalPath("production/medium_upload/6f/3c819ed0275e5f5b47073e58159c54e3e6839e"))
    assert.equal(isMediumPhysicalPath("production/upload/6f/3c819ed0275e5f5b47073e58159c54e3e6839e"), false)
    assert.equal(isMediumPhysicalPath("production/medium_upload/6f/short"), false)
})

// ── 端点：真实 ZIP 夹具 + fastify inject ────────────────────────────────
function writeZip(archivePath, entries) {
    const staging = fs.mkdtempSync(path.join(os.tmpdir(), "avatar-zip-stage-"))
    try {
        for (const [entryName, content] of Object.entries(entries)) {
            const entryPath = path.join(staging, ...entryName.split("/"))
            fs.mkdirSync(path.dirname(entryPath), { recursive: true })
            fs.writeFileSync(entryPath, content)
        }
        fs.mkdirSync(path.dirname(archivePath), { recursive: true })
        const result = spawnSync("zip", ["-q", "-D", archivePath, ...Object.keys(entries)], {
            cwd: staging,
            encoding: "utf8",
        })
        assert.equal(result.status, 0, `zip CLI failed: ${result.stderr}`)
    } finally {
        fs.rmSync(staging, { force: true, recursive: true })
    }
}

function characterTableRepository(tables) {
    return {
        info: () => ({ source: "test", assetVersion: "test" }),
        table: name => {
            if (!Object.prototype.hasOwnProperty.call(tables, name)) {
                throw new Error(`missing test content table: ${name}`)
            }
            return tables[name]
        },
    }
}

const CHARACTER_TABLE = {
    // col0 = asset string_id（内容快照 cdndata/character.json 第 0 列）
    "1": [["alk", "1", "4", "0", "Human"]],
    "700001": [["devil_leader_assist", "1", "2", "5", "Human"]],
    "700010": [["alk_shoutabattle", "1", "4", "0", "Human"]],
}

const CHARACTER_TABLES = { "cdndata/character.json": CHARACTER_TABLE }

const ALK_EVOLVE_0 = "production/medium_upload/6f/3c819ed0275e5f5b47073e58159c54e3e6839e"
const ALK_EVOLVE_1 = `production/medium_upload/${hashedAssetPath(characterFullShotPath("alk", 1))}`

async function buildApp({ cdnRoot, tables = CHARACTER_TABLES }) {
    const fastify = Fastify()
    await fastify.register(contentRoutes, {
        prefix: "/content",
        getCdnRoot: cdnRoot === null ? () => null : () => cdnRoot,
        getRepository: () => characterTableRepository(tables),
        assetProviderDir: fs.mkdtempSync(path.join(os.tmpdir(), "avatar-assets-")),
    })
    return fastify
}

test("character_avatar serves archive PNG with a patched signature and day cache", async () => {
    const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "avatar-cdn-"))
    try {
        const archiveDir = path.join(sandbox, "archive-medium-full")
        writeZip(path.join(archiveDir, "pinball-1.4.0-71-ec674b95.zip"), {
            [ALK_EVOLVE_0]: storedMediumPng(),
            [ALK_EVOLVE_1]: storedMediumPng(),
        })
        const app = await buildApp({ cdnRoot: sandbox })
        try {
            const response = await app.inject({ method: "GET", url: "/content/character_avatar/1" })
            assert.equal(response.statusCode, 200)
            assert.equal(response.headers["content-type"], "image/png")
            assert.equal(response.headers["cache-control"], "public, max-age=86400")
            assert.deepEqual([...response.rawPayload.subarray(0, 8)],
                [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])

            const evolveOne = await app.inject({
                method: "GET",
                url: "/content/character_avatar/1?evolve=1",
            })
            assert.equal(evolveOne.statusCode, 200)
            assert.equal(evolveOne.headers["content-type"], "image/png")

            // 复审A 高-2 回归: 缓存命中(第二次请求)字节必须与首次一致 (修补后签名, 不回落原始字节)
            const repeat = await app.inject({ method: "GET", url: "/content/character_avatar/1" })
            assert.equal(repeat.statusCode, 200)
            assert.deepEqual(repeat.rawPayload, response.rawPayload, "缓存命中与首次响应字节一致")
        } finally {
            await app.close()
        }
    } finally {
        fs.rmSync(sandbox, { force: true, recursive: true })
    }
})

test("character_avatar returns 404 (never 500) for missing content paths", async () => {
    const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "avatar-cdn-"))
    try {
        // 归档目录存在但不含助手角色立绘（700001 devil_leader_assist 无 full_shot）
        const archiveDir = path.join(sandbox, "archive-medium-full")
        writeZip(path.join(archiveDir, "pinball-1.4.0-71-ec674b95.zip"), {
            [ALK_EVOLVE_0]: storedMediumPng(),
        })
        const app = await buildApp({ cdnRoot: sandbox })
        try {
            const helper = await app.inject({ method: "GET", url: "/content/character_avatar/700001" })
            assert.equal(helper.statusCode, 404)

            const unknown = await app.inject({ method: "GET", url: "/content/character_avatar/23" })
            assert.equal(unknown.statusCode, 404)

            const malformed = await app.inject({ method: "GET", url: "/content/character_avatar/abc" })
            assert.equal(malformed.statusCode, 404)
        } finally {
            await app.close()
        }
    } finally {
        fs.rmSync(sandbox, { force: true, recursive: true })
    }
})

test("character_avatar rejects an out-of-domain evolve parameter", async () => {
    const app = await buildApp({ cdnRoot: "/nonexistent-cdn" })
    try {
        const response = await app.inject({ method: "GET", url: "/content/character_avatar/1?evolve=2" })
        assert.equal(response.statusCode, 400)
    } finally {
        await app.close()
    }
})

test("character_avatar degrades an absent archive directory to 404", async () => {
    const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "avatar-cdn-empty-"))
    try {
        const app = await buildApp({ cdnRoot: sandbox })
        try {
            const response = await app.inject({ method: "GET", url: "/content/character_avatar/1" })
            assert.equal(response.statusCode, 404)
        } finally {
            await app.close()
        }
    } finally {
        fs.rmSync(sandbox, { force: true, recursive: true })
    }
})

test("character_avatar degrades a disabled CDN root to 404", async () => {
    const app = await buildApp({ cdnRoot: null })
    try {
        const response = await app.inject({ method: "GET", url: "/content/character_avatar/1" })
        assert.equal(response.statusCode, 404)
    } finally {
        await app.close()
    }
})
