import { useEffect, useState } from "react"
import { Alert, Button, Card, InputNumber, Skeleton, Space, Switch, Tag, Typography, message } from "antd"
import { SaveOutlined } from "@ant-design/icons"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"

import { apiGet, apiPatch } from "../api/client"
import { AdminPage } from "../components/AdminPage"

interface GameplaySettings {
    dropMultiplier: number
    multiRescueFragmentRewardsEnabled: boolean
    multiRescueHostRewardsEnabled: boolean
    updatedAt: string
}
export default function GameplaySettings() {
    const queryClient = useQueryClient()
    const [draftMultiplier, setDraftMultiplier] = useState<number | null>(null)
    const [draftRescueEnabled, setDraftRescueEnabled] = useState<boolean | null>(null)
    const [draftHostRescueEnabled, setDraftHostRescueEnabled] = useState<boolean | null>(null)
    const settings = useQuery({
        queryKey: ["serverGameplaySettings"],
        queryFn: () => apiGet<GameplaySettings>("/api/server/settings/gameplay"),
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

    useEffect(() => {
        if (settings.data) setDraftMultiplier(settings.data.dropMultiplier)
        if (settings.data) setDraftRescueEnabled(settings.data.multiRescueFragmentRewardsEnabled)
        if (settings.data) setDraftHostRescueEnabled(settings.data.multiRescueHostRewardsEnabled)
    }, [settings.data])

    const currentMultiplier = settings.data?.dropMultiplier
    const unchanged = draftMultiplier === null || draftMultiplier === currentMultiplier
    const rescueUnchanged = draftRescueEnabled === null
        || draftRescueEnabled === settings.data?.multiRescueFragmentRewardsEnabled
    const hostRescueUnchanged = draftHostRescueEnabled === null
        || draftHostRescueEnabled === settings.data?.multiRescueHostRewardsEnabled

    return (
        <AdminPage
            eyebrow="Gameplay"
            title="游戏设置"
            description="调整服务端运行时游戏规则，保存后无需重启。"
        >
            <Card
                title="关卡固定掉落倍率"
                extra={currentMultiplier !== undefined && <Tag color="green">当前 {currentMultiplier} 倍</Tag>}
            >
                {settings.isLoading ? (
                    <Skeleton active paragraph={{ rows: 2 }} />
                ) : settings.isError ? (
                    <Alert
                        type="error"
                        showIcon
                        message="无法读取游戏设置"
                        action={<Button onClick={() => settings.refetch()}>重试</Button>}
                    />
                ) : (
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
                        <Alert
                            type="info"
                            showIcon
                            message="影响固定道具、玛纳、经验、属性素材和以太素材；不改变稀有掉落概率。"
                        />
                        <Space wrap align="center">
                            <Typography.Text>本服玩家：所有多人房间救援资格</Typography.Text>
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
                        <Alert
                            type="info"
                            showIcon
                            message="开启后只影响本服所属真人玩家，不改变其他服务器、不发布铃铛。"
                        />
                        <Space wrap align="center">
                            <Typography.Text>本服玩家：房主允许自救</Typography.Text>
                            <Switch
                                checked={draftHostRescueEnabled ?? false}
                                onChange={value => setDraftHostRescueEnabled(value)}
                                aria-label="本服玩家：房主允许自救"
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
                        <Alert
                            type="info"
                            showIcon
                            message="开启后允许本服房主自救；当前还要求第一开关开启。"
                        />
                    </Space>
                )}
            </Card>
        </AdminPage>
    )
}
