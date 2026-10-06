import { useEffect, useRef, useState, type ReactNode } from "react"
import { Alert, Button, Card, InputNumber, Popconfirm, Skeleton, Space, Switch, Typography, Upload, message } from "antd"
import { SaveOutlined, UploadOutlined } from "@ant-design/icons"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"

import { apiDelete, apiGet, apiPatch, apiUpload } from "../api/client"
import { AdminPage } from "../components/AdminPage"

interface GameplaySettings {
    dropMultiplier: number
    multiRescueFragmentRewardsEnabled: boolean
    multiRescueHostRewardsEnabled: boolean
    rush700011To700017CompatibilityEnabled: boolean
    multiRandomRecruitmentPublishEnabled: boolean
    multiNpcReleaseSeconds: number
    multiNpcCloseRecruitmentAfterFill: boolean
    multiNpcOneShotLifecycle: boolean
    updatedAt: string
}

interface DefaultSaveStats {
    rank?: number
    characterCount?: number
    equipmentCount?: number
}

interface DefaultSaveMeta {
    exists: boolean
    playerName?: string | null
    exportedAt?: string | null
    sourcePlayerId?: number | null
    stats?: DefaultSaveStats
}

export default function GameplaySettings() {
    const queryClient = useQueryClient()
    const [draftMultiplier, setDraftMultiplier] = useState<number | null>(null)
    const [draftRescueEnabled, setDraftRescueEnabled] = useState<boolean | null>(null)
    const [draftHostRescueEnabled, setDraftHostRescueEnabled] = useState<boolean | null>(null)
    const [draftRushCompatibilityEnabled, setDraftRushCompatibilityEnabled] = useState<boolean | null>(null)
    // 保存成功反馈：卡片标题旁「已保存 ✓」2 秒（纯前端状态）
    const [savedFlash, setSavedFlash] = useState<string | null>(null)
    const flashTimers = useRef<Record<string, number>>({})
    const flashSaved = (key: string) => {
        setSavedFlash(key)
        window.clearTimeout(flashTimers.current[key])
        flashTimers.current[key] = window.setTimeout(() => {
            setSavedFlash(current => current === key ? null : current)
        }, 2000)
    }
    const settings = useQuery({
        queryKey: ["serverGameplaySettings"],
        queryFn: () => apiGet<GameplaySettings>("/api/server/settings/gameplay"),
    })

    const { data: defSave } = useQuery({
        queryKey: ["defaultSave"],
        queryFn: () => apiGet<DefaultSaveMeta>("/api/server/defaultSave"),
    })

    const uploadDefault = useMutation({
        mutationFn: (file: File) => apiUpload("/api/server/defaultSave", file),
        onSuccess: () => { message.success("当前存档已设置"); queryClient.invalidateQueries({ queryKey: ["defaultSave"] }) },
        onError: (e: Error) => message.error(e.message),
    })

    const clearDefault = useMutation({
        mutationFn: () => apiDelete("/api/server/defaultSave"),
        onSuccess: () => { message.success("当前存档已清除"); queryClient.invalidateQueries({ queryKey: ["defaultSave"] }) },
        onError: (e: Error) => message.error(e.message),
    })

    const saveMultiplier = useMutation({
        mutationFn: (dropMultiplier: number) => apiPatch<GameplaySettings>(
            "/api/server/settings/gameplay",
            { dropMultiplier },
        ),
        onSuccess: value => {
            queryClient.setQueryData(["serverGameplaySettings"], value)
            setDraftMultiplier(value.dropMultiplier)
            flashSaved("multiplier")
            message.success("游戏设置已保存")
        },
        onError: (error: Error) => message.error(error.message),
    })
    const saveRescueSetting = useMutation({
        mutationFn: (multiRescueFragmentRewardsEnabled: boolean) => apiPatch<GameplaySettings>(
            "/api/server/settings/gameplay",
            { multiRescueFragmentRewardsEnabled },
        ),
        onSuccess: value => {
            queryClient.setQueryData(["serverGameplaySettings"], value)
            setDraftRescueEnabled(value.multiRescueFragmentRewardsEnabled)
            flashSaved("rescue")
            message.success("游戏设置已保存")
        },
        onError: (error: Error) => message.error(error.message),
    })
    const saveHostRescueSetting = useMutation({
        mutationFn: (multiRescueHostRewardsEnabled: boolean) => apiPatch<GameplaySettings>(
            "/api/server/settings/gameplay",
            { multiRescueHostRewardsEnabled },
        ),
        onSuccess: value => {
            queryClient.setQueryData(["serverGameplaySettings"], value)
            setDraftHostRescueEnabled(value.multiRescueHostRewardsEnabled)
            flashSaved("hostRescue")
            message.success("游戏设置已保存")
        },
        onError: (error: Error) => message.error(error.message),
    })
    const saveRushCompatibilitySetting = useMutation({
        mutationFn: (rush700011To700017CompatibilityEnabled: boolean) => apiPatch<GameplaySettings>(
            "/api/server/settings/gameplay",
            { rush700011To700017CompatibilityEnabled },
        ),
        onSuccess: value => {
            queryClient.setQueryData(["serverGameplaySettings"], value)
            setDraftRushCompatibilityEnabled(value.rush700011To700017CompatibilityEnabled)
            flashSaved("rushCompatibility")
            message.success("游戏设置已保存")
        },
        onError: (error: Error) => message.error(error.message),
    })
    // 联机招募模式卡片：四参数一次原子保存（发布关闭时 W/兜后置灰但仍随保存提交）
    const saveRecruitmentMode = useMutation({
        mutationFn: (payload: {
            multiRandomRecruitmentPublishEnabled: boolean
            multiNpcReleaseSeconds: number
            multiNpcCloseRecruitmentAfterFill: boolean
            multiNpcOneShotLifecycle: boolean
        }) => apiPatch<GameplaySettings>("/api/server/settings/gameplay", payload),
        onSuccess: value => {
            queryClient.setQueryData(["serverGameplaySettings"], value)
            setDraftRecruitment(projectRecruitmentDraft(value))
            flashSaved("recruitmentMode")
            message.success("游戏设置已保存")
        },
        onError: (error: Error) => message.error(error.message),
    })

    useEffect(() => {
        if (settings.data) setDraftMultiplier(settings.data.dropMultiplier)
        if (settings.data) setDraftRescueEnabled(settings.data.multiRescueFragmentRewardsEnabled)
        if (settings.data) setDraftHostRescueEnabled(settings.data.multiRescueHostRewardsEnabled)
        if (settings.data) setDraftRushCompatibilityEnabled(settings.data.rush700011To700017CompatibilityEnabled)
        if (settings.data) setDraftRecruitment(projectRecruitmentDraft(settings.data))
    }, [settings.data])

    // ---- 联机招募模式（参数为真相，模式为派生标签） ----
    interface RecruitmentDraft {
        multiRandomRecruitmentPublishEnabled: boolean
        multiNpcReleaseSeconds: number
        multiNpcCloseRecruitmentAfterFill: boolean
        multiNpcOneShotLifecycle: boolean
    }
    const [draftRecruitment, setDraftRecruitment] = useState<RecruitmentDraft | null>(null)
    // 草稿只投影本卡片 4 个参数——携带 updatedAt 等其余键会被后端按未知字段拒绝
    const projectRecruitmentDraft = (value: GameplaySettings): RecruitmentDraft => ({
        multiRandomRecruitmentPublishEnabled: value.multiRandomRecruitmentPublishEnabled,
        multiNpcReleaseSeconds: value.multiNpcReleaseSeconds,
        multiNpcCloseRecruitmentAfterFill: value.multiNpcCloseRecruitmentAfterFill,
        multiNpcOneShotLifecycle: value.multiNpcOneShotLifecycle,
    })
    const applyRecruitmentPreset = (preset: "npc" | "official") => {
        if (preset === "npc") {
            setDraftRecruitment({
                multiRandomRecruitmentPublishEnabled: false,
                multiNpcReleaseSeconds: 0,
                multiNpcCloseRecruitmentAfterFill: true,
                multiNpcOneShotLifecycle: false,
            })
        } else {
            setDraftRecruitment({
                multiRandomRecruitmentPublishEnabled: true,
                multiNpcReleaseSeconds: 0,
                multiNpcCloseRecruitmentAfterFill: true,
                multiNpcOneShotLifecycle: true,
            })
        }
    }
    const savedRecruitment = settings.data
    const recruitmentUnchanged = draftRecruitment === null || savedRecruitment === undefined
        || (draftRecruitment.multiRandomRecruitmentPublishEnabled === savedRecruitment.multiRandomRecruitmentPublishEnabled
            && draftRecruitment.multiNpcReleaseSeconds === savedRecruitment.multiNpcReleaseSeconds
            && draftRecruitment.multiNpcCloseRecruitmentAfterFill === savedRecruitment.multiNpcCloseRecruitmentAfterFill
            && draftRecruitment.multiNpcOneShotLifecycle === savedRecruitment.multiNpcOneShotLifecycle)
    // 派生标签按已保存值计算（草稿不参与——标签描述"线上正在跑什么"）
    const recruitmentModeBadge = savedRecruitment === undefined
        ? { text: "-" }
        : !savedRecruitment.multiRandomRecruitmentPublishEnabled
            ? { text: "NPC" }
            : savedRecruitment.multiNpcReleaseSeconds === 0
                && savedRecruitment.multiNpcCloseRecruitmentAfterFill
                && savedRecruitment.multiNpcOneShotLifecycle
                ? { text: "官服" }
                : { text: "自定义" }
    const publishOn = (draftRecruitment ?? savedRecruitment)?.multiRandomRecruitmentPublishEnabled ?? false
    // NPC 自动续战 = multiNpcOneShotLifecycle 的反向 UI 语义（开=跨战斗保留续战）
    const autoRematchOn = !((draftRecruitment ?? savedRecruitment)?.multiNpcOneShotLifecycle ?? false)

    const currentMultiplier = settings.data?.dropMultiplier
    const unchanged = draftMultiplier === null || draftMultiplier === currentMultiplier
    const rescueUnchanged = draftRescueEnabled === null
        || draftRescueEnabled === settings.data?.multiRescueFragmentRewardsEnabled
    const hostRescueUnchanged = draftHostRescueEnabled === null
        || draftHostRescueEnabled === settings.data?.multiRescueHostRewardsEnabled
    const rushCompatibilityUnchanged = draftRushCompatibilityEnabled === null
        || draftRushCompatibilityEnabled === settings.data?.rush700011To700017CompatibilityEnabled

    // 卡片标题：未保存圆点（有改动未保存）+ 保存成功后的 2 秒「已保存 ✓」反馈
    const cardTitle = (title: ReactNode, dirty: boolean, flashKey: string) => (
        <span className="admin-settings-card-title">
            {title}
            {dirty && <span className="admin-dirty-dot" role="img" aria-label="有未保存修改" title="有未保存修改" />}
            {savedFlash === flashKey && <span className="admin-saved-flash">已保存 ✓</span>}
        </span>
    )

    // 页头刷新：设置值 + 当前存档模板一并失效重取
    const refreshSettings = () => {
        queryClient.invalidateQueries({ queryKey: ["serverGameplaySettings"] })
        queryClient.invalidateQueries({ queryKey: ["defaultSave"] })
    }

    return (
        <AdminPage
            eyebrow="SETTINGS"
            title="游戏设置"
            description="调整服务端运行时游戏规则，保存后无需重启。"
            onRefresh={refreshSettings}
            refreshing={settings.isFetching}
        >
            {settings.isLoading ? (
                <Card title="关卡固定掉落倍率">
                    <Skeleton active paragraph={{ rows: 2 }} />
                </Card>
            ) : settings.isError ? (
                <Alert
                    type="error"
                    showIcon
                    message="无法读取游戏设置"
                    action={<Button onClick={() => settings.refetch()}>重试</Button>}
                />
            ) : (
                <Space direction="vertical" size="large" className="admin-stack">
                    <Card
                        title={cardTitle("关卡固定掉落倍率", !unchanged, "multiplier")}
                        extra={currentMultiplier !== undefined
                            && <span className="admin-badge-ok">当前 {currentMultiplier} 倍</span>}
                    >
                        <Space direction="vertical" size="middle" className="admin-stack">
                            <Space wrap align="center">
                                <Typography.Text>倍率</Typography.Text>
                                <InputNumber
                                    min={1}
                                    max={10}
                                    precision={0}
                                    value={draftMultiplier}
                                    onChange={value => setDraftMultiplier(value)}
                                    aria-label="关卡固定掉落倍率"
                                />
                                <Button
                                    type="primary"
                                    icon={<SaveOutlined />}
                                    disabled={unchanged}
                                    loading={saveMultiplier.isPending}
                                    onClick={() => draftMultiplier !== null
                                        && saveMultiplier.mutate(draftMultiplier)}
                                >
                                    保存
                                </Button>
                            </Space>
                            <div className="admin-page-note">
                                <Typography.Text type="secondary">
                                    影响固定道具、玛纳、经验、属性素材和以太素材；不改变稀有掉落概率。
                                </Typography.Text>
                            </div>
                        </Space>
                    </Card>
                    <Card
                        title={cardTitle("本服玩家：所有多人房间救援资格", !rescueUnchanged, "rescue")}
                    >
                        <Space direction="vertical" size="middle" className="admin-stack">
                            <Space wrap align="center">
                                <Switch
                                    checked={draftRescueEnabled ?? false}
                                    onChange={value => setDraftRescueEnabled(value)}
                                    aria-label="本服玩家：所有多人房间救援资格"
                                />
                                <Button
                                    type="primary"
                                    icon={<SaveOutlined />}
                                    disabled={rescueUnchanged}
                                    loading={saveRescueSetting.isPending}
                                    onClick={() => draftRescueEnabled !== null
                                        && saveRescueSetting.mutate(draftRescueEnabled)}
                                >
                                    保存
                                </Button>
                            </Space>
                            <div className="admin-page-note">
                                <Typography.Text type="secondary">
                                    开启后只影响本服所属真人玩家，不改变其他服务器、不发布铃铛。
                                </Typography.Text>
                            </div>
                        </Space>
                    </Card>
                    <Card
                        title={cardTitle("本服玩家：房主救援身份", !hostRescueUnchanged, "hostRescue")}
                    >
                        <Space direction="vertical" size="middle" className="admin-stack">
                            <Space wrap align="center">
                                <Switch
                                    checked={draftHostRescueEnabled ?? false}
                                    onChange={value => setDraftHostRescueEnabled(value)}
                                    aria-label="本服玩家：房主救援身份"
                                />
                                <Button
                                    type="primary"
                                    icon={<SaveOutlined />}
                                    disabled={hostRescueUnchanged}
                                    loading={saveHostRescueSetting.isPending}
                                    onClick={() => draftHostRescueEnabled !== null
                                        && saveHostRescueSetting.mutate(draftHostRescueEnabled)}
                                >
                                    保存
                                </Button>
                            </Space>
                            <div className="admin-page-note">
                                <Typography.Text type="secondary">
                                    开启后允许本服房主自救；当前还要求第一开关开启。
                                </Typography.Text>
                            </div>
                        </Space>
                    </Card>
                    <Card
                        title={cardTitle("Rush 私服兼容", !rushCompatibilityUnchanged, "rushCompatibility")}
                    >
                        <Space direction="vertical" size="middle" className="admin-stack">
                            <Space wrap align="center">
                                <Switch
                                    checked={draftRushCompatibilityEnabled ?? false}
                                    onChange={value => setDraftRushCompatibilityEnabled(value)}
                                    aria-label="狂热激战常驻批次（700011–700017）私服兼容"
                                />
                                <Button
                                    type="primary"
                                    icon={<SaveOutlined />}
                                    disabled={rushCompatibilityUnchanged}
                                    loading={saveRushCompatibilitySetting.isPending}
                                    onClick={() => draftRushCompatibilityEnabled !== null
                                        && saveRushCompatibilitySetting.mutate(draftRushCompatibilityEnabled)}
                                >
                                    保存
                                </Button>
                            </Space>
                            <div className="admin-page-note">
                                <Typography.Text type="secondary">
                                    开启后 700011–700017 复用 700001–700007 的文件夹奖励、商店与购买期；关闭后完全回到官方末期空奖励、空商店行为。整体开关，无部分开启状态。
                                </Typography.Text>
                            </div>
                        </Space>
                    </Card>
                    <Card
                        title={cardTitle(
                            <span>
                                联机招募模式
                                <span
                                    className={recruitmentModeBadge.text === "自定义" ? "admin-badge-muted" : "admin-badge-ok"}
                                    style={{ marginLeft: 8 }}
                                    role="img"
                                    aria-label={`当前模式：${recruitmentModeBadge.text}`}
                                >
                                    {recruitmentModeBadge.text}
                                </span>
                            </span>,
                            !recruitmentUnchanged,
                            "recruitmentMode",
                        )}
                    >
                        <Space direction="vertical" size="middle" className="admin-stack">
                            <Space wrap align="center">
                                <Button onClick={() => applyRecruitmentPreset("npc")}>NPC 快速预设</Button>
                                <Button onClick={() => applyRecruitmentPreset("official")}>官服还原预设</Button>
                            </Space>
                            <Space wrap align="center">
                                <Typography.Text style={{ minWidth: 160, display: "inline-block" }}>随机招募铃铛</Typography.Text>
                                <Switch
                                    checked={publishOn}
                                    onChange={value => setDraftRecruitment(current => current && {
                                        ...current,
                                        multiRandomRecruitmentPublishEnabled: value,
                                    })}
                                    aria-label="随机招募铃铛发布"
                                />
                            </Space>
                            <Space wrap align="center">
                                <Typography.Text style={{ minWidth: 160, display: "inline-block" }}>等待NPC加入时长</Typography.Text>
                                <InputNumber
                                    min={0}
                                    max={3600}
                                    precision={0}
                                    disabled={!publishOn}
                                    value={draftRecruitment?.multiNpcReleaseSeconds ?? 0}
                                    onChange={value => setDraftRecruitment(current => current && {
                                        ...current,
                                        multiNpcReleaseSeconds: Number(value) || 0,
                                    })}
                                    aria-label="等待NPC加入时长（秒）"
                                    addonAfter="秒"
                                />
                                <Typography.Text type="secondary">铃铛广播时长；窗口内无人加入才由服务端补 NPC</Typography.Text>
                            </Space>
                            <Space wrap align="center">
                                <Typography.Text style={{ minWidth: 160, display: "inline-block" }}>NPC 补位后关闭招募</Typography.Text>
                                <Switch
                                    checked={(draftRecruitment ?? savedRecruitment)?.multiNpcCloseRecruitmentAfterFill ?? true}
                                    disabled={!publishOn}
                                    onChange={value => setDraftRecruitment(current => current && {
                                        ...current,
                                        multiNpcCloseRecruitmentAfterFill: value,
                                    })}
                                    aria-label="NPC 补位后关闭招募"
                                />
                                <Typography.Text type="secondary">开：NPC 进场后停止广播铃铛；关：继续广播，真人可进房替换 NPC（房间号直进不受影响）</Typography.Text>
                            </Space>
                            <Space wrap align="center">
                                <Typography.Text style={{ minWidth: 160, display: "inline-block" }}>NPC 自动续战</Typography.Text>
                                <Switch
                                    checked={autoRematchOn}
                                    onChange={value => setDraftRecruitment(current => current && {
                                        ...current,
                                        multiNpcOneShotLifecycle: !value,
                                    })}
                                    aria-label="NPC 自动续战"
                                />
                                                            </Space>
                            <Space wrap align="center">
                                <Button
                                    type="primary"
                                    icon={<SaveOutlined />}
                                    disabled={recruitmentUnchanged || draftRecruitment === null}
                                    loading={saveRecruitmentMode.isPending}
                                    onClick={() => draftRecruitment !== null && saveRecruitmentMode.mutate(draftRecruitment)}
                                >
                                    保存
                                </Button>
                            </Space>
                            <div className="admin-page-note">
                                <Typography.Text type="secondary">
                                    切换即时生效，不影响已开房间。
                                </Typography.Text>
                            </div>
                        </Space>
                    </Card>
                    <Card
                        title="当前存档"
                    >
                        <Space direction="vertical" size="middle" className="admin-stack">
                            {/* B1/B2：状态徽章在卡体首行（标题区不放状态）；未设置=muted、已设置=ok */}
                            <Space wrap size={4}>
                                {defSave?.exists
                                    ? <span className="admin-badge-ok">已设置</span>
                                    : <span className="admin-badge-muted">未设置（新建存档为空档）</span>}
                            </Space>
                            <div className="admin-page-note">
                                <Typography.Text type="secondary">
                                    上传玩家详情页「导出存档」得到的 JSON。之后任意账户「新建存档」时，将用它替换空存档。
                                </Typography.Text>
                            </div>
                            {defSave?.exists && (
                                <Space wrap size={4}>
                                    <Typography.Text>模板玩家：{defSave.playerName || "-"}</Typography.Text>
                                    {defSave.exportedAt && (
                                        <Typography.Text type="secondary">
                                            导出于 {new Date(defSave.exportedAt).toLocaleString("zh-CN")}
                                        </Typography.Text>
                                    )}
                                </Space>
                            )}
                            {defSave?.exists && (
                                <div className="admin-default-save-stats">
                                    <div className="admin-default-save-stat">
                                        <span className="admin-default-save-stat-label">等级</span>
                                        <span className="admin-default-save-stat-value">{defSave.stats?.rank ?? "-"}</span>
                                    </div>
                                    <div className="admin-default-save-stat">
                                        <span className="admin-default-save-stat-label">角色数</span>
                                        <span className="admin-default-save-stat-value">
                                            {defSave.stats?.characterCount?.toLocaleString("zh-CN") ?? "-"}
                                        </span>
                                    </div>
                                    <div className="admin-default-save-stat">
                                        <span className="admin-default-save-stat-label">装备数</span>
                                        <span className="admin-default-save-stat-value">
                                            {defSave.stats?.equipmentCount?.toLocaleString("zh-CN") ?? "-"}
                                        </span>
                                    </div>
                                </div>
                            )}
                            <Space wrap>
                                <Upload
                                    showUploadList={false}
                                    accept=".json"
                                    beforeUpload={(file) => { uploadDefault.mutate(file as File); return false }}
                                >
                                    <Button icon={<UploadOutlined />} loading={uploadDefault.isPending}>
                                        {defSave?.exists ? "替换当前存档" : "上传当前存档"}
                                    </Button>
                                </Upload>
                                {defSave?.exists && (
                                    <Popconfirm
                                        title="清除当前存档？之后新建存档将为空档。"
                                        onConfirm={() => clearDefault.mutate()}
                                        okText="确认" cancelText="取消" okButtonProps={{ danger: true }}
                                    >
                                        <Button type="text" danger loading={clearDefault.isPending}>清除</Button>
                                    </Popconfirm>
                                )}
                            </Space>
                        </Space>
                    </Card>
                </Space>
            )}
            <div className="admin-page-note admin-page-note-footer">
                <Typography.Text strong>保存方式说明</Typography.Text>
                <Typography.Text type="secondary">
                    各设置项独立保存：修改后对应卡片内的「保存」按钮才可用，保存后立即生效。
                </Typography.Text>
            </div>
        </AdminPage>
    )
}
