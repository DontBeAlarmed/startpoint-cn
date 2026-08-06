import {
    resolveMultiHubCredentialsPath,
    type RuntimeEnvironment,
} from "../../runtime/config"
import {
    MultiHubCredentialStore,
} from "../hub/credential-store"
import type {
    MultiManagementDependencies,
    MultiManagementMode,
} from "./types"

export interface MultiManagementCredentialProviderOptions {
    readonly mode: MultiManagementMode
    readonly env: RuntimeEnvironment
    readonly projectRoot: string
}

function unavailableCredentialOperation(): never {
    throw new Error("client credential provider is unavailable")
}

const CLIENT_CREDENTIALS: MultiManagementDependencies["credentials"] = Object.freeze({
    create: unavailableCredentialOperation,
    list: unavailableCredentialOperation,
    revoke: unavailableCredentialOperation,
})

export function createMultiManagementCredentialProvider({
    mode,
    env,
    projectRoot,
}: MultiManagementCredentialProviderOptions): MultiManagementDependencies["credentials"] {
    if (mode === "client") return CLIENT_CREDENTIALS
    return new MultiHubCredentialStore({
        credentialsPath: resolveMultiHubCredentialsPath(env, projectRoot),
    })
}
