import { useState } from "react"
import { Alert, Button, Card, DatePicker, Space, Statistic, Typography, message } from "antd"
import { ReloadOutlined } from "@ant-design/icons"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import type { Dayjs } from "dayjs"
import { apiGet } from "../api/client"
import { AdminPage } from "../components/AdminPage"

interface ServerTime {
    servertime: number
    date: string
    isCustom: boolean
}

export default function TimeControl() {
    const qc = useQueryClient()
    const [picked, setPicked] = useState<Dayjs | null>(null)

    const { data, isError, isLoading, isFetching } = useQuery({
        queryKey: ["serverTime"],
        queryFn: () => apiGet<ServerTime>("/api/server/currentTime"),
        refetchInterval: 30_000,
    })

    const timeText = isLoading
        ? "加载中..."
        : isError || !data
            ? "接口不可用"
            : new Date(data.date).toLocaleString("zh-CN")

    const setTime = useMutation({
        mutationFn: (t: Dayjs) =>
            apiGet<ServerTime>(`/api/server/time?time=${encodeURIComponent(t.format("YYYY-MM-DDTHH:mm:ss"))}`),
        onSuccess: () => { message.success("服务器时间已设置"); qc.invalidateQueries({ queryKey: ["serverTime"] }) },
        onError: (e: Error) => message.error(e.message),
    })

    const resetTime = useMutation({
        mutationFn: () => apiGet<ServerTime>("/api/server/resetTime"),
        onSuccess: () => { message.success("已重置为系统时间"); qc.invalidateQueries({ queryKey: ["serverTime"] }) },
        onError: (e: Error) => message.error(e.message),
    })

    return (
        <AdminPage
            eyebrow="TIME"
            title="时间 / 千里眼"
            description="独立管理全局服务器时间。后续千里眼相关的事件窗口、资源时序和玩家视角校验都从这里扩展。"
            actions={
                <Button
                    icon={<ReloadOutlined />}
                    loading={isFetching}
                    onClick={() => qc.invalidateQueries({ queryKey: ["serverTime"] })}
                >
                    刷新时间
                </Button>
            }
        >
            <Space direction="vertical" size="large" className="admin-stack">
                <Alert
                    type={data?.isCustom ? "warning" : "info"}
                    showIcon
                    message={data?.isCustom ? "当前使用自定义服务器时间" : "当前跟随系统时间"}
                    description="这里控制的是服务端全局时间。单个玩家的 time_offset 后续会在千里眼工作流中单独呈现。"
                />
                <div className="admin-card-grid">
                    <Card title="当前服务器时间">
                        <Statistic
                            title="服务器时间"
                            value={timeText}
                            suffix={data?.isCustom ? "（自定义）" : undefined}
                        />
                        <Typography.Text type="secondary">
                            Unix 秒：{data?.servertime ?? "-"}
                        </Typography.Text>
                    </Card>
                    <Card title="时间控制">
                        <Space direction="vertical" className="admin-stack">
                            <Space wrap>
                                <DatePicker
                                    showTime
                                    value={picked}
                                    onChange={setPicked}
                                    placeholder="选择服务器时间 (UTC)"
                                    format="YYYY-MM-DD HH:mm:ss"
                                />
                                <Button
                                    type="primary"
                                    disabled={!picked}
                                    loading={setTime.isPending}
                                    onClick={() => picked && setTime.mutate(picked)}
                                >
                                    设置时间
                                </Button>
                                <Button loading={resetTime.isPending} onClick={() => resetTime.mutate()}>
                                    重置为系统时间
                                </Button>
                            </Space>
                            <Typography.Text type="secondary">
                                所选时间按 UTC 解释；重置后跟随真实系统时间。
                            </Typography.Text>
                        </Space>
                    </Card>
                </div>
            </Space>
        </AdminPage>
    )
}
