"use strict"

const assert = require("node:assert/strict")

require("ts-node/register/transpile-only")

const {
    DeviceCodeAccountIdentityProvider,
    getAccountIdentityProvider,
    resetAccountIdentityProvider,
    setAccountIdentityProvider,
} = require("../src/lib/account-identity-provider")

const provider = new DeviceCodeAccountIdentityProvider()
assert.deepEqual(provider.resolveCnSignup({ appId: "wf_cn" }), {
    idpAlias: "",
    idpCode: "leiting",
    idpId: "",
})
assert.deepEqual(provider.resolveDeviceLogin({
    appId: "wf_cn",
    deviceId: "device-1",
    serialNo: "serial-1",
    whiteKey: "white-key",
}), {
    idpAlias: "wf_cn:device-1:serial-1",
    idpCode: "zd3",
    idpId: "white-key",
})

const customProvider = {
    resolveCnSignup: () => ({ idpAlias: "custom", idpCode: "custom", idpId: "account" }),
    resolveDeviceLogin: () => ({ idpAlias: "custom", idpCode: "custom", idpId: "account" }),
}
setAccountIdentityProvider(customProvider)
assert.equal(getAccountIdentityProvider(), customProvider)
resetAccountIdentityProvider()
assert.ok(getAccountIdentityProvider() instanceof DeviceCodeAccountIdentityProvider)

console.log("account identity provider tests passed")
