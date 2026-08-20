export interface CnSignupIdentityInput {
    readonly appId: string
}

export interface DeviceLoginIdentityInput {
    readonly appId: string
    readonly deviceId: string
    readonly serialNo: string
    readonly whiteKey: string
}

export interface AccountIdentity {
    readonly idpAlias: string
    readonly idpCode: string
    readonly idpId: string
}

/**
 * The authentication protocol may change independently from account storage.
 * Providers only resolve an external identity; routes still own sessions and players.
 */
export interface AccountIdentityProvider {
    resolveCnSignup(input: CnSignupIdentityInput): AccountIdentity
    resolveDeviceLogin(input: DeviceLoginIdentityInput): AccountIdentity
}

export class DeviceCodeAccountIdentityProvider implements AccountIdentityProvider {
    resolveCnSignup(_input: CnSignupIdentityInput): AccountIdentity {
        return {
            idpAlias: "",
            idpCode: "leiting",
            idpId: "",
        }
    }

    resolveDeviceLogin(input: DeviceLoginIdentityInput): AccountIdentity {
        return {
            idpAlias: generateIdpAlias(input.appId, input.deviceId, input.serialNo),
            idpCode: "zd3",
            idpId: input.whiteKey,
        }
    }
}

let accountIdentityProvider: AccountIdentityProvider = new DeviceCodeAccountIdentityProvider()

export function getAccountIdentityProvider(): AccountIdentityProvider {
    return accountIdentityProvider
}

/** Test and embedding seam for a future official/custom account provider. */
export function setAccountIdentityProvider(provider: AccountIdentityProvider): void {
    accountIdentityProvider = provider
}

export function resetAccountIdentityProvider(): void {
    accountIdentityProvider = new DeviceCodeAccountIdentityProvider()
}
import { generateIdpAlias } from "../utils"
