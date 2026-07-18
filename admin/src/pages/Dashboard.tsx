import { useState } from "react"
import { Card, Statistic, Space, Alert, DatePicker, Button, message, Typography, Row, Col, Divider, Upload, Tag, Popconfirm } from "antd"
import { TeamOutlined, MailOutlined, ExperimentOutlined, ReloadOutlined, UploadOutlined, DeleteOutlined } from "@ant-design/icons"
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query"
import { useNavigate } from "react-router-dom"
import type { Dayjs } from "dayjs"
import { apiGet, apiUpload, apiDelete } from "../api/client"
import { AdminPage } from "../components/AdminPage"

interface ServerTime {
    servertime: number
    date: string
    isCustom: boolean
}

// GET /api/server/accounts 返回的账号行（与「账号 / 存档」页共用类型与缓存）
interface AccountRow {
    id: number
    saveCount: number
    defaultPlayerId: number | null
    defaultPlayerName: string | null
    playerIds: number[]
}

interface DefaultSaveMeta {
    exists: boolean
    playerName?: string | null
    exportedAt?: string | null
    sourcePlayerId?: number | null
}

// GET /api/server/currentTime 返回 { servertime, date, isCustom }
export default function Dashboard() {
    const qc = useQueryClient()
    const navigate = useNavigate()
    const [picked, setPicked] = useState<Dayjs | null>(null)

    const { data, isError, isLoading } = useQuery({
        queryKey: ["serverTime"],
        queryFn: () => apiGet<ServerTime>("/api/server/currentTime"),
        refetchInterval: 30_000
    })

    // 概览统计：复用账号列表（与「账号 / 存档」页共用 ["accounts"] 缓存）。
    // 本模型下每个存档即一条玩家记录，故存档总数 = 玩家总数。
    const { data: accounts = [], isLoading: accountsLoading, isError: accountsError, isFetching: accountsFetching } = useQuery({
        queryKey: ["accounts"],
        queryFn: () => apiGet<AccountRow[]>("/api/server/accounts"),
    })

    const accountCount = accounts.length
    const saveCount = accounts.reduce((sum, a) => sum + a.saveCount, 0)
    const avgSaves = accountCount ? saveCount / accountCount : 0

    const timeText = isLoading
        ? "加载中…"
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

    // 默认存档模板：新建存档时用它替换空档
    const { data: defSave } = useQuery({
        queryKey: ["defaultSave"],
        queryFn: () => apiGet<DefaultSaveMeta>("/api/server/defaultSave"),
    })

    const uploadDefault = useMutation({
        mutationFn: (file: File) => apiUpload("/api/server/defaultSave", file),
        onSuccess: () => { message.success("默认存档已设置"); qc.invalidateQueries({ queryKey: ["defaultSave"] }) },
        onError: (e: Error) => message.error(e.message),
    })

    const clearDefault = useMutation({
        mutationFn: () => apiDelete("/api/server/defaultSave"),
        onSuccess: () => { message.success("默认存档已清除"); qc.invalidateQueries({ queryKey: ["defaultSave"] }) },
        onError: (e: Error) => message.error(e.message),
    })

    return (
        <AdminPage
            eyebrow="OPERATIONS"
            title="服务器总览"
            description="集中查看账号、存档、默认模板与服务器时间。像素风只作为识别层，不影响高频管理操作。"
            actions={
                <Button
                    icon={<ReloadOutlined />}
                    loading={accountsFetching}
                    onClick={() => qc.invalidateQueries({ queryKey: ["accounts"] })}
                >
                    刷新概览
                </Button>
            }
        >
        <Space direction="vertical" size="large" className="admin-stack">
            <Alert
                type="info"
                showIcon
                message="新版 React 管理后台"
                description="当前阶段优先统一应用壳、视觉系统和响应式体验；旧后台页面保持冻结。"
            />
            <div className="admin-card-grid">
                <Card title="概览统计">
                    {accountsError ? (
                        <Alert
                            type="error"
                            showIcon
                            message="概览数据加载失败"
                            description="接口 /api/server/accounts 不可用。"
                        />
                    ) : (
                        <Row gutter={[16, 16]}>
                            <Col xs={12} sm={8}>
                                <Statistic title="账号总数" value={accountCount} loading={accountsLoading} />
                            </Col>
                            <Col xs={12} sm={8}>
                                <Statistic title="存档总数（玩家）" value={saveCount} loading={accountsLoading} />
                            </Col>
                            <Col xs={24} sm={8}>
                                <Statistic title="平均每账号存档" value={avgSaves} precision={1} loading={accountsLoading} />
                            </Col>
                        </Row>
                    )}
                    <Divider style={{ margin: "16px 0" }} />
                    <Space wrap>
                        <Button icon={<TeamOutlined />} onClick={() => navigate("/accounts")}>账号 / 存档</Button>
                        <Button icon={<MailOutlined />} onClick={() => navigate("/mail")}>邮件群发</Button>
                        <Button icon={<ExperimentOutlined />} onClick={() => navigate("/seeds")}>种子管理</Button>
                    </Space>
                </Card>

                <Card title="默认存档">
                    <Space direction="vertical" className="admin-stack">
                        <Typography.Text type="secondary">
                            上传玩家详情页「导出存档」得到的 JSON。之后任意账户「新建存档」时，将用它替换空存档。
                        </Typography.Text>
                        {defSave?.exists ? (
                            <Space wrap>
                                <Tag color="green">已设置</Tag>
                                <Typography.Text>模板玩家：{defSave.playerName || "-"}</Typography.Text>
                                {defSave.exportedAt && (
                                    <Typography.Text type="secondary">
                                        导出于 {new Date(defSave.exportedAt).toLocaleString("zh-CN")}
                                    </Typography.Text>
                                )}
                            </Space>
                        ) : (
                            <Tag>未设置（新建存档为空档）</Tag>
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
                                    <Button danger icon={<DeleteOutlined />} loading={clearDefault.isPending}>清除</Button>
                                </Popconfirm>
                            )}
                        </Space>
                    </Space>
                </Card>
            </div>

            <div className="admin-card-grid">
                <Card title="服务器状态">
                    <Statistic
                        title="服务器时间"
                        value={timeText}
                        suffix={data?.isCustom ? "（自定义）" : undefined}
                    />
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
                            <Button type="primary" disabled={!picked} loading={setTime.isPending}
                                onClick={() => picked && setTime.mutate(picked)}>
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
