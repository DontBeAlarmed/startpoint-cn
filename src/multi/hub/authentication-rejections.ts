export type AuthenticationRejectionReason = "malformed" | "unknown" | "revoked"

export type AuthenticationRejection =
    | { readonly reason: "malformed" | "unknown" }
    | { readonly reason: "revoked"; readonly credentialId: string }

interface AuthenticationRejectionEventBase {
    readonly timestamp: string
}

export type AuthenticationRejectionEvent =
    | (AuthenticationRejectionEventBase & {
        readonly reason: "malformed" | "unknown"
        readonly credentialId?: never
    })
    | (AuthenticationRejectionEventBase & {
        readonly reason: "revoked"
        readonly credentialId: string
    })

export type ClientAuthenticationState = "authentication_rejected" | null

export const MAX_AUTHENTICATION_REJECTIONS = 32

export class AuthenticationRejectionBuffer {
    private readonly events: AuthenticationRejectionEvent[] = []

    constructor(private readonly now: () => number = Date.now) {}

    record(rejection: AuthenticationRejection): void {
        const timestamp = new Date(this.now()).toISOString()
        const event: AuthenticationRejectionEvent = rejection.reason === "revoked"
            ? Object.freeze({
                timestamp,
                reason: rejection.reason,
                credentialId: rejection.credentialId,
            })
            : Object.freeze({ timestamp, reason: rejection.reason })
        this.events.push(event)
        if (this.events.length > MAX_AUTHENTICATION_REJECTIONS) this.events.shift()
    }

    list(): readonly AuthenticationRejectionEvent[] {
        return Object.freeze([...this.events])
    }
}
