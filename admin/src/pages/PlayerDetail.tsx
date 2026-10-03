import { useState } from "react"
import type { ReactNode } from "react"
import { Card, Table, Button, Space, InputNumber, Popconfirm, message, Tag, Tabs, Spin, Typography, Switch, Input, Upload } from "antd"
import { Trash2 } from "lucide-react"
import { SaveOutlined, PlusOutlined, DownloadOutlined, UploadOutlined, UndoOutlined, SearchOutlined, EditOutlined } from "@ant-design/icons"
import { useParams, useNavigate } from "react-router-dom"
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query"
import { apiGet, apiPost, apiPatch, apiDelete, apiUpload, apiDownloadFile, isAndroidWebView } from "../api/client"
import { AdminPage, StateCard } from "../components/AdminPage"

const { Text } = Typography

interface PlayerInfo {
    id: number; accountId: number; name: string; comment: string
    stamina: number; boostPoint: number; bossBoostPoint: number
    vmoney: number; freeVmoney: number; freeMana: number; paidMana: number
    rankPoint: number; starCrumb: number; bondToken: number
    expPool: number; degreeId: number; leaderCharacterId: number
    birth: number; enableAuto3x: boolean; tutorialStep: number | null
    lastLoginTime: string
}

interface AccountBrief {
    players: { id: number; isDefault: boolean; isActive: boolean }[]
}

interface CharRow { code: number; joinTime: string; entryCount: number; evolutionLevel: number; overLimitStep: number; exp: number; stack: number; manaBoardIndex: number }
interface ItemRow { id: number; count: number }
interface EquipRow { id: number; level: number; enhancementLevel: number }
interface QuestRow { section: number; questId: number; finished: boolean; highScore: number | null; clearRank: number | null; bestElapsedTimeMs: number | null }
interface DrawnQuestRow { categoryId: number; questId: number; oddsId: number }

interface DetailData {
    player: PlayerInfo
    characters: CharRow[]
    items: ItemRow[]
    equipment: EquipRow[]
    questProgress: QuestRow[]
    drawnQuests: DrawnQuestRow[]
}

interface Lookups {
    characters: Record<number, { name: string; title: string; rarity: string; element: string }>
    items: Record<number, string>
    equipment: Record<number, { name: string; rarity: string; category: string }>
    quests: Record<string, string>
}

// 资源编辑 10 项（图标砖结构沿用 approved mockup player-v2，Rank 居首；Boss Boost/Boost
// 为重构前页面既有编辑字段，修复轮恢复，仅补配同款星描边图标；
// 羁绊证原也在列，2026-09-29 经维护者明确指示移除，勿恢复）
const resourceFields: { key: string; label: string; icon?: ReactNode; lvBadge?: boolean }[] = [
    { key: "rankPoint", label: "Rank", lvBadge: true },
    { key: "expPool", label: "经验池", icon: <path d="M12 3c3.5 4.5 7 8.2 7 11.2a7 7 0 0 1-14 0c0-3 3.5-6.7 7-11.2z" /> },
    { key: "freeVmoney", label: "星导石(免费)", icon: <circle cx="12" cy="12" r="8.5" /> },
    { key: "vmoney", label: "星导石(付费)", icon: <circle cx="12" cy="12" r="8.5" /> },
    { key: "freeMana", label: "Mana(免费)", icon: <path d="M3 12l4.5-7.5h9L21 12l-4.5 7.5h-9z" /> },
    { key: "paidMana", label: "Mana(付费)", icon: <path d="M3 12l4.5-7.5h9L21 12l-4.5 7.5h-9z" /> },
    {
        key: "stamina", label: "体力", icon: (
            <>
                <path d="M10 2v6.2L4.6 18.8A1.4 1.4 0 0 0 5.9 21h12.2a1.4 1.4 0 0 0 1.3-2.2L14 8.2V2" />
                <path d="M8.5 2h7" />
                <path d="M7.5 15h9" />
            </>
        ),
    },
    { key: "starCrumb", label: "星屑", icon: <path d="M13.5 2.5l5.5 7.5-2.5 11.5-7.5-3.5.5-8.5z" /> },
    { key: "bossBoostPoint", label: "Boss Boost", icon: <path d="M13 2L5 13h6l-1 9 8-11h-6z" /> },
    { key: "boostPoint", label: "Boost", icon: <path d="M12 19V5M5 12l7-7 7 7" /> },
]

export default function PlayerDetail() {
    const { playerId } = useParams()
    const pid = Number(playerId)
    const navigate = useNavigate()
    const qc = useQueryClient()
    const [editValues, setEditValues] = useState<Record<string, any>>({})
    const [addItemId, setAddItemId] = useState<number | undefined>()
    const [addItemCount, setAddItemCount] = useState<number>(1)
    const [searchChars, setSearchChars] = useState("")
    const [searchItems, setSearchItems] = useState("")
    const [searchEquip, setSearchEquip] = useState("")
    const [searchQuests, setSearchQuests] = useState("")
    const [searchDrawn, setSearchDrawn] = useState("")
    // 存档重命名入口（F5：自账号页存档卡移入 hero，见 Accounts.tsx renameSave）
    // 编辑态规范与账号备注一致: 点击进入, 样式不变, 失焦保存, Enter 同保存, Escape 放弃
    const [renamingSave, setRenamingSave] = useState(false)
    const [renameValue, setRenameValue] = useState("")
    const [renameOriginal, setRenameOriginal] = useState("")

    const { data, isLoading, isFetching, isError } = useQuery({
        queryKey: ["playerDetail", pid],
        queryFn: () => apiGet<DetailData>(`/api/player/${pid}/detail`),
        enabled: !isNaN(pid),
    })

    // 存档身份徽章（归一为「当前存档」, isDefault/isActive 合一）复用账号列表接口，与 Dashboard 共享缓存
    const { data: accounts } = useQuery({
        queryKey: ["accounts"],
        queryFn: () => apiGet<AccountBrief[]>("/api/server/accounts"),
    })

    const { data: lookups } = useQuery({
        queryKey: ["lookups"],
        queryFn: async (): Promise<Lookups> => {
            const [characters, items, equipment, quests] = await Promise.all([
                apiGet<Lookups["characters"]>("/api/lookup/characters"),
                apiGet<Lookups["items"]>("/api/lookup/items"),
                apiGet<Lookups["equipment"]>("/api/lookup/equipment"),
                apiGet<Lookups["quests"]>("/api/lookup/quests"),
            ])
            return { characters, items, equipment, quests }
        },
        staleTime: Infinity,
    })

    const refresh = () => qc.invalidateQueries({ queryKey: ["playerDetail", pid] })
    // 页头刷新：详情 + 存档身份徽章 + 查表缓存（照既有写操作 invalidation 集合）
    const refreshPage = () => {
        qc.invalidateQueries({ queryKey: ["playerDetail", pid] })
        qc.invalidateQueries({ queryKey: ["accounts"] })
        qc.invalidateQueries({ queryKey: ["lookups"] })
    }
    const showMutationError = (error: Error) => message.error(error.message)

    const editField = useMutation({
        mutationFn: ({ field, value }: { field: string; value: any }) =>
            apiPatch(`/api/player/${pid}/field`, { field, value }),
        onSuccess: (_, { field }) => {
            message.success(`${field} 已更新`)
            setEditValues(v => { const n = { ...v }; delete n[field]; return n })
            refresh()
        },
        onError: (e: Error) => message.error(e.message),
    })

    // 与账号页 Accounts.tsx renameSave 完全相同的 API 路径与参数；本页额外失效 playerDetail
    const renameSave = useMutation({
        mutationFn: (name: string) => apiPost("/api/server/renameSave", { playerId: pid, name }),
        onSuccess: () => {
            message.success("已改名")
            setRenamingSave(false)
            qc.invalidateQueries({ queryKey: ["playerDetail", pid] })
            qc.invalidateQueries({ queryKey: ["accounts"] })
        },
        onError: showMutationError,
    })

    // 失焦保存: 与原名相同只退编辑态不发请求
    const commitRename = () => {
        if (renameValue === renameOriginal) { setRenamingSave(false); return }
        renameSave.mutate(renameValue)
    }

    const delChar = useMutation({
        mutationFn: (code: number) => apiDelete(`/api/player/${pid}/character/${code}`),
        onSuccess: () => { message.success("角色已删除"); refresh() },
        onError: showMutationError,
    })

    const addItem = useMutation({
        mutationFn: ({ id, count }: { id: number; count: number }) =>
            apiPost(`/api/player/${pid}/item`, { id, count }),
        onSuccess: () => { message.success("道具已设置"); setAddItemId(undefined); setAddItemCount(1); refresh() },
        onError: (e: Error) => message.error(e.message),
    })

    const delItem = useMutation({
        mutationFn: (itemId: number) => apiDelete(`/api/player/${pid}/item/${itemId}`),
        onSuccess: () => { message.success("道具已删除"); refresh() },
        onError: showMutationError,
    })

    const delQuestProgress = useMutation({
        mutationFn: ({ section, questId }: { section: number; questId: number }) =>
            apiDelete(`/api/player/${pid}/quest_progress/${section}/${questId}`),
        onSuccess: () => { message.success("关卡记录已删除"); refresh() },
        onError: showMutationError,
    })

    const clearAllQuestProgress = useMutation({
        mutationFn: () => apiDelete(`/api/player/${pid}/quest_progress`),
        onSuccess: () => { message.success("全部关卡记录已清除"); refresh() },
        onError: showMutationError,
    })

    const delDrawnQuest = useMutation({
        mutationFn: ({ category, questId }: { category: number; questId: number }) =>
            apiDelete(`/api/player/${pid}/drawn_quest/${category}/${questId}`),
        onSuccess: () => { message.success("抽选记录已删除"); refresh() },
        onError: showMutationError,
    })

    const clearAllDrawnQuests = useMutation({
        mutationFn: () => apiDelete(`/api/player/${pid}/drawn_quest`),
        onSuccess: () => { message.success("全部抽选记录已清除"); refresh() },
        onError: showMutationError,
    })

    const clearExBoost = useMutation({
        mutationFn: () => apiPost<{ ok: boolean; clearedCharacters: number }>(`/api/player/${pid}/clear_ex_boost`),
        onSuccess: ({ clearedCharacters }) => {
            message.success(`已清除 ${clearedCharacters} 个角色的 EX 能力`)
            refresh()
        },
        onError: showMutationError,
    })

    const clearReceiveHistory = useMutation({
        mutationFn: () => apiPost(`/api/player/${pid}/clear_receive_history`),
        onSuccess: () => { message.success("接收历史已清除"); refresh() },
        onError: (e: Error) => message.error(e.message),
    })

    // 存档导出走统一 fetch/blob 通道（携带部署层后台认证），错误就地提示而非整页跳转
    const exportSave = useMutation({
        mutationFn: () => apiDownloadFile(`/api/player/save?id=${pid}`, `save_${pid}.json`),
        onError: (e: Error) => message.error(`存档导出失败：${e.message}`),
    })

    const resetParties = useMutation({
        mutationFn: () => apiPost(`/api/player/${pid}/reset_parties`),
        onSuccess: () => { message.success("编队已重置"); refresh() },
        onError: showMutationError,
    })

    const clearMail = useMutation({
        mutationFn: () => apiDelete(`/api/player/${pid}/mail`),
        onSuccess: () => { message.success("邮箱已清空"); refresh() },
        onError: showMutationError,
    })

    const resetChallenge = useMutation({
        mutationFn: () => apiPost(`/api/player/${pid}/reset_challenge`),
        onSuccess: () => { message.success("每日挑战已重置"); refresh() },
        onError: showMutationError,
    })

    const importSave = useMutation({
        mutationFn: (file: File) => apiUpload<{ ok: boolean }>(`/api/player/save?id=${pid}`, file),
        onSuccess: () => { message.success("存档已导入"); refresh() },
        onError: (e: Error) => message.error(e.message),
    })

    if (isNaN(pid)) return <Card><Text type="danger">无效的玩家 ID</Text></Card>
    if (isLoading) return <StateCard><Spin size="large" /></StateCard>
    if (isError || !data) return <Card><Text type="danger">加载失败</Text></Card>

    const { player, characters, items, equipment, questProgress, drawnQuests } = data
    const saveBrief = accounts?.flatMap(account => account.players).find(p => p.id === pid)

    // 逐字段保存输入控件（沿用原逐项保存模式）：改动后出现保存按钮，点击即落库
    const fieldControl = (key: string, opts: { min?: number; allowNull?: boolean } = {}, compactClassName?: string) => {
        const has = key in editValues
        const current = (player as any)[key]
        const shown = has ? editValues[key] : current
        const changed = has && editValues[key] !== current
        return (
            <Space.Compact className={compactClassName}>
                <InputNumber
                    value={shown}
                    min={opts.min}
                    onChange={v => setEditValues(prev => ({ ...prev, [key]: v ?? (opts.allowNull ? null : (opts.min ?? 0)) }))}
                />
                {changed && (
                    <Button type="primary" icon={<SaveOutlined />}
                        loading={editField.isPending}
                        onClick={() => editField.mutate({ field: key, value: editValues[key] })}
                    />
                )}
            </Space.Compact>
        )
    }

    // 资源编辑砖（approved mockup player-v2）：固定 52px 图标列（图标 + 标签）+ 输入 + 保存
    const resTile = (f: (typeof resourceFields)[number]) => (
        <div className="admin-res-tile" key={f.key}>
            <div className="admin-res-ic">
                {f.lvBadge
                    ? <span className="admin-res-lv">Lv</span>
                    : <svg className="admin-res-icon" viewBox="0 0 24 24" aria-hidden="true">{f.icon}</svg>}
                <div className="admin-res-label">{f.label}</div>
            </div>
            {fieldControl(f.key, { min: 0 }, "admin-res-control")}
        </div>
    )

    const searchBox = (value: string, setValue: (s: string) => void) => (
        <Input allowClear size="small" prefix={<SearchOutlined />} placeholder="搜索名称或 ID"
            value={value} onChange={e => setValue(e.target.value)} style={{ width: 260, maxWidth: "100%" }} />
    )

    // 大表格搜索过滤（名称或 ID）
    const norm = (s: string) => s.trim().toLowerCase()
    const fChars = characters.filter(r => {
        const s = norm(searchChars); if (!s) return true
        const c = lookups?.characters[r.code]
        return String(r.code).includes(s) || (c?.name ?? "").toLowerCase().includes(s) || (c?.title ?? "").toLowerCase().includes(s)
    })
    const fItems = items.filter(r => {
        const s = norm(searchItems); if (!s) return true
        return String(r.id).includes(s) || String((lookups?.items as any)?.[r.id] ?? "").toLowerCase().includes(s)
    })
    const fEquip = equipment.filter(r => {
        const s = norm(searchEquip); if (!s) return true
        return String(r.id).includes(s) || String((lookups?.equipment as any)?.[r.id]?.name ?? "").toLowerCase().includes(s)
    })
    const fQuests = questProgress.filter(r => {
        const s = norm(searchQuests); if (!s) return true
        return String(r.section).includes(s) || String(r.questId).includes(s) || String((lookups?.quests as any)?.[`${r.section}_${r.questId}`] ?? "").toLowerCase().includes(s)
    })
    const fDrawn = drawnQuests.filter(r => {
        const s = norm(searchDrawn); if (!s) return true
        return String(r.categoryId).includes(s) || String(r.questId).includes(s) || String((lookups?.quests as any)?.[`${r.categoryId}_${r.questId}`] ?? "").toLowerCase().includes(s)
    })

    const tabItems = [
        {
            key: "characters",
            label: `角色 (${characters.length})`,
            children: (
                <Space direction="vertical" style={{ width: "100%" }}>
                    <div className="admin-toolbar">
                        {searchBox(searchChars, setSearchChars)}
                    </div>
                    <Table rowKey="code" dataSource={fChars} size="small" pagination={{ pageSize: 50 }}
                        scroll={{ x: "max-content" }}
                        tableLayout="fixed"
                        columns={[
                            {
                                // 头像列: code 即角色 id, 与账号页喜爱角色头像同一 CDN 归档端点;
                                // ?v=2 击穿浏览器 24h 缓存 —— 服务端清扫修复前该 URL 可能缓存过坏字节
                                title: "头像", width: 56,
                                render: (_, r: CharRow) => (
                                    <img
                                        className="admin-char-avatar-cell"
                                        src={`/api/content/character_avatar/${r.code}?v=2`}
                                        alt=""
                                        loading="lazy"
                                        onError={event => { event.currentTarget.classList.add("admin-char-avatar-cell-broken") }}
                                    />
                                ),
                            },
                            { title: "名字", render: (_, r: CharRow) => lookups?.characters[r.code]?.name ?? "?" },
                            { title: "称号", render: (_, r: CharRow) => lookups?.characters[r.code]?.title ?? "-", responsive: ["lg"] as any },
                            { title: "Code", dataIndex: "code", width: 80 },
                            { title: "稀有度", render: (_, r: CharRow) => lookups?.characters[r.code] ? `${lookups.characters[r.code].rarity} ${lookups.characters[r.code].element}` : "-", width: 100 },
                            { title: "入手时间", dataIndex: "joinTime", render: (t: string) => t.replace("T", " ").substring(0, 19), responsive: ["md"] as any },
                            {
                                title: "", width: 80,
                                render: (_, r: CharRow) => r.code === 1 ? <Tag>Alk</Tag> : (
                                    <Popconfirm title="删除此角色？" onConfirm={() => delChar.mutate(r.code)} okText="确认" cancelText="取消" okButtonProps={{ danger: true }}>
                                        <Button size="small" type="text" danger icon={<Trash2 size={15} />} aria-label="删除角色" />
                                    </Popconfirm>
                                ),
                            },
                        ]}
                    />
                </Space>
            ),
        },
        {
            key: "items",
            label: `道具 (${items.length})`,
            children: (
                <Space direction="vertical" style={{ width: "100%" }}>
                    <div className="admin-toolbar">
                        <InputNumber placeholder="道具 ID" value={addItemId} onChange={v => setAddItemId(v ?? undefined)} style={{ width: 120 }} />
                        <InputNumber placeholder="数量" value={addItemCount} onChange={v => setAddItemCount(v ?? 1)} min={0} style={{ width: 100 }} />
                        <Button icon={<PlusOutlined />} onClick={() => addItemId != null && addItem.mutate({ id: addItemId, count: addItemCount })}>添加/设置</Button>
                        {searchBox(searchItems, setSearchItems)}
                    </div>
                    <Table rowKey="id" dataSource={fItems} size="small" pagination={{ pageSize: 50 }}
                        scroll={{ x: "max-content" }}
                        tableLayout="fixed"
                        columns={[
                            { title: "名字", render: (_, r: ItemRow) => (lookups?.items as any)?.[r.id] ?? "-" },
                            { title: "ID", dataIndex: "id", width: 80 },
                            { title: "数量", dataIndex: "count", width: 100 },
                            {
                                title: "", width: 80,
                                render: (_, r: ItemRow) => (
                                    <Popconfirm title="删除此道具？" onConfirm={() => delItem.mutate(r.id)} okText="确认" cancelText="取消" okButtonProps={{ danger: true }}>
                                        <Button size="small" type="text" danger icon={<Trash2 size={15} />} aria-label="删除道具" />
                                    </Popconfirm>
                                ),
                            },
                        ]}
                    />
                </Space>
            ),
        },
        {
            key: "equipment",
            label: `装备 (${equipment.length})`,
            children: (
                <Space direction="vertical" style={{ width: "100%" }}>
                    <div className="admin-toolbar">
                        {searchBox(searchEquip, setSearchEquip)}
                    </div>
                    <Table rowKey="id" dataSource={fEquip} size="small" pagination={{ pageSize: 50 }}
                        scroll={{ x: "max-content" }}
                        tableLayout="fixed"
                        columns={[
                            { title: "名字", render: (_, r: EquipRow) => (lookups?.equipment as any)?.[r.id]?.name ?? "-" },
                            { title: "ID", dataIndex: "id", width: 80 },
                            { title: "稀有度", render: (_, r: EquipRow) => { const eq = (lookups?.equipment as any)?.[r.id]; return eq ? `${eq.rarity}★` : "-" }, width: 80 },
                            { title: "类型", render: (_, r: EquipRow) => (lookups?.equipment as any)?.[r.id]?.category ?? "-", width: 80 },
                            { title: "等级", dataIndex: "level", width: 80 },
                            { title: "强化", dataIndex: "enhancementLevel", width: 80 },
                        ]}
                    />
                </Space>
            ),
        },
        {
            key: "quests",
            label: `关卡 (${questProgress.length})`,
            children: (
                <Space direction="vertical" style={{ width: "100%" }}>
                    <div className="admin-toolbar">
                        <Popconfirm title="清除全部关卡进度？" onConfirm={() => clearAllQuestProgress.mutate()} okText="确认" cancelText="取消" okButtonProps={{ danger: true }}>
                            <Button danger size="small">清除全部</Button>
                        </Popconfirm>
                        {searchBox(searchQuests, setSearchQuests)}
                    </div>
                    <Table rowKey={(r: QuestRow) => `${r.section}_${r.questId}`} dataSource={fQuests} size="small" pagination={{ pageSize: 50 }}
                        scroll={{ x: "max-content" }}
                        tableLayout="fixed"
                        columns={[
                            { title: "名字", render: (_, r: QuestRow) => (lookups?.quests as any)?.[`${r.section}_${r.questId}`] ?? "-" },
                            { title: "Section", dataIndex: "section", width: 80 },
                            { title: "Quest", dataIndex: "questId", width: 80 },
                            { title: "通关", render: (_, r: QuestRow) => r.finished ? <span className="admin-badge-ok">已通关</span> : <span className="admin-muted">—</span>, width: 72 },
                            { title: "最高分", dataIndex: "highScore", render: (v: number | null) => v ?? <span className="admin-muted">—</span>, width: 80 },
                            { title: "评价", dataIndex: "clearRank", render: (v: number | null) => v ?? <span className="admin-muted">—</span>, width: 60 },
                            { title: "最佳时间", dataIndex: "bestElapsedTimeMs", render: (v: number | null) => v ?? <span className="admin-muted">—</span>, width: 100 },
                            {
                                title: "", width: 80,
                                render: (_, r: QuestRow) => (
                                    <Popconfirm title="删除此记录？" onConfirm={() => delQuestProgress.mutate({ section: r.section, questId: r.questId })} okText="确认" cancelText="取消" okButtonProps={{ danger: true }}>
                                        <Button size="small" type="text" danger icon={<Trash2 size={15} />} aria-label="删除关卡记录" />
                                    </Popconfirm>
                                ),
                            },
                        ]}
                    />
                </Space>
            ),
        },
        {
            key: "drawn",
            label: `抽选关卡 (${drawnQuests.length})`,
            children: (
                <Space direction="vertical" style={{ width: "100%" }}>
                    <div className="admin-toolbar">
                        <Popconfirm title="清除全部抽选记录？" onConfirm={() => clearAllDrawnQuests.mutate()} okText="确认" cancelText="取消" okButtonProps={{ danger: true }}>
                            <Button danger size="small">清除全部</Button>
                        </Popconfirm>
                        {searchBox(searchDrawn, setSearchDrawn)}
                    </div>
                    <Table rowKey={(r: DrawnQuestRow) => `${r.categoryId}_${r.questId}`} dataSource={fDrawn} size="small" pagination={{ pageSize: 50 }}
                        scroll={{ x: "max-content" }}
                        tableLayout="fixed"
                        columns={[
                            { title: "名字", render: (_, r: DrawnQuestRow) => (lookups?.quests as any)?.[`${r.categoryId}_${r.questId}`] ?? "-" },
                            { title: "Category", dataIndex: "categoryId", width: 80 },
                            { title: "Quest", dataIndex: "questId", width: 80 },
                            { title: "Odds", dataIndex: "oddsId", width: 80 },
                            {
                                title: "", width: 80,
                                render: (_, r: DrawnQuestRow) => (
                                    <Popconfirm title="删除此记录？" onConfirm={() => delDrawnQuest.mutate({ category: r.categoryId, questId: r.questId })} okText="确认" cancelText="取消" okButtonProps={{ danger: true }}>
                                        <Button size="small" type="text" danger icon={<Trash2 size={15} />} aria-label="删除抽选记录" />
                                    </Popconfirm>
                                ),
                            },
                        ]}
                    />
                </Space>
            ),
        },
    ]

    return (
        <AdminPage
            eyebrow="PLAYER"
            title="玩家详情 · 存档编辑"
            description="角色获取入口仅保留邮件发送，避免绕过客户端领取校验。"
            onRefresh={refreshPage}
            refreshing={isFetching}
            actions={
                <Button onClick={() => navigate("/accounts")}>←返回</Button>
            }
        >
        <Space direction="vertical" size="large" className="admin-stack">
            <div className="admin-hero">
                <div className="admin-hero-in">
                    <div className="admin-hero-id">
                        {/* 顶行: 归一后的「当前存档」标识居左, 账号 id 居右(维护者指定);
                            「存档身份」文字标签与卡内身份描述已移除 */}
                        <div className="admin-hero-topline">
                            {(saveBrief?.isDefault || saveBrief?.isActive) && (
                                <span className="admin-badge-info">当前存档</span>
                            )}
                            <span className="admin-hero-account">账号 <b className="admin-mono">#{player.accountId}</b></span>
                        </div>
                        <div className="admin-hero-id-name">
                            {renamingSave ? (
                                // 改名与账号备注同一行内编辑规范: 样式不变(粗体名原样),
                                // 失焦保存, Enter 同保存, Escape 放弃, 无按钮
                                <input
                                    className="admin-hero-rename-input"
                                    value={renameValue}
                                    maxLength={64}
                                    autoFocus
                                    onChange={e => setRenameValue(e.target.value)}
                                    onBlur={commitRename}
                                    onKeyDown={e => {
                                        if (e.key === "Enter") commitRename()
                                        if (e.key === "Escape") setRenamingSave(false)
                                    }}
                                />
                            ) : (
                                <>
                                    {player.name} <span className="admin-hero-id-pid">#{player.id}</span>
                                    <Button
                                        type="text"
                                        size="small"
                                        title="重命名存档"
                                        icon={<EditOutlined />}
                                        onClick={() => { setRenamingSave(true); setRenameOriginal(player.name); setRenameValue(player.name) }}
                                    />
                                </>
                            )}
                        </div>
                        <div className="admin-hero-id-info">
                            <span>上次更新 <b className="admin-mono">{player.lastLoginTime.replace("T", " ").substring(0, 16)}</b></span>
                        </div>
                    </div>
                    <div className="admin-hero-ops">
                        <Upload accept=".json,application/json" showUploadList={false} maxCount={1}
                            beforeUpload={file => { importSave.mutate(file); return false }}>
                            <Button type="primary" icon={<DownloadOutlined />} loading={importSave.isPending}>导入存档(覆盖)</Button>
                        </Upload>
                        <Button icon={<UploadOutlined />} loading={exportSave.isPending}
                            onClick={() => {
                                // 壳内 WebView：apiDownloadFile 内部走 iframe 导航式下载，成败由壳侧
                                // 下载管线异步接管，mutation 会立即成功——只提示移交，不弹成功 toast。
                                if (isAndroidWebView()) message.info("已交由系统下载")
                                exportSave.mutate()
                            }}>导出存档</Button>
                    </div>
                </div>
            </div>

            <Card title="资源编辑" className="admin-dash-card admin-res-card"
                extra={<span className="admin-card-note">每项修改后点字段右侧 ⟳ 保存，逐项生效</span>}>
                <div className="admin-res-grid">
                    {resourceFields.map(f => resTile(f))}
                </div>
            </Card>

            {/* 「账号设置」卡 2026-09-29 撤销：3x加速/教程步骤 并入下方危险操作条；
                等级(称号ID)/队长角色ID 编辑项 2026-09-29 经维护者明确指示移除,勿恢复 */}
            <Card className="admin-table-card admin-player-tabs">
                <Tabs items={tabItems} />
            </Card>

            {/* 存档标识折叠卡 2026-10-04 移除: 存档名/存档 ID/账号 ID 均已在 hero 展示,
                完全重复(维护者指定) */}

            {/* 危险操作默认收起(维护者指定): 复用 admin-details 折叠模式, 红条本体整体藏进 details */}
            <details className="admin-details admin-danger-details">
                <summary className="admin-details-summary">
                    <span className="admin-details-arrow" aria-hidden="true">▶</span>
                    <span className="admin-details-star" aria-hidden="true" />
                    危险操作
                    <span className="admin-details-hint">均需二次确认 · 开发期兜底回退工具, 误用大概率造成存档数据异常</span>
                </summary>
                <div className="admin-danger-bar">
                    <div className="admin-danger-bar-head">
                        <span className="admin-danger-bar-label">危险操作 · 均需二次确认</span>
                        <span className="admin-danger-bar-desc">
                            以上均为开发期排查问题的兜底性回退工具，日常运营不建议使用；当前版本下误用大概率造成存档数据异常，请务必确认后再操作。
                        </span>
                    </div>
                    <div className="admin-danger-bar-actions">
                        <span className="admin-danger-control">
                            <span className="admin-danger-control-label">3x加速</span>
                            <Switch checked={player.enableAuto3x} loading={editField.isPending}
                                onChange={v => editField.mutate({ field: "enableAuto3x", value: v })} />
                        </span>
                        <span className="admin-danger-control">
                            <span className="admin-danger-control-label">教程步骤</span>
                            {fieldControl("tutorialStep", { min: 0, allowNull: true })}
                            <span className="admin-danger-control-hint">空 = null</span>
                        </span>
                        <Popconfirm title="清除全部 EX Boost？" onConfirm={() => clearExBoost.mutate()} okText="确认" cancelText="取消" okButtonProps={{ danger: true }}>
                            <Button size="small" danger loading={clearExBoost.isPending}>清除 EX Boost</Button>
                        </Popconfirm>
                        <Popconfirm title="重置编队到默认？" onConfirm={() => resetParties.mutate()} okText="确认" cancelText="取消">
                            <Button size="small" danger icon={<UndoOutlined />}>重置编队</Button>
                        </Popconfirm>
                        <Popconfirm title="清空邮箱？" onConfirm={() => clearMail.mutate()} okText="确认" cancelText="取消" okButtonProps={{ danger: true }}>
                            <Button size="small" danger>清空邮箱</Button>
                        </Popconfirm>
                        <Popconfirm title="重置每日挑战点？" onConfirm={() => resetChallenge.mutate()} okText="确认" cancelText="取消">
                            <Button size="small" danger icon={<UndoOutlined />}>重置每日挑战</Button>
                        </Popconfirm>
                        <Popconfirm title="清除接收历史（一次性道具的领取记录）？" onConfirm={() => clearReceiveHistory.mutate()} okText="确认" cancelText="取消" okButtonProps={{ danger: true }}>
                            <Button size="small" danger loading={clearReceiveHistory.isPending}>清除接收历史</Button>
                        </Popconfirm>
                    </div>
                </div>
            </details>
        </Space>
        </AdminPage>
    )
}
