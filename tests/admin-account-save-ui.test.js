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
// 标题栏 = 账号#id + 备注(可编辑) + 新建存档(右); 当前存档名不进标题栏(名字在身份行
// 已展示, 三处重复过于冗余 — 维护者指定)
assert.match(accounts, /acc-titlebar/)
assert.match(accounts, /acc-id-chip admin-mono">账号 #\{account\.id\}/)
assert.doesNotMatch(accounts, /acc-title-name/)
assert.doesNotMatch(mobileView, /acc-title-name/)
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
// 编辑态规范(维护者指定): 点击进入编辑态, input 样式不变, 失焦保存 —
// 无确定/取消按钮, 无 antd 输入框外框; Enter 同保存, Escape 放弃
assert.match(accounts, /acc-note-input/)
assert.match(mobileView, /acc-note-input/)
assert.match(accounts, /onBlur=\{\(\) => commitNote\(account\.id\)\}/)
assert.match(mobileView, /onBlur=\{\(\) => commitNote\(account\.id\)\}/)
assert.match(accountsCss, /\.acc-note-input \{[^}]*border: none/)
assert.doesNotMatch(accounts, />确定<\/Button>/)
assert.doesNotMatch(accounts, />取消<\/Button>/)
assert.doesNotMatch(mobileView, />确定<\/Button>/)
assert.doesNotMatch(mobileView, />取消<\/Button>/)

// ── 存档子卡单行 ──────────────────────────────────────────────────────────
assert.match(accounts, /className="save-sub"/)
assert.match(accounts, /save-id admin-mono">#存档 \{player\.id\}<\/span>/)
assert.match(mobileView, /save-id admin-mono">#存档 \{player\.id\}<\/span>/)
// 合体标识: 当前=绿色徽章常驻(2 字与「切换」等长)/切换=默认钮, 仅存档子卡出现;
// 卡片操作钮恢复默认配色(维护者指定: 统一的是尺寸内边距而非颜色), 全页仅卡头新建存档为 primary
assert.match(accounts, /<Button className="save-current-btn" onClick=\{event => event\.stopPropagation\(\)\}>当前<\/Button>/, "当前=绿描边独立样式按钮")
assert.match(mobileView, /<Button className="save-current-btn" onClick=\{event => event\.stopPropagation\(\)\}>当前<\/Button>/, "移动当前=绿描边独立样式按钮")
// 当前/切换在编辑按钮前(维护者指定): 移动端操作行顺序 当前|切换 → 编辑 → …
{
    const curIdx = mobileView.indexOf("save-current-btn")
    const swapIdx = mobileView.indexOf('aria-label="切换存档"')
    const editIdx = mobileView.indexOf('aria-label="编辑存档"')
    assert.ok(curIdx !== -1 && editIdx !== -1 && curIdx < editIdx, "「当前/切换」应位于「编辑」前")
    assert.ok(swapIdx === -1 || Math.abs(swapIdx - editIdx) < 400, "切换应与编辑同在操作行")
}
assert.match(accountsCss, /\.save-current-btn \{[^}]*color: var\(--wind\)/)
assert.match(accountsCss, /\.admin-account-actions \.act-edit \{[^}]*flex: 1 1 auto/)
assert.match(accounts, />切换<\/Button>/)
assert.equal((accounts.match(/type="primary"/g) ?? []).length, 1, "桌面 primary 仅卡头新建存档(备注改失焦保存, 无确定钮)")
assert.equal((mobileView.match(/type="primary"/g) ?? []).length, 1, "移动 primary 仅卡头新建存档(备注改失焦保存, 无确定钮)")
// 点空白交互(维护者指定): 账号卡空白=展开存档列表, 存档卡空白=进玩家详情
// 点击穿透修复: 仅点卡片本体(空白)触发(target !== currentTarget 直接跳过)
assert.equal((accounts.match(/if \(event\.target !== event\.currentTarget\) return/g) ?? []).length, 2, "桌面账号卡/存档卡都应有空白判定")
assert.equal((mobileView.match(/if \(event\.target !== event\.currentTarget\) return/g) ?? []).length, 2, "移动账号卡/存档卡都应有空白判定")
assert.match(mobileView, /acc-identity-meta/)
assert.match(mobileView, /#存档 \{account\.defaultPlayerId\}/)
assert.doesNotMatch(mobileView, /acc-kv/)
assert.doesNotMatch(accounts, /重命名存档/)
assert.doesNotMatch(accounts, /renameSave/)
// 复制/导出/删除 收进存档「…」菜单(维护者指定); 单存档账号删除项禁用(2026-10-04:
// 只能走显式删除账号, 破坏性与按钮语义对齐 — 服务端 deleteSave 同步 400 兜底)
assert.match(accounts, /saveMoreMenu/)
assert.match(accounts, /label: "复制"/)
assert.match(accounts, /label: "导出"/)
assert.match(accounts, /label: account\.players\.length <= 1 \? "删除（账号仅剩这一个存档）" : "删除"/)
assert.match(accounts, /disabled: account\.players\.length <= 1/)
assert.match(mobileView, /disabled: account\.players\.length <= 1/)
assert.match(serverApi, /该账号仅剩这一个存档，请使用删除账号/)
assert.doesNotMatch(accounts, /删除最后一个存档会同时删除账号/)
assert.match(accounts, /账号仅剩一个存档时不可删除存档，请使用删除账号/)
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

// 三类可点卡必须关闭安卓合成器点按高亮(Edge 安卓真机: 高亮 overlay 盖整卡连
// 内容一起染色, 非 CSS :hover, hover 闸门管不着 — accounts.css tap-highlight 块)
assert.match(accountsCss, /-webkit-tap-highlight-color:\s*transparent/)

// 操作钮尺寸统一为默认(与新建存档同高, 维护者指定: 统一的是尺寸而非颜色);
// 账号页不再有 small 组件(备注编辑器改原生无边框 input, 无 Input+确定+取消 紧凑组)
{
    const smallCount = (accounts.match(/size="small"/g) ?? []).length
    assert.equal(smallCount, 0, "桌面 small 实际 " + smallCount + " 处")
    const mobileSmall = (mobileView.match(/size="small"/g) ?? []).length
    assert.equal(mobileSmall, 0, "移动 small 实际 " + mobileSmall + " 处")
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

// ── 存档页 hero/危险操作 (维护者 2026-10-04 指定) ───────────────────────────
// 顶行: 归一「当前存档」徽章(isDefault/isActive 合一)居左, 账号 id 居右;
// 「存档身份」文字标签与卡内身份描述移除
assert.match(playerDetail, /admin-hero-topline/)
assert.match(playerDetail, /\(saveBrief\?\.isDefault \|\| saveBrief\?\.isActive\) && \(/)
assert.doesNotMatch(playerDetail, /admin-hero-id-label/)
assert.doesNotMatch(playerDetail, /当前活动/)
assert.match(playerDetail, /admin-hero-account/)
// 改名与备注同行内编辑规范: 原生无边框 input + 失焦保存 + 无按钮
assert.match(playerDetail, /admin-hero-rename-input/)
assert.match(playerDetail, /onBlur=\{commitRename\}/)
assert.doesNotMatch(playerDetail, /admin-edit-compact/)
// 危险操作默认收起(details 无 open 属性)
assert.match(playerDetail, /<details className="admin-details admin-danger-details">/)
assert.doesNotMatch(playerDetail, /admin-danger-details[^>]*\bopen\b/)
// 「详细信息」折叠卡已移除(存档名/存档 ID/账号 ID 均在 hero 展示, 完全重复)
assert.doesNotMatch(playerDetail, /详细信息/)
// 导入/导出并排: hero-ops 行向
{
    const playerCss = fs.readFileSync("admin/src/styles/pages/player.css", "utf8")
    assert.match(playerCss, /\.admin-hero-ops \{[^}]*flex-direction: row/)
}
// 角色表头像带版本参数(服务端清扫修复前该 URL 可能缓存过坏字节)
assert.match(playerDetail, /character_avatar\/\$\{r\.code\}\?v=2/)

// 账号卡分页器双视口共享(2026-10-05): 单 Card 内条件渲染列表体, Pagination 挂在
// 条件块之后——移动端 pagedAccounts 曾被切片却无翻页控件, 10 条之后不可见。
assert.match(
    accounts,
    /className=\{isMobile \? "admin-mobile-list-card" : "admin-table-card admin-accounts-card"\}/,
    "账号管理 Card 应按视口切换 className 而非拆成两张卡",
)
const accountsCardBody = accounts.match(/<Card[^>]*admin-mobile-list-card[\s\S]*?<\/Card>/)
assert(accountsCardBody, "应存在账号管理 Card")
assert(accountsCardBody[0].includes("AccountsMobileView"), "移动分支渲染账号卡列表")
assert(
    accountsCardBody[0].indexOf("<Pagination") > accountsCardBody[0].indexOf("isMobile ?"),
    "Pagination 必须挂在视口条件块之后(两视口共享), 不得只留在桌面分支",
)
assert(/total=\{filteredAccounts\.length\}/.test(accountsCardBody[0]), "分页 total 应跟随搜索过滤后的数量")

console.log("admin-account-save-ui tests passed")
