import { useState } from "react"
import { Card, Descriptions, Table, Button, Space, InputNumber, Popconfirm, message, Tag, Tabs, Spin, Typography, Switch, DatePicker, Input, Upload } from "antd"
import { SaveOutlined, DeleteOutlined, PlusOutlined, DownloadOutlined, UploadOutlined, UndoOutlined, SearchOutlined } from "@ant-design/icons"
import { useParams, useNavigate } from "react-router-dom"
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query"
import dayjs from "dayjs"
import { apiGet, apiPost, apiPatch, apiDelete, apiUpload } from "../api/client"

const { Text } = Typography

interface PlayerInfo {
    id: number; name: string; comment: string
    stamina: number; boostPoint: number; bossBoostPoint: number
    vmoney: number; freeVmoney: number; freeMana: number; paidMana: number
    rankPoint: number; starCrumb: number; bondToken: number
    expPool: number; degreeId: number; leaderCharacterId: number
    birth: number; enableAuto3x: boolean; tutorialStep: number | null
    lastLoginTime: string; staminaHealTime: string; expPooledTime: string; timeOffset: number | null
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

const resourceFields: { key: string; label: string }[] = [
    { key: "expPool", label: "经验池" },
    { key: "freeVmoney", label: "星导石(免费)" },
    { key: "vmoney", label: "星导石(付费)" },
    { key: "freeMana", label: "Mana(免费)" },
    { key: "paidMana", label: "Mana(付费)" },
    { key: "stamina", label: "体力" },
    { key: "rankPoint", label: "Rank" },
    { key: "starCrumb", label: "星屑" },
    { key: "bondToken", label: "羁绊证" },
    { key: "bossBoostPoint", label: "Boss Boost" },
    { key: "boostPoint", label: "Boost" },
]

const gridStyle: React.CSSProperties = { display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(200px, 1fr))", gap: 12 }

export default function PlayerDetail() {
    const { playerId } = useParams()
    const pid = Number(playerId)
    const navigate = useNavigate()
    const qc = useQueryClient()
    const [editValues, setEditValues] = useState<Record<string, any>>({})
    const [addCharCode, setAddCharCode] = useState<number | undefined>()
    const [addItemId, setAddItemId] = useState<number | undefined>()
    const [addItemCount, setAddItemCount] = useState<number>(1)
    const [searchChars, setSearchChars] = useState("")
    const [searchItems, setSearchItems] = useState("")
    const [searchEquip, setSearchEquip] = useState("")
    const [searchQuests, setSearchQuests] = useState("")
    const [searchDrawn, setSearchDrawn] = useState("")

    const { data, isLoading, isError } = useQuery({
        queryKey: ["playerDetail", pid],
        queryFn: () => apiGet<DetailData>(`/api/player/${pid}/detail`),
        enabled: !isNaN(pid),
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

    const addChar = useMutation({
        mutationFn: (code: number) => apiPost(`/api/player/${pid}/character`, { code }),
        onSuccess: () => { message.success("角色已添加"); setAddCharCode(undefined); refresh() },
        onError: (e: Error) => message.error(e.message),
    })

    const delChar = useMutation({
        mutationFn: (code: number) => apiDelete(`/api/player/${pid}/character/${code}`),
        onSuccess: () => { message.success("角色已删除"); refresh() },
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
    })

    const delQuestProgress = useMutation({
        mutationFn: ({ section, questId }: { section: number; questId: number }) =>
            apiDelete(`/api/player/${pid}/quest_progress/${section}/${questId}`),
        onSuccess: () => { message.success("关卡记录已删除"); refresh() },
    })

    const clearAllQuestProgress = useMutation({
        mutationFn: () => apiDelete(`/api/player/${pid}/quest_progress`),
        onSuccess: () => { message.success("全部关卡记录已清除"); refresh() },
    })

    const delDrawnQuest = useMutation({
        mutationFn: ({ category, questId }: { category: number; questId: number }) =>
            apiDelete(`/api/player/${pid}/drawn_quest/${category}/${questId}`),
        onSuccess: () => { message.success("抽选记录已删除"); refresh() },
    })

    const clearAllDrawnQuests = useMutation({
        mutationFn: () => apiDelete(`/api/player/${pid}/drawn_quest`),
        onSuccess: () => { message.success("全部抽选记录已清除"); refresh() },
    })

    const clearExBoost = useMutation({
        mutationFn: () => apiPost(`/api/player/${pid}/clear_ex_boost`),
        onSuccess: () => { message.success("EX Boost 已清除"); refresh() },
    })

    const clearReceiveHistory = useMutation({
        mutationFn: () => apiPost(`/api/player/${pid}/clear_receive_history`),
        onSuccess: () => { message.success("接收历史已清除"); refresh() },
        onError: (e: Error) => message.error(e.message),
    })

    const resetParties = useMutation({
        mutationFn: () => apiPost(`/api/player/${pid}/reset_parties`),
        onSuccess: () => { message.success("编队已重置"); refresh() },
    })

    const clearMail = useMutation({
        mutationFn: () => apiDelete(`/api/player/${pid}/mail`),
        onSuccess: () => { message.success("邮箱已清空"); refresh() },
    })

    const resetChallenge = useMutation({
        mutationFn: () => apiPost(`/api/player/${pid}/reset_challenge`),
        onSuccess: () => { message.success("每日挑战已重置"); refresh() },
    })

    const importSave = useMutation({
        mutationFn: (file: File) => apiUpload<{ ok: boolean }>(`/api/player/save?id=${pid}`, file),
        onSuccess: () => { message.success("存档已导入"); refresh() },
        onError: (e: Error) => message.error(e.message),
    })

    if (isNaN(pid)) return <Card><Text type="danger">无效的玩家 ID</Text></Card>
    if (isLoading) return <div style={{ textAlign: "center", marginTop: 100 }}><Spin size="large" /></div>
    if (isError || !data) return <Card><Text type="danger">加载失败</Text></Card>

    const { player, characters, items, equipment, questProgress, drawnQuests } = data

    // 内联可编辑数字字段（复用于资源/账号/时间偏移）
    const numField = (key: string, label: string, opts: { min?: number; allowNull?: boolean } = {}) => {
        const has = key in editValues
        const current = (player as any)[key]
        const shown = has ? editValues[key] : current
        const changed = has && editValues[key] !== current
        return (
            <div key={key}>
                <Text type="secondary" style={{ fontSize: 12 }}>{label}</Text>
                <Space.Compact style={{ width: "100%" }}>
                    <InputNumber
                        style={{ width: "100%" }}
                        size="small"
                        value={shown}
                        min={opts.min}
                        onChange={v => setEditValues(prev => ({ ...prev, [key]: v ?? (opts.allowNull ? null : (opts.min ?? 0)) }))}
                    />
                    {changed && (
                        <Button size="small" type="primary" icon={<SaveOutlined />}
                            loading={editField.isPending}
                            onClick={() => editField.mutate({ field: key, value: editValues[key] })}
                        />
                    )}
                </Space.Compact>
            </div>
        )
    }

    // 时间字段（DatePicker，改动即提交 ISO）
    const dateField = (key: string, label: string) => {
        const iso = (player as any)[key] as string | null
        return (
            <div key={key}>
                <Text type="secondary" style={{ fontSize: 12 }}>{label}</Text>
                <DatePicker
                    showTime
                    allowClear={false}
                    size="small"
                    style={{ width: "100%" }}
                    value={iso ? dayjs(iso) : null}
                    onChange={d => d && editField.mutate({ field: key, value: d.toISOString() })}
                />
            </div>
        )
    }

    const searchBox = (value: string, setValue: (s: string) => void) => (
        <Input allowClear size="small" prefix={<SearchOutlined />} placeholder="搜索名称或 ID"
            value={value} onChange={e => setValue(e.target.value)} style={{ width: 240 }} />
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
                    <Space wrap>
                        <InputNumber placeholder="角色 Code" value={addCharCode} onChange={v => setAddCharCode(v ?? undefined)} style={{ width: 140 }} />
                        <Button icon={<PlusOutlined />} onClick={() => addCharCode && addChar.mutate(addCharCode)}>添加角色</Button>
                        {searchBox(searchChars, setSearchChars)}
                    </Space>
                    <Table rowKey="code" dataSource={fChars} size="small" pagination={{ pageSize: 50 }}
                        columns={[
                            { title: "名字", render: (_, r: CharRow) => lookups?.characters[r.code]?.name ?? "?" },
                            { title: "称号", render: (_, r: CharRow) => lookups?.characters[r.code]?.title ?? "-", responsive: ["lg"] as any },
                            { title: "Code", dataIndex: "code", width: 80 },
                            { title: "稀有度", render: (_, r: CharRow) => lookups?.characters[r.code] ? `${lookups.characters[r.code].rarity} ${lookups.characters[r.code].element}` : "-", width: 100 },
                            { title: "入手时间", dataIndex: "joinTime", render: (t: string) => t.replace("T", " ").substring(0, 19), responsive: ["md"] as any },
                            {
                                title: "", width: 60,
                                render: (_, r: CharRow) => r.code === 1 ? <Tag>Alk</Tag> : (
                                    <Popconfirm title="删除此角色？" onConfirm={() => delChar.mutate(r.code)} okText="确认" cancelText="取消">
                                        <Button size="small" danger icon={<DeleteOutlined />} />
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
                    <Space wrap>
                        <InputNumber placeholder="道具 ID" value={addItemId} onChange={v => setAddItemId(v ?? undefined)} style={{ width: 120 }} />
                        <InputNumber placeholder="数量" value={addItemCount} onChange={v => setAddItemCount(v ?? 1)} min={0} style={{ width: 100 }} />
                        <Button icon={<PlusOutlined />} onClick={() => addItemId != null && addItem.mutate({ id: addItemId, count: addItemCount })}>添加/设置</Button>
                        {searchBox(searchItems, setSearchItems)}
                    </Space>
                    <Table rowKey="id" dataSource={fItems} size="small" pagination={{ pageSize: 50 }}
                        columns={[
                            { title: "名字", render: (_, r: ItemRow) => (lookups?.items as any)?.[r.id] ?? "-" },
                            { title: "ID", dataIndex: "id", width: 80 },
                            { title: "数量", dataIndex: "count", width: 100 },
                            {
                                title: "", width: 60,
                                render: (_, r: ItemRow) => (
                                    <Popconfirm title="删除此道具？" onConfirm={() => delItem.mutate(r.id)} okText="确认" cancelText="取消">
                                        <Button size="small" danger icon={<DeleteOutlined />} />
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
                    {searchBox(searchEquip, setSearchEquip)}
                    <Table rowKey="id" dataSource={fEquip} size="small" pagination={{ pageSize: 50 }}
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
                    <Space wrap>
                        <Popconfirm title="清除全部关卡进度？" onConfirm={() => clearAllQuestProgress.mutate()} okText="确认" cancelText="取消" okButtonProps={{ danger: true }}>
                            <Button danger size="small" icon={<DeleteOutlined />}>清除全部</Button>
                        </Popconfirm>
                        {searchBox(searchQuests, setSearchQuests)}
                    </Space>
                    <Table rowKey={(r: QuestRow) => `${r.section}_${r.questId}`} dataSource={fQuests} size="small" pagination={{ pageSize: 50 }}
                        columns={[
                            { title: "名字", render: (_, r: QuestRow) => (lookups?.quests as any)?.[`${r.section}_${r.questId}`] ?? "-" },
                            { title: "Section", dataIndex: "section", width: 80 },
                            { title: "Quest", dataIndex: "questId", width: 80 },
                            { title: "通关", render: (_, r: QuestRow) => r.finished ? "✅" : "—", width: 60 },
                            { title: "最高分", dataIndex: "highScore", render: (v: number | null) => v ?? "—", width: 80 },
                            { title: "评价", dataIndex: "clearRank", render: (v: number | null) => v ?? "—", width: 60 },
                            { title: "最佳时间", dataIndex: "bestElapsedTimeMs", render: (v: number | null) => v ?? "—", width: 100 },
                            {
                                title: "", width: 60,
                                render: (_, r: QuestRow) => (
                                    <Popconfirm title="删除此记录？" onConfirm={() => delQuestProgress.mutate({ section: r.section, questId: r.questId })} okText="确认" cancelText="取消">
                                        <Button size="small" danger icon={<DeleteOutlined />} />
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
                    <Space wrap>
                        <Popconfirm title="清除全部抽选记录？" onConfirm={() => clearAllDrawnQuests.mutate()} okText="确认" cancelText="取消" okButtonProps={{ danger: true }}>
                            <Button danger size="small" icon={<DeleteOutlined />}>清除全部</Button>
                        </Popconfirm>
                        {searchBox(searchDrawn, setSearchDrawn)}
                    </Space>
                    <Table rowKey={(r: DrawnQuestRow) => `${r.categoryId}_${r.questId}`} dataSource={fDrawn} size="small" pagination={{ pageSize: 50 }}
                        columns={[
                            { title: "名字", render: (_, r: DrawnQuestRow) => (lookups?.quests as any)?.[`${r.categoryId}_${r.questId}`] ?? "-" },
                            { title: "Category", dataIndex: "categoryId", width: 80 },
                            { title: "Quest", dataIndex: "questId", width: 80 },
                            { title: "Odds", dataIndex: "oddsId", width: 80 },
                            {
                                title: "", width: 60,
                                render: (_, r: DrawnQuestRow) => (
                                    <Popconfirm title="删除此记录？" onConfirm={() => delDrawnQuest.mutate({ category: r.categoryId, questId: r.questId })} okText="确认" cancelText="取消">
                                        <Button size="small" danger icon={<DeleteOutlined />} />
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
        <Space direction="vertical" size="large" style={{ width: "100%" }}>
            <Card title={`${player.name} (#${player.id})`} extra={<Button onClick={() => navigate("/accounts")}>返回列表</Button>}>
                <Space direction="vertical" size="middle" style={{ width: "100%" }}>
                    <Descriptions bordered size="small" column={{ xs: 1, sm: 2, lg: 3 }}>
                        <Descriptions.Item label="等级">{player.degreeId}</Descriptions.Item>
                        <Descriptions.Item label="签名">{player.comment || "-"}</Descriptions.Item>
                        <Descriptions.Item label="最后登录">{player.lastLoginTime.replace("T", " ").substring(0, 19)}</Descriptions.Item>
                        <Descriptions.Item label="队长角色">{player.leaderCharacterId}</Descriptions.Item>
                        <Descriptions.Item label="生日">{player.birth}</Descriptions.Item>
                        <Descriptions.Item label="3x加速">{player.enableAuto3x ? "开" : "关"}</Descriptions.Item>
                        <Descriptions.Item label="教程步骤">{player.tutorialStep ?? "无"}</Descriptions.Item>
                    </Descriptions>

                    <Card type="inner" title="资源编辑" size="small">
                        <div style={gridStyle}>
                            {resourceFields.map(f => numField(f.key, f.label, { min: 0 }))}
                        </div>
                    </Card>

                    <Card type="inner" title="账号设置" size="small">
                        <div style={gridStyle}>
                            <div>
                                <Text type="secondary" style={{ fontSize: 12 }}>3x加速</Text>
                                <div>
                                    <Switch checked={player.enableAuto3x} loading={editField.isPending}
                                        onChange={v => editField.mutate({ field: "enableAuto3x", value: v })} />
                                </div>
                            </div>
                            {numField("degreeId", "等级(称号ID)", { min: 0 })}
                            {numField("leaderCharacterId", "队长角色ID", { min: 0 })}
                            {numField("birth", "生日(birth)", { min: 0 })}
                            {numField("tutorialStep", "教程步骤(空=null)", { min: 0, allowNull: true })}
                        </div>
                    </Card>

                    <Card type="inner" title="时间设置" size="small">
                        <div style={gridStyle}>
                            {dateField("staminaHealTime", "体力恢复时间")}
                            {dateField("lastLoginTime", "最后登录时间")}
                            {dateField("expPooledTime", "经验池结算时间")}
                            {numField("timeOffset", "时间偏移(ms，空=null)", { allowNull: true })}
                        </div>
                    </Card>

                    <Card type="inner" title="工具操作" size="small">
                        <Space wrap>
                            <Popconfirm title="清除全部 EX Boost？" onConfirm={() => clearExBoost.mutate()} okText="确认" cancelText="取消">
                                <Button size="small">清除 EX Boost</Button>
                            </Popconfirm>
                            <Popconfirm title="重置编队到默认？" onConfirm={() => resetParties.mutate()} okText="确认" cancelText="取消">
                                <Button size="small" icon={<UndoOutlined />}>重置编队</Button>
                            </Popconfirm>
                            <Popconfirm title="清空邮箱？" onConfirm={() => clearMail.mutate()} okText="确认" cancelText="取消" okButtonProps={{ danger: true }}>
                                <Button size="small" danger>清空邮箱</Button>
                            </Popconfirm>
                            <Popconfirm title="重置每日挑战点？" onConfirm={() => resetChallenge.mutate()} okText="确认" cancelText="取消">
                                <Button size="small" icon={<UndoOutlined />}>重置每日挑战</Button>
                            </Popconfirm>
                            <Popconfirm title="清除接收历史（一次性道具的领取记录）？" onConfirm={() => clearReceiveHistory.mutate()} okText="确认" cancelText="取消">
                                <Button size="small" loading={clearReceiveHistory.isPending}>清除接收历史</Button>
                            </Popconfirm>
                            <Button size="small" icon={<DownloadOutlined />} href={`/api/player/save?id=${pid}`} target="_blank">导出存档</Button>
                            <Upload accept=".json,application/json" showUploadList={false} maxCount={1}
                                beforeUpload={file => { importSave.mutate(file); return false }}>
                                <Button size="small" icon={<UploadOutlined />} danger loading={importSave.isPending}>导入存档(覆盖)</Button>
                            </Upload>
                        </Space>
                    </Card>
                </Space>
            </Card>

            <Card>
                <Tabs items={tabItems} />
            </Card>
        </Space>
    )
}
