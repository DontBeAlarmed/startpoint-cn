import { useEffect, useState } from "react"
import { Alert, Button, Card, InputNumber, Skeleton, Space, Tag, Typography, message } from "antd"
import { SaveOutlined } from "@ant-design/icons"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"

import { apiGet, apiPatch } from "../api/client"
import { AdminPage } from "../components/AdminPage"

interface GameplaySettings {
    dropMultiplier: number
    updatedAt: string
}
export default function GameplaySettings() {
    const queryClient = useQueryClient()
    const [draftMultiplier, setDraftMultiplier] = useState<number | null>(null)
    const settings = useQuery({
        queryKey: ["serverGameplaySettings"],
        queryFn: () => apiGet<GameplaySettings>("/api/server/settings/gameplay"),
    })
    const save = useMutation({
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

    useEffect(() => {
        if (settings.data) setDraftMultiplier(settings.data.dropMultiplier)
    }, [settings.data])

    const currentMultiplier = settings.data?.dropMultiplier
    const unchanged = draftMultiplier === null || draftMultiplier === currentMultiplier

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
                                loading={save.isPending}
                                onClick={() => draftMultiplier !== null && save.mutate(draftMultiplier)}
                            >
                                保存
                            </Button>
                        </Space>
                        <Alert
                            type="info"
                            showIcon
                            message="影响固定道具、玛纳、经验、属性素材和以太素材；不改变稀有掉落概率。"
                        />
                    </Space>
                )}
            </Card>
        </AdminPage>
    )
}
