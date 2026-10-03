const assert = require("assert")
const fs = require("fs")
const path = require("path")

const app = fs.readFileSync("admin/src/App.tsx", "utf8")
const accounts = fs.readFileSync("admin/src/pages/Accounts.tsx", "utf8")
const playerDetail = fs.readFileSync("admin/src/pages/PlayerDetail.tsx", "utf8")
const serverApi = fs.readFileSync("src/routes/web_api/server.ts", "utf8")
const adminPlayerDomain = fs.readFileSync("src/data/domains/admin-player.ts", "utf8")
const accountTypes = fs.readFileSync("admin/src/pages/accounts/types.ts", "utf8")
const profileFavorite = fs.readFileSync("src/lib/profileFavorite.ts", "utf8")
const favoriteAvatarPath = path.join("admin/src/pages/accounts/FavoriteAvatar.tsx")
assert.equal(fs.existsSync(favoriteAvatarPath), true, "存档子卡喜爱角色头像应为共享组件")
const favoriteAvatar = fs.readFileSync(favoriteAvatarPath, "utf8")
const mobileViewPath = path.join("admin/src/pages/accounts/AccountsMobileView.tsx")
assert.equal(fs.existsSync(mobileViewPath), true, "移动端账号页应拆分为独立纵向列表组件")
const mobileView = fs.readFileSync(mobileViewPath, "utf8")
const accountsCss = fs.readFileSync("admin/src/styles/pages/accounts.css", "utf8")

assert.match(app, /label: "账号 \/ 存档"/)
assert.doesNotMatch(app, /label: "存档管理"/)
assert.doesNotMatch(app, /path="\/saves"/)

assert.match(accounts, /title="账号管理"/)
assert.doesNotMatch(accounts, /全部玩家/)
assert.match(accounts, /title="账号 \/ 存档"/)
assert.match(accounts, /Grid/)
assert.match(accounts, /useBreakpoint/)
assert.match(accounts, /isMobile/)
assert.match(accounts, /AccountsMobileView/)
assert.doesNotMatch(accounts, /role: "button"/)
assert.match(accounts, /toggleSavePanel/)

// ── 账号卡 v2 双层结构（mockup accounts-two-layouts）────────────────────────
// 标题栏 = 账号#id + 当前存档名 + 备注(可编辑) + 新建存档(右)
assert.match(accounts, /acc-titlebar/)
assert.match(accounts, /acc-id-chip admin-mono">账号 #\{account\.id\}/)
assert.match(accounts, /acc-title-name">\{account\.defaultPlayerName \?\? "无存档"\}/)
assert.match(accounts, /label: "删除账号"/)
// 身份行 = 头像 + 名称 + 存档id + 绑定设备 + 存档数 + […]
assert.match(accounts, /acc-identity/)
assert.match(accounts, /acc-identity-name">\{account\.defaultPlayerName \?\? "无存档"\}/)
assert.match(accounts, /#存档 \{account\.defaultPlayerId\}/)
assert.match(accounts, /绑定设备 \{account\.devices\.length === 0 \? "无"/)
assert.match(accounts, /acc-count-toggle/)
assert.match(accounts, /存档数 \{account\.players\.length\} \{expanded \? "▴" : "▾"\}/)
assert.match(accounts, /admin-more-btn/)
// 绑定设备码 mono 只读(不可修改, 与备注是两个概念), 设备改名 UI 已移除
assert.doesNotMatch(accounts, /device\/rename/)
assert.doesNotMatch(accounts, /renameDevice/)
assert.doesNotMatch(mobileView, /onRenameDevice/)
assert.match(accounts, /绑定设备/)

// ── 备注行内编辑 ──────────────────────────────────────────────────────────
assert.match(accounts, /acc-note acc-note-edit/)
assert.match(accounts, /accountCleanup\/account/)
assert.doesNotMatch(accounts, /void updateNote/)
assert.match(mobileView, /acc-note acc-note-edit/)

// ── 存档子卡单行 ──────────────────────────────────────────────────────────
assert.match(accounts, /className="save-sub"/)
assert.match(accounts, /save-id admin-mono">#存档 \{player\.id\}<\/span>/)
assert.match(mobileView, /save-id admin-mono">#存档 \{player\.id\}<\/span>/)
// 合体标识: 当前=绿色徽章常驻(2 字与「切换」等长)/切换=默认钮, 仅存档子卡出现;
// 卡片操作钮恢复默认配色(维护者指定: 统一的是尺寸内边距而非颜色), 全页仅卡头新建存档为 primary
assert.equal((accounts.match(/admin-badge-ok save-current-chip">当前<\/span>/g) ?? []).length, 1, "当前标识应仅在存档子卡出现一次")
assert.equal((mobileView.match(/admin-badge-ok save-current-chip">当前<\/span>/g) ?? []).length, 1, "移动当前标识应仅在存档子卡出现一次")
assert.match(accounts, />切换<\/Button>/)
assert.equal((accounts.match(/type="primary"/g) ?? []).length, 2, "桌面 primary 仅新建存档+备注确定")
assert.equal((mobileView.match(/type="primary"/g) ?? []).length, 2, "移动 primary 仅新建存档+备注确定")
// 点空白交互(维护者指定): 账号卡空白=展开存档列表, 存档卡空白=进玩家详情
assert.match(accounts, /className="acc-card" key=\{account\.id\} onClick=\{\(\) => toggleSavePanel\(account\.id\)\}/)
assert.match(mobileView, /className="acc-card" key=\{account\.id\} onClick=\{\(\) => onSelectAccount\(account\.id\)\}/)
assert.match(accounts, /event\.stopPropagation\(\); navigate\(`\/players\/\$\{player\.id\}`\)/)
assert.match(mobileView, /acc-identity-meta/)
assert.match(mobileView, /#存档 \{account\.defaultPlayerId\}/)
assert.doesNotMatch(mobileView, /acc-kv/)
assert.doesNotMatch(accounts, /重命名存档/)
assert.doesNotMatch(accounts, /renameSave/)
// 复制/导出/删除 收进存档「…」菜单(维护者指定)
assert.match(accounts, /saveMoreMenu/)
assert.match(accounts, /label: "复制"/)
assert.match(accounts, /label: "导出"/)
assert.match(accounts, /key: "delete", danger: true, label: "删除"/)
assert.match(mobileView, /saveMoreMenu/)
assert.doesNotMatch(mobileView, /label: "导出"/, "移动存档菜单不含导出")
assert.match(accounts, /删除存档 \$\{player\.id\}？/)
assert.match(mobileView, /删除存档 \$\{player\.id\}？/)
assert.match(accounts, /删除账号 \$\{accountId\} 及所有存档？/)
assert.match(mobileView, /删除账号 \$\{accountId\} 及所有存档？/)

// 移动端: 每账号真卡片 + 三行内部 + 存档数/[…] 两键一行
assert.match(mobileView, /admin-account-mobile-list/)
assert.match(mobileView, /className="acc-card"/)
assert.match(mobileView, /acc-titlebar/)
assert.match(mobileView, /acc-identity/)
assert.match(mobileView, /acc-bottom-row/)
assert.match(mobileView, /acc-count-toggle/)
assert.match(mobileView, /admin-account-actions/)
assert.doesNotMatch(mobileView, /<List/)
assert.match(mobileView, /暂无账号/)
assert.match(mobileView, /编辑存档/)
assert.match(mobileView, /player\.rank/)
assert.doesNotMatch(mobileView, /role="button"/)

// 操作钮尺寸统一为默认(与新建存档同高, 维护者指定: 统一的是尺寸而非颜色);
// 仅行内编辑器紧凑组保留 small(两端各 = 备注编辑器 Input+确定+取消 3 处)
{
    const smallCount = (accounts.match(/size="small"/g) ?? []).length
    assert.equal(smallCount, 3, "桌面 small 实际 " + smallCount + " 处")
    const mobileSmall = (mobileView.match(/size="small"/g) ?? []).length
    assert.equal(mobileSmall, 3, "移动 small 实际 " + mobileSmall + " 处")
}

// 喜爱角色头像: /api/server/accounts 只读投影 favoriteCharacterId ← 收藏编队读取器轻量 wrapper;
// 子卡头像走既有 character_avatar 端点(物化 IDAT 归一化), onError 重试默认 alk 后回退首字占位
assert.match(accountTypes, /favoriteCharacterId: number \| null/)
assert.match(profileFavorite, /export function getFavoriteCharacterIdSync/)
assert.match(serverApi, /favoriteCharacterId: getFavoriteCharacterIdSync\(player\.id\)/)
assert.match(accounts, /FavoriteAvatar/)
assert.match(mobileView, /FavoriteAvatar/)
assert.match(favoriteAvatar, /DEFAULT_AVATAR_CHARACTER_ID = 1/)
assert.match(favoriteAvatar, /\/api\/content\/character_avatar\/\$\{characterId \?\? DEFAULT_AVATAR_CHARACTER_ID\}/)
assert.match(favoriteAvatar, /getAttribute\("src"\) !== fallback/)
assert.match(favoriteAvatar, /av-img-picture-broken/)

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

// A6: 存档导出必须是携带后台鉴权的 fetch/blob 下载，而不是裸直链
assert.doesNotMatch(playerDetail, /href=\{`\/api\/player\/save/)
assert.match(playerDetail, /apiDownloadFile\(`\/api\/player\/save\?id=\$\{pid\}`/)
assert.match(playerDetail, /导出存档/)
const apiClient = fs.readFileSync("admin/src/api/client.ts", "utf8")
assert.match(apiClient, /export async function apiDownloadFile/)
assert.match(apiClient, /Accept: "application\/json"/)
assert.match(apiClient, /content-disposition/)
assert.match(apiClient, /revokeObjectURL/)

console.log("admin-account-save-ui tests passed")
