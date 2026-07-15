import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import Fastify, { FastifyInstance } from "fastify";

import { resolveSafeLeaf } from "../lib/safe-root-file";
import { patchFileRoutes } from "../routes/cn/patch-files";


interface PatchFixture {
    app: FastifyInstance;
    root: string;
    activeRoot: string;
    productionRoot: string;
    outsideRoot: string;
    close(): Promise<void>;
}


async function fixture(): Promise<PatchFixture> {
    const root = mkdtempSync(path.join(os.tmpdir(), "wf-patch-route-"));
    const activeRoot = path.join(root, "active");
    const productionRoot = path.join(root, "production", "upload");
    const outsideRoot = path.join(root, "outside");
    mkdirSync(activeRoot, { recursive: true });
    mkdirSync(productionRoot, { recursive: true });
    mkdirSync(outsideRoot, { recursive: true });
    writeFileSync(path.join(activeRoot, "pinball-safe.zip"), "fixture-zip");
    writeFileSync(path.join(outsideRoot, "package.json"), "outside-secret");

    const app = Fastify();
    await app.register(patchFileRoutes, { activeRoot, productionRoot });
    await app.ready();
    return {
        app,
        root,
        activeRoot,
        productionRoot,
        outsideRoot,
        async close(): Promise<void> {
            await app.close();
            rmSync(root, { recursive: true, force: true });
        },
    };
}


test("active patch route rejects encoded path escapes", async () => {
    const current = await fixture();
    try {
        const attacks = [
            "%2e%2e%2foutside%2fpackage.json",
            "%252e%252e%252foutside%252fpackage.json",
            "..%5coutside%5cpackage.json",
            "C:%5cWindows%5cwin.ini.zip",
            "%5c%5cserver%5cshare%5cx.zip",
            ".",
            "..",
            "not-a-zip.txt",
        ];
        for (const leaf of attacks) {
            const response = await current.app.inject({
                method: "GET",
                url: `/patch/cn/asset-patch/active/${leaf}`,
            });
            assert.equal(response.statusCode, 404, leaf);
            assert.ok(!response.body.includes(current.root), leaf);
            assert.ok(!response.body.includes("outside-secret"), leaf);
        }
    } finally {
        await current.close();
    }
});


test("active patch route streams one allowed zip leaf", async () => {
    const current = await fixture();
    try {
        const response = await current.app.inject({
            method: "GET",
            url: "/patch/cn/asset-patch/active/pinball-safe.zip",
        });
        assert.equal(response.statusCode, 200);
        assert.equal(response.body, "fixture-zip");
        assert.match(String(response.headers["content-type"] ?? ""), /^application\/zip\b/);
    } finally {
        await current.close();
    }
});


test("production route accepts only a two-hex prefix and thirty-eight-hex remainder", async () => {
    const current = await fixture();
    try {
        const prefix = "af";
        const hash = "1".repeat(38);
        const directory = path.join(current.productionRoot, prefix);
        mkdirSync(directory);
        writeFileSync(path.join(directory, hash), "production-patch");

        const allowed = await current.app.inject({
            method: "GET",
            url: `/patch/cn/dummy/download/production/upload/${prefix}/${hash}`,
        });
        assert.equal(allowed.statusCode, 200);
        assert.equal(allowed.body, "production-patch");
        assert.match(String(allowed.headers["content-type"] ?? ""), /^application\/octet-stream\b/);

        for (const url of [
            `/patch/cn/dummy/download/production/upload/zz/${hash}`,
            `/patch/cn/dummy/download/production/upload/a/${hash}`,
            `/patch/cn/dummy/download/production/upload/${prefix}/${"1".repeat(37)}`,
            `/patch/cn/dummy/download/production/upload/${prefix}/${"1".repeat(40)}`,
            `/patch/cn/dummy/download/production/upload/${prefix}/${"g".repeat(38)}`,
            `/patch/cn/dummy/download/production/upload/%2e%2e/${hash}`,
        ]) {
            assert.equal((await current.app.inject({ method: "GET", url })).statusCode, 404, url);
        }
    } finally {
        await current.close();
    }
});


test("production route rejects a junction that leaves its allowed root", async () => {
    const current = await fixture();
    try {
        const hash = "a".repeat(38);
        const externalPrefix = path.join(current.outsideRoot, "prefix");
        mkdirSync(externalPrefix);
        writeFileSync(path.join(externalPrefix, hash), "junction-secret");
        symlinkSync(externalPrefix, path.join(current.productionRoot, "aa"), "junction");

        const response = await current.app.inject({
            method: "GET",
            url: `/patch/cn/dummy/download/production/upload/aa/${hash}`,
        });
        assert.equal(response.statusCode, 404);
        assert.equal(response.body, "Not Found");
    } finally {
        await current.close();
    }
});


test("safe leaf resolution rejects missing roots and non-files without throwing", () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "wf-safe-leaf-"));
    try {
        mkdirSync(path.join(root, "directory.zip"));
        assert.equal(resolveSafeLeaf(path.join(root, "missing"), "file.zip", /^[\w.-]+\.zip$/), null);
        assert.equal(resolveSafeLeaf(root, "directory.zip", /^[\w.-]+\.zip$/), null);
    } finally {
        rmSync(root, { recursive: true, force: true });
    }
});
