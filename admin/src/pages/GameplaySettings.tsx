import { useEffect, useState } from "react"
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
    updatedAt: string
}

interface DefaultSaveMeta {
    exists: boolean
    playerName?: string | null
    exportedAt?: string | null
    sourcePlayerId?: number | null
}
export default function GameplaySettings() {
    const queryClient = useQueryClient()
    const [draftMultiplier, setDraftMultiplier] = useState<number | null>(null)
    const [draftRescueEnabled, setDraftRescueEnabled] = useState<boolean | null>(null)
    const [draftHostRescueEnabled, setDraftHostRescueEnabled] = useState<boolean | null>(null)
    const [draftRushCompatibilityEnabled, setDraftRushCompatibilityEnabled] = useState<boolean | null>(null)
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
        onSuccess: () => { message.success("默认存档已设置"); queryClient.invalidateQueries({ queryKey: ["defaultSave"] }) },
        onError: (e: Error) => message.error(e.message),
    })

    const clearDefault = useMutation({
        mutationFn: () => apiDelete("/api/server/defaultSave"),
        onSuccess: () => { message.success("默认存档已清除"); queryClient.invalidateQueries({ queryKey: ["defaultSave"] }) },
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
            message.success("游戏设置已保存")
        },
        onError: (error: Error) => message.error(error.message),
    })

    useEffect(() => {
        if (settings.data) setDraftMultiplier(settings.data.dropMultiplier)
        if (settings.data) setDraftRescueEnabled(settings.data.multiRescueFragmentRewardsEnabled)
        if (settings.data) setDraftHostRescueEnabled(settings.data.multiRescueHostRewardsEnabled)
        if (settings.data) setDraftRushCompatibilityEnabled(settings.data.rush700011To700017CompatibilityEnabled)
    }, [settings.data])

    const currentMultiplier = settings.data?.dropMultiplier
    const unchanged = draftMultiplier === null || draftMultiplier === currentMultiplier
    const rescueUnchanged = draftRescueEnabled === null
        || draftRescueEnabled === settings.data?.multiRescueFragmentRewardsEnabled
    const hostRescueUnchanged = draftHostRescueEnabled === null
        || draftHostRescueEnabled === settings.data?.multiRescueHostRewardsEnabled
    const rushCompatibilityUnchanged = draftRushCompatibilityEnabled === null
        || draftRushCompatibilityEnabled === settings.data?.rush700011To700017CompatibilityEnabled

    return (
        <AdminPage
            eyebrow="SETTINGS"
            title="游戏设置"
            description="调整服务端运行时游戏规则，保存后无需重启。"
        >
            <div className="admin-page-note">
                <Typography.Text strong>保存方式说明</Typography.Text>
                <Typography.Text type="secondary">
                    各设置项独立保存：修改后对应卡片内的「保存」按钮才可用，保存后立即生效。
                </Typography.Text>
            </div>
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
                        title="关卡固定掉落倍率"
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
                        title="本服玩家：所有多人房间救援资格"
                        extra={(
                            <span className={settings.data?.multiRescueFragmentRewardsEnabled
                                ? "admin-badge-ok"
                                : "admin-badge-info"}
                            >
                                {settings.data?.multiRescueFragmentRewardsEnabled ? "已开启" : "已关闭"}
                            </span>
                        )}
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
                        title="本服玩家：房主救援身份"
                        extra={(
                            <span className={settings.data?.multiRescueHostRewardsEnabled
                                ? "admin-badge-ok"
                                : "admin-badge-info"}
                            >
                                {settings.data?.multiRescueHostRewardsEnabled ? "已开启" : "已关闭"}
                            </span>
                        )}
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
                        title="Rush 私服兼容"
                        extra={(
                            <span className={settings.data?.rush700011To700017CompatibilityEnabled
                                ? "admin-badge-ok"
                                : "admin-badge-info"}
                            >
                                {settings.data?.rush700011To700017CompatibilityEnabled ? "已开启" : "已关闭"}
                            </span>
                        )}
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
                        title="当前默认存档"
                        extra={defSave?.exists
                            ? <span className="admin-badge-ok">已设置</span>
                            : <span className="admin-badge-info">未设置（新建存档为空档）</span>}
                    >
                        <Space direction="vertical" size="middle" className="admin-stack">
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
                            <Space wrap>
                                <Upload
                                    showUploadList={false}
                                    accept=".json"
                                    beforeUpload={(file) => { uploadDefault.mutate(file as File); return false }}
                                >
                                    <Button icon={<UploadOutlined />} loading={uploadDefault.isPending}>
                                        {defSave?.exists ? "替换默认存档" : "上传默认存档"}
                                    </Button>
                                </Upload>
                                {defSave?.exists && (
                                    <Popconfirm
                                        title="清除默认存档？之后新建存档将为空档。"
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
        </AdminPage>
    )
}
