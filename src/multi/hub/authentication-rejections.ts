export type AuthenticationRejectionReason = "malformed" | "unknown" | "revoked"

export type AuthenticationRejection =
    | { readonly reason: "malformed" | "unknown" }
    | { readonly reason: "revoked"; readonly credentialId: string }

export interface AuthenticationRejectionEvent {
    readonly timestamp: number
    readonly reason: AuthenticationRejectionReason
    readonly credentialId?: string
}

export type ClientAuthenticationState = "authentication_rejected" | null

const MAX_AUTHENTICATION_REJECTIONS = 32

export class AuthenticationRejectionBuffer {
    private readonly events: AuthenticationRejectionEvent[] = []

    constructor(private readonly now: () => number = Date.now) {}

    record(rejection: AuthenticationRejection): void {
        const timestamp = this.now()
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
