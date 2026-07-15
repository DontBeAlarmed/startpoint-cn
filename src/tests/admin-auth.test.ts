import assert from "node:assert/strict";
import test from "node:test";
import Fastify, { FastifyInstance } from "fastify";

import {
    createAdminSession,
    installAdminGuard,
    loadAdminAuthConfig,
    verifyAdminSession,
} from "../lib/admin-auth";
import adminAuthApiPlugin, { LoginFailureLimiter } from "../routes/web_api/admin-auth";


const TOKEN = "a".repeat(64);


async function guardedApp(): Promise<FastifyInstance> {
    const app = Fastify();
    const config = loadAdminAuthConfig({ CN_ADMIN_TOKEN: TOKEN }, "0.0.0.0");
    installAdminGuard(app, config);
    await app.register(adminAuthApiPlugin, { prefix: "/api/admin-auth", config });
    await app.register(async child => {
        child.get("/api/server/accounts", async () => ({ ok: true }));
        child.post("/api/server/change", async () => ({ ok: true }));
        child.get("/api/player/1/detail", async () => ({ ok: true }));
        child.get("/api/mail/history", async () => ({ ok: true }));
        child.get("/api/lookup/characters", async () => ({ ok: true }));
        child.get("/api/seeds/stats", async () => ({ ok: true }));
        child.get("/api/mod-admin/ping", async () => ({ ok: true }));
        child.get("/api/index.php/game/ping", async () => ({ game: true }));
        child.get("/", async () => "legacy-admin");
    });
    await app.ready();
    return app;
}


function sessionCookie(response: Awaited<ReturnType<FastifyInstance["inject"]>>): string {
    const rawHeader = response.headers["set-cookie"];
    const header = Array.isArray(rawHeader) ? rawHeader[0] : rawHeader;
    assert.equal(typeof header, "string");
    return String(header).split(";", 1)[0];
}


test("LAN binding rejects missing and weak admin tokens", () => {
    assert.throws(() => loadAdminAuthConfig({}, "0.0.0.0"), /CN_ADMIN_TOKEN/);
    assert.throws(
        () => loadAdminAuthConfig({ CN_ADMIN_TOKEN: "too-short" }, "192.168.0.130"),
        /32 UTF-8 bytes/,
    );
});


test("tokenless loopback requires an explicit insecure opt-in", () => {
    assert.throws(() => loadAdminAuthConfig({}, "127.0.0.1"), /CN_ADMIN_ALLOW_INSECURE_LOOPBACK/);
    const config = loadAdminAuthConfig(
        { CN_ADMIN_ALLOW_INSECURE_LOOPBACK: "true" },
        "127.0.0.1",
    );
    assert.equal(config.mode, "insecure-loopback");
});


test("signed sessions reject tamper and expiry without throwing", () => {
    const session = createAdminSession(TOKEN, 1_000, 5_000);
    assert.equal(verifyAdminSession(session, TOKEN, 5_999), true);
    assert.equal(verifyAdminSession(session, TOKEN, 6_000), false);
    assert.equal(verifyAdminSession(`${session}x`, TOKEN, 2_000), false);
    assert.equal(verifyAdminSession("not.a.valid.session", TOKEN, 2_000), false);
    assert.equal(verifyAdminSession("%%%.$$$", TOKEN, 2_000), false);
});


test("management routes require auth while game routes remain outside the guard", async () => {
    const app = await guardedApp();
    try {
        for (const url of [
            "/api/server/accounts",
            "/api/player/1/detail",
            "/api/mail/history",
            "/api/lookup/characters",
            "/api/seeds/stats",
            "/api/mod-admin/ping",
        ]) {
            assert.equal((await app.inject({ method: "GET", url })).statusCode, 401, url);
        }
        assert.equal((await app.inject({ method: "GET", url: "/" })).statusCode, 401);
        assert.equal(
            (await app.inject({ method: "GET", url: "/api/index.php/game/ping" })).statusCode,
            200,
        );
        assert.equal(
            (await app.inject({
                method: "GET",
                url: "/api/server/accounts",
                headers: { authorization: `Bearer ${TOKEN}` },
            })).statusCode,
            200,
        );
    } finally {
        await app.close();
    }
});


test("login issues a strict HttpOnly cookie and session recognizes it", async () => {
    const app = await guardedApp();
    try {
        const login = await app.inject({
            method: "POST",
            url: "/api/admin-auth/login",
            payload: { token: TOKEN },
        });
        assert.equal(login.statusCode, 200);
        const setCookie = String(login.headers["set-cookie"] ?? "");
        assert.match(setCookie, /^wf_admin_session=[A-Za-z0-9._-]+;/);
        assert.match(setCookie, /; HttpOnly(?:;|$)/i);
        assert.match(setCookie, /; SameSite=Strict(?:;|$)/i);
        assert.match(setCookie, /; Path=\/(?:;|$)/i);
        assert.match(setCookie, /; Max-Age=28800(?:;|$)/i);
        assert.ok(!setCookie.includes(TOKEN));

        const cookie = sessionCookie(login);
        const session = await app.inject({
            method: "GET",
            url: "/api/admin-auth/session",
            headers: { cookie },
        });
        assert.equal(session.statusCode, 200);
        assert.equal(session.json().authenticated, true);
        assert.equal(
            (await app.inject({
                method: "GET",
                url: "/api/server/accounts",
                headers: { cookie },
            })).statusCode,
            200,
        );
    } finally {
        await app.close();
    }
});


test("login cookie adds Secure only for explicit HTTPS configuration", async () => {
    const app = Fastify();
    const config = loadAdminAuthConfig({
        CN_ADMIN_TOKEN: TOKEN,
        CN_ADMIN_COOKIE_SECURE: "true",
    }, "0.0.0.0");
    await app.register(adminAuthApiPlugin, { prefix: "/api/admin-auth", config });
    try {
        const login = await app.inject({
            method: "POST",
            url: "/api/admin-auth/login",
            payload: { token: TOKEN },
        });
        assert.equal(login.statusCode, 200);
        assert.match(String(login.headers["set-cookie"] ?? ""), /; Secure(?:;|$)/i);
    } finally {
        await app.close();
    }
});


test("cookie mutations require same-origin while bearer automation does not", async () => {
    const app = await guardedApp();
    try {
        const login = await app.inject({
            method: "POST",
            url: "/api/admin-auth/login",
            payload: { token: TOKEN },
        });
        const cookie = sessionCookie(login);
        assert.equal((await app.inject({
            method: "POST",
            url: "/api/server/change",
            headers: { cookie, host: "admin.local" },
        })).statusCode, 403);
        assert.equal((await app.inject({
            method: "POST",
            url: "/api/server/change",
            headers: { cookie, host: "admin.local", origin: "https://evil.invalid" },
        })).statusCode, 403);
        assert.equal((await app.inject({
            method: "POST",
            url: "/api/server/change",
            headers: { cookie, host: "admin.local", origin: "http://admin.local" },
        })).statusCode, 200);
        assert.equal((await app.inject({
            method: "POST",
            url: "/api/server/change",
            headers: { authorization: `Bearer ${TOKEN}`, origin: "https://evil.invalid" },
        })).statusCode, 200);
    } finally {
        await app.close();
    }
});


test("malformed cookies are unauthorized rather than internal errors", async () => {
    const app = await guardedApp();
    try {
        for (const cookie of [
            "wf_admin_session=%%%.$$$",
            "wf_admin_session=one; wf_admin_session=two",
            "wf_admin_session",
        ]) {
            const response = await app.inject({
                method: "GET",
                url: "/api/server/accounts",
                headers: { cookie },
            });
            assert.equal(response.statusCode, 401, cookie);
        }
    } finally {
        await app.close();
    }
});


test("login failures are rate limited with one generic response", async () => {
    const app = await guardedApp();
    try {
        for (let attempt = 0; attempt < 5; attempt += 1) {
            const response = await app.inject({
                method: "POST",
                url: "/api/admin-auth/login",
                payload: { token: `wrong-${attempt}` },
            });
            assert.equal(response.statusCode, 401);
            assert.deepEqual(response.json(), { error: "unauthorized" });
        }
        const limited = await app.inject({
            method: "POST",
            url: "/api/admin-auth/login",
            payload: {},
        });
        assert.equal(limited.statusCode, 429);
        assert.deepEqual(limited.json(), { error: "too_many_attempts" });
    } finally {
        await app.close();
    }
});


test("login failure tracking stays bounded and expires old buckets", () => {
    const limiter = new LoginFailureLimiter(2, 1_000, 2);
    limiter.recordFailure("198.51.100.1", 100);
    limiter.recordFailure("198.51.100.2", 200);
    limiter.recordFailure("198.51.100.3", 300);
    assert.equal(limiter.size, 2);
    assert.equal(limiter.isLimited("198.51.100.1", 300), false);
    assert.equal(limiter.isLimited("198.51.100.2", 300), false);
    limiter.recordFailure("198.51.100.2", 300);
    assert.equal(limiter.isLimited("198.51.100.2", 300), true);
    assert.equal(limiter.isLimited("198.51.100.2", 1_300), false);
    assert.equal(limiter.size, 1);
});


test("logout clears the session cookie", async () => {
    const app = await guardedApp();
    try {
        const login = await app.inject({
            method: "POST",
            url: "/api/admin-auth/login",
            payload: { token: TOKEN },
        });
        const logout = await app.inject({
            method: "POST",
            url: "/api/admin-auth/logout",
            headers: {
                cookie: sessionCookie(login),
                host: "admin.local",
                origin: "http://admin.local",
            },
        });
        assert.equal(logout.statusCode, 200);
        assert.match(String(logout.headers["set-cookie"] ?? ""), /Max-Age=0/);
    } finally {
        await app.close();
    }
});
