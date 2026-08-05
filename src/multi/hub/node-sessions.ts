import { randomBytes, timingSafeEqual } from "node:crypto"

import { MULTI_PROTOCOL_VERSION, type NodeSessionId } from "../coordinator/contracts"

const NODE_SESSION_ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/
const SESSION_CREDENTIAL_PATTERN = /^[A-Za-z0-9_-]{43}$/

export interface NodeSession {
    readonly nodeSessionId: NodeSessionId
    readonly credentialId: string
    readonly protocolVersion: typeof MULTI_PROTOCOL_VERSION
    readonly expiresAt: number
    readonly lastSeen: number
}

export interface RegisteredNodeSession {
    readonly nodeSessionId: NodeSessionId
    readonly sessionCredential: string
    readonly expiresAt: number
}

export interface NodeSessionRegistryOptions {
    readonly now?: () => number
    readonly sessionTtlMs?: number
    readonly generateId?: () => string
    readonly isCredentialEnabled: (credentialId: string) => boolean
    readonly onInvalidated?: (nodeSessionId: NodeSessionId) => void
}

interface StoredNodeSession extends NodeSession {
    readonly sessionCredential: string
}

export class NodeSessionRegistry {
    private readonly sessions = new Map<NodeSessionId, StoredNodeSession>()
    private readonly now: () => number
    private readonly sessionTtlMs: number
    private readonly generateId: () => string
    private readonly isCredentialEnabled: (credentialId: string) => boolean
    private readonly onInvalidated: (nodeSessionId: NodeSessionId) => void

    constructor(options: NodeSessionRegistryOptions) {
        this.now = options.now ?? Date.now
        this.sessionTtlMs = options.sessionTtlMs ?? 5 * 60_000
        this.generateId = options.generateId ?? (() => randomBytes(32).toString("base64url"))
        this.isCredentialEnabled = options.isCredentialEnabled
        this.onInvalidated = options.onInvalidated ?? (() => {})
        if (!Number.isSafeInteger(this.sessionTtlMs) || this.sessionTtlMs <= 0) {
            throw new TypeError("sessionTtlMs must be a positive safe integer")
        }
    }

    register(
        credentialId: string,
        protocolVersion: typeof MULTI_PROTOCOL_VERSION,
    ): RegisteredNodeSession {
        if (!this.isCredentialEnabled(credentialId)
            || protocolVersion !== MULTI_PROTOCOL_VERSION) {
            throw new TypeError("invalid node registration")
        }
        const nodeSessionId = this.generateId() as NodeSessionId
        const sessionCredential = this.generateId()
        if (!NODE_SESSION_ID_PATTERN.test(nodeSessionId)
            || !SESSION_CREDENTIAL_PATTERN.test(sessionCredential)
            || this.sessions.has(nodeSessionId)) {
            throw new TypeError("invalid generated node session")
        }
        const now = this.now()
        const stored: StoredNodeSession = Object.freeze({
            nodeSessionId,
            sessionCredential,
            credentialId,
            protocolVersion,
            expiresAt: now + this.sessionTtlMs,
            lastSeen: now,
        })
        this.sessions.set(nodeSessionId, stored)
        return Object.freeze({ nodeSessionId, sessionCredential, expiresAt: stored.expiresAt })
    }

    authenticate(nodeSessionId: string, sessionCredential: string): NodeSession | null {
        if (!NODE_SESSION_ID_PATTERN.test(nodeSessionId)
            || !SESSION_CREDENTIAL_PATTERN.test(sessionCredential)) return null
        const stored = this.sessions.get(nodeSessionId as NodeSessionId)
        if (!stored || !this.validate(stored)) return null
        const actual = Buffer.from(stored.sessionCredential, "ascii")
        const candidate = Buffer.from(sessionCredential, "ascii")
        if (actual.length !== candidate.length || !timingSafeEqual(actual, candidate)) return null
        return this.touch(stored)
    }

    isValid(nodeSessionId: string): boolean {
        const stored = this.sessions.get(nodeSessionId as NodeSessionId)
        if (!stored || !this.validate(stored)) return false
        this.touch(stored)
        return true
    }

    has(nodeSessionId: string): boolean {
        return this.sessions.has(nodeSessionId as NodeSessionId)
    }

    activeCount(): number {
        return this.sessions.size
    }

    clear(): void {
        for (const nodeSessionId of [...this.sessions.keys()]) this.invalidate(nodeSessionId)
    }

    private validate(stored: StoredNodeSession): boolean {
        if (stored.expiresAt <= this.now()
            || !this.isCredentialEnabled(stored.credentialId)) {
            this.invalidate(stored.nodeSessionId)
            return false
        }
        return true
    }

    private touch(stored: StoredNodeSession): NodeSession {
        const touched: StoredNodeSession = Object.freeze({ ...stored, lastSeen: this.now() })
        this.sessions.set(stored.nodeSessionId, touched)
        const { sessionCredential: _secret, ...session } = touched
        return Object.freeze(session)
    }

    private invalidate(nodeSessionId: NodeSessionId): void {
        if (!this.sessions.delete(nodeSessionId)) return
        this.onInvalidated(nodeSessionId)
    }
}
