import { FastifyPluginAsync } from "fastify";

import {
    ADMIN_SESSION_COOKIE,
    AdminAuthConfig,
    adminTokenMatches,
    authenticateAdminRequest,
    createAdminSession,
    isSameOriginRequest,
} from "../../lib/admin-auth";


interface AdminAuthRouteOptions {
    config: AdminAuthConfig;
}

interface FailureBucket {
    count: number;
    resetAt: number;
}


const LOGIN_FAILURE_LIMIT = 5;
const LOGIN_WINDOW_MS = 10 * 60 * 1000;
const LOGIN_MAX_BUCKETS = 1024;


export class LoginFailureLimiter {
    private readonly buckets = new Map<string, FailureBucket>();

    constructor(
        private readonly limit: number = LOGIN_FAILURE_LIMIT,
        private readonly windowMs: number = LOGIN_WINDOW_MS,
        private readonly maxBuckets: number = LOGIN_MAX_BUCKETS,
    ) {
        if (!Number.isSafeInteger(limit) || limit < 1) throw new Error("limit must be positive");
        if (!Number.isSafeInteger(windowMs) || windowMs < 1) throw new Error("windowMs must be positive");
        if (!Number.isSafeInteger(maxBuckets) || maxBuckets < 1) {
            throw new Error("maxBuckets must be positive");
        }
    }

    get size(): number {
        return this.buckets.size;
    }

    private activeBucket(ip: string, now: number): FailureBucket | null {
        const current = this.buckets.get(ip);
        if (current && current.resetAt > now) return current;
        if (current) this.buckets.delete(ip);
        return null;
    }

    private pruneExpired(now: number): void {
        for (const [ip, current] of this.buckets) {
            if (current.resetAt <= now) this.buckets.delete(ip);
        }
    }

    isLimited(ip: string, now: number): boolean {
        return (this.activeBucket(ip, now)?.count ?? 0) >= this.limit;
    }

    recordFailure(ip: string, now: number): void {
        const current = this.activeBucket(ip, now);
        if (current) {
            current.count += 1;
            return;
        }
        this.pruneExpired(now);
        while (this.buckets.size >= this.maxBuckets) {
            const oldest = this.buckets.keys().next().value as string | undefined;
            if (oldest === undefined) break;
            this.buckets.delete(oldest);
        }
        this.buckets.set(ip, { count: 1, resetAt: now + this.windowMs });
    }

    clear(ip: string): void {
        this.buckets.delete(ip);
    }
}


function sessionCookie(value: string, config: AdminAuthConfig, maxAgeSeconds: number): string {
    const attributes = [
        `${ADMIN_SESSION_COOKIE}=${value}`,
        `Max-Age=${maxAgeSeconds}`,
        "Path=/",
        "HttpOnly",
        "SameSite=Strict",
    ];
    if (config.cookieSecure) attributes.push("Secure");
    return attributes.join("; ");
}


const routes: FastifyPluginAsync<AdminAuthRouteOptions> = async (fastify, options) => {
    const { config } = options;
    const failures = new LoginFailureLimiter();

    fastify.post<{ Body: { token?: unknown } }>("/login", async (request, reply) => {
        reply.header("cache-control", "no-store");
        if (config.mode === "insecure-loopback") return reply.send({ ok: true });

        const now = Date.now();
        if (failures.isLimited(request.ip, now)) {
            return reply.status(429).send({ error: "too_many_attempts" });
        }

        const candidate = request.body && typeof request.body.token === "string"
            ? request.body.token
            : "";
        if (config.token === null || !adminTokenMatches(candidate, config.token)) {
            failures.recordFailure(request.ip, now);
            return reply.status(401).send({ error: "unauthorized" });
        }

        failures.clear(request.ip);
        const session = createAdminSession(config.token, now, config.sessionTtlMs);
        reply.header(
            "set-cookie",
            sessionCookie(session, config, Math.floor(config.sessionTtlMs / 1000)),
        );
        return reply.send({ ok: true });
    });

    fastify.get("/session", async (request, reply) => {
        reply.header("cache-control", "no-store");
        return reply.send({
            authenticated: authenticateAdminRequest(request, config) !== null,
            mode: config.mode,
        });
    });

    fastify.post("/logout", async (request, reply) => {
        reply.header("cache-control", "no-store");
        const credential = authenticateAdminRequest(request, config);
        if (credential === null) return reply.status(401).send({ error: "unauthorized" });
        if (credential === "cookie" && !isSameOriginRequest(request)) {
            return reply.status(403).send({ error: "forbidden_origin" });
        }
        reply.header("set-cookie", sessionCookie("", config, 0));
        return reply.send({ ok: true });
    });
};


export default routes;
