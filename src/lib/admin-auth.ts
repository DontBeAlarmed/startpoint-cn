import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";


export const ADMIN_SESSION_COOKIE = "wf_admin_session";
export const ADMIN_SESSION_TTL_MS = 8 * 60 * 60 * 1000;

const MANAGEMENT_PREFIXES = [
    "/api/server",
    "/api/player",
    "/api/mail",
    "/api/lookup",
    "/api/seeds",
    "/api/mod-admin",
] as const;
const LEGACY_MUTATING_GETS = new Set(["/api/server/resetTime", "/api/server/time"]);


export type AdminAuthMode = "token" | "insecure-loopback";
export type AdminCredential = "bearer" | "cookie" | "insecure-loopback";

export interface AdminAuthConfig {
    readonly mode: AdminAuthMode;
    readonly token: string | null;
    readonly cookieSecure: boolean;
    readonly sessionTtlMs: number;
}


type Environment = Record<string, string | undefined>;


function envTrue(value: string | undefined): boolean {
    return value?.trim().toLowerCase() === "true";
}


function normalizeHost(host: string): string {
    const normalized = host.trim().toLowerCase();
    if (normalized.startsWith("[") && normalized.endsWith("]")) {
        return normalized.slice(1, -1);
    }
    return normalized;
}


function isLoopbackHost(host: string): boolean {
    const normalized = normalizeHost(host);
    return normalized === "localhost"
        || normalized === "::1"
        || normalized === "0:0:0:0:0:0:0:1"
        || /^127(?:\.[0-9]{1,3}){3}$/.test(normalized);
}


export function loadAdminAuthConfig(env: Environment, listenHost: string): AdminAuthConfig {
    const token = env.CN_ADMIN_TOKEN;
    if (token !== undefined && token !== "") {
        if (Buffer.byteLength(token, "utf8") < 32) {
            throw new Error("CN_ADMIN_TOKEN must contain at least 32 UTF-8 bytes");
        }
        return Object.freeze({
            mode: "token" as const,
            token,
            cookieSecure: envTrue(env.CN_ADMIN_COOKIE_SECURE),
            sessionTtlMs: ADMIN_SESSION_TTL_MS,
        });
    }

    if (!isLoopbackHost(listenHost)) {
        throw new Error("CN_ADMIN_TOKEN is required for non-loopback CN_LISTEN_HOST");
    }
    if (!envTrue(env.CN_ADMIN_ALLOW_INSECURE_LOOPBACK)) {
        throw new Error(
            "Tokenless loopback requires CN_ADMIN_ALLOW_INSECURE_LOOPBACK=true",
        );
    }
    return Object.freeze({
        mode: "insecure-loopback" as const,
        token: null,
        cookieSecure: false,
        sessionTtlMs: ADMIN_SESSION_TTL_MS,
    });
}


export function createAdminSession(token: string, nowMs: number, ttlMs: number): string {
    const payload = Buffer.from(JSON.stringify({
        v: 1,
        exp: nowMs + ttlMs,
        nonce: randomBytes(16).toString("hex"),
    }), "utf8").toString("base64url");
    const signature = createHmac("sha256", token).update(payload).digest("base64url");
    return `${payload}.${signature}`;
}


export function verifyAdminSession(value: string, token: string, nowMs: number): boolean {
    try {
        const parts = value.split(".");
        if (parts.length !== 2 || !parts[0] || !parts[1]) return false;
        const [payload, signature] = parts;
        const expected = createHmac("sha256", token).update(payload).digest();
        const actual = Buffer.from(signature, "base64url");
        if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) return false;
        const decoded: unknown = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
        if (typeof decoded !== "object" || decoded === null || Array.isArray(decoded)) return false;
        const record = decoded as Record<string, unknown>;
        return record.v === 1
            && Number.isSafeInteger(record.exp)
            && (record.exp as number) > nowMs
            && typeof record.nonce === "string"
            && /^[0-9a-f]{32}$/.test(record.nonce);
    } catch {
        return false;
    }
}


export function adminTokenMatches(candidate: string, token: string): boolean {
    const actual = createHash("sha256").update(candidate, "utf8").digest();
    const expected = createHash("sha256").update(token, "utf8").digest();
    return timingSafeEqual(actual, expected);
}


function cookieValue(header: string | undefined, name: string): string | null {
    if (!header) return null;
    let found: string | null = null;
    for (const part of header.split(";")) {
        const separator = part.indexOf("=");
        if (separator < 1) continue;
        const key = part.slice(0, separator).trim();
        if (key !== name) continue;
        if (found !== null) return null;
        found = part.slice(separator + 1).trim();
    }
    return found;
}


function bearerValue(header: string | undefined): string | null {
    if (!header) return null;
    const match = /^Bearer ([^\s]+)$/.exec(header);
    return match?.[1] ?? null;
}


export function authenticateAdminRequest(
    request: FastifyRequest,
    config: AdminAuthConfig,
    nowMs: number = Date.now(),
): AdminCredential | null {
    if (config.mode === "insecure-loopback") return "insecure-loopback";
    const token = config.token;
    if (token === null) return null;

    const authorization = request.headers.authorization;
    if (authorization !== undefined) {
        const candidate = bearerValue(authorization);
        return candidate !== null && adminTokenMatches(candidate, token) ? "bearer" : null;
    }
    const session = cookieValue(request.headers.cookie, ADMIN_SESSION_COOKIE);
    return session !== null && verifyAdminSession(session, token, nowMs) ? "cookie" : null;
}


function decodedPathname(rawUrl: string): string {
    const encoded = rawUrl.split("?", 1)[0];
    try {
        return decodeURIComponent(encoded);
    } catch {
        return encoded;
    }
}


function hasPathPrefix(pathname: string, prefix: string): boolean {
    return pathname === prefix || pathname.startsWith(`${prefix}/`);
}


export function isProtectedAdminPath(rawUrl: string): boolean {
    const pathname = decodedPathname(rawUrl);
    if (hasPathPrefix(pathname, "/api/admin-auth")) return false;
    if (MANAGEMENT_PREFIXES.some(prefix => hasPathPrefix(pathname, prefix))) return true;
    return pathname === "/"
        || pathname === "/seeds"
        || pathname === "/mail"
        || hasPathPrefix(pathname, "/player");
}


export function isSameOriginRequest(request: FastifyRequest): boolean {
    const host = request.headers.host?.trim().toLowerCase();
    const source = request.headers.origin ?? request.headers.referer;
    if (!host || typeof source !== "string") return false;
    try {
        const url = new URL(source);
        return (url.protocol === "http:" || url.protocol === "https:")
            && url.host.toLowerCase() === host;
    } catch {
        return false;
    }
}


function isMutation(method: string): boolean {
    return method !== "GET" && method !== "HEAD" && method !== "OPTIONS";
}


function unauthorized(reply: FastifyReply): FastifyReply {
    reply.header("cache-control", "no-store");
    return reply.status(401).send({ error: "unauthorized" });
}


export function installAdminGuard(fastify: FastifyInstance, config: AdminAuthConfig): void {
    fastify.addHook("onRequest", async (request, reply) => {
        if (!isProtectedAdminPath(request.raw.url ?? request.url)) return;
        const credential = authenticateAdminRequest(request, config);
        if (credential === null) return unauthorized(reply);
        if (credential === "cookie" && isMutation(request.method) && !isSameOriginRequest(request)) {
            reply.header("cache-control", "no-store");
            return reply.status(403).send({ error: "forbidden_origin" });
        }
        const pathname = decodedPathname(request.raw.url ?? request.url);
        if (request.method === "GET" && LEGACY_MUTATING_GETS.has(pathname)) {
            request.log.warn({ method: request.method, route: pathname }, "deprecated mutating admin GET");
        }
    });
}
