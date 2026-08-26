const assert = require("assert")
const fs = require("fs")
const path = require("path")

const app = fs.readFileSync("admin/src/App.tsx", "utf8")
const accounts = fs.readFileSync("admin/src/pages/Accounts.tsx", "utf8")
const playerDetail = fs.readFileSync("admin/src/pages/PlayerDetail.tsx", "utf8")
const serverApi = fs.readFileSync("src/routes/web_api/server.ts", "utf8")
const adminPlayerDomain = fs.readFileSync("src/data/domains/admin-player.ts", "utf8")
const accountTypes = fs.readFileSync("admin/src/pages/accounts/types.ts", "utf8")
const mobileViewPath = path.join("admin/src/pages/accounts/AccountsMobileView.tsx")
assert.equal(fs.existsSync(mobileViewPath), true, "移动端账号页应拆分为独立纵向列表组件")
const mobileView = fs.readFileSync(mobileViewPath, "utf8")

assert.match(app, /label: "账号 \/ 存档"/)
assert.doesNotMatch(app, /label: "存档管理"/)
assert.doesNotMatch(app, /path="\/saves"/)

assert.match(accounts, /title="账号管理"/)
assert.doesNotMatch(accounts, /全部玩家/)
assert.match(accounts, /title="账号 \/ 存档"/)
assert.match(accountTypes, /devices: DeviceBinding\[\]/)
assert.match(accounts, /\/api\/server\/device\/rename/)
assert.match(accounts, /绑定设备/)
assert.match(accounts, /Grid/)
assert.match(accounts, /useBreakpoint/)
assert.match(accounts, /isMobile/)
assert.match(accounts, /AccountsMobileView/)
assert.match(accounts, /className="admin-edit-compact"[\s\S]*?onClick=\{event => event\.stopPropagation\(\)\}[\s\S]*?onKeyDown=\{event => event\.stopPropagation\(\)\}/)
assert.doesNotMatch(accounts, /role: "button"/)
assert.match(mobileView, /admin-account-mobile-list/)
assert.match(mobileView, /返回账号列表/)
assert.match(mobileView, /编辑存档/)
assert.match(mobileView, /player\.rank/)
assert.match(mobileView, /className="admin-mobile-inline-editor"[\s\S]*?onKeyDown=\{event => event\.stopPropagation\(\)\}/)
assert.doesNotMatch(mobileView, /role="button"/)
assert.doesNotMatch(accounts, /row\.degreeId \|\| 1/)

const accountMutationCount = (accounts.match(/= useMutation\(\{/g) || []).length
const accountMutationErrorCount = (accounts.match(/onError:/g) || []).length
assert.equal(accountMutationErrorCount, accountMutationCount, "账号页所有写操作都必须显示失败信息")

assert.doesNotMatch(playerDetail, /玩家摘要/)
assert.doesNotMatch(playerDetail, /时间设置/)
assert.doesNotMatch(playerDetail, /添加角色/)
assert.doesNotMatch(playerDetail, /timeOffset/)
assert.match(playerDetail, /clearedCharacters/)

const playerMutationCount = (playerDetail.match(/= useMutation\(\{/g) || []).length
const playerMutationErrorCount = (playerDetail.match(/onError:/g) || []).length
assert.equal(playerMutationErrorCount, playerMutationCount, "玩家页所有写操作都必须显示失败信息")

assert.match(serverApi, /playerIds\.includes\(savedDefaultPid\)/)
assert.match(serverApi, /saveAccountDefaultPlayer\(accountId, remainingPlayerIds\[0\]\)/)
assert.doesNotMatch(serverApi, /selectAccount/)
assert.match(adminPlayerDomain, /rank_point/)
assert.match(adminPlayerDomain, /rankPoint/)
assert.match(serverApi, /rank: getRankDegree\(player\.rankPoint\)/)

console.log("admin-account-save-ui tests passed")
