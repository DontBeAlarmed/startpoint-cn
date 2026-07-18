import { Alert, Button, Card, Col, Descriptions, Divider, Popconfirm, Row, Space, Statistic, Tag, Typography, Upload, message } from "antd"
import { DeleteOutlined, ExperimentOutlined, MailOutlined, ReloadOutlined, TeamOutlined, UploadOutlined } from "@ant-design/icons"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { useNavigate } from "react-router-dom"
import { apiDelete, apiGet, apiUpload } from "../api/client"
import { AdminPage } from "../components/AdminPage"

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

interface ServerStatus {
    server: {
        uptimeSeconds: number
        nodeVersion: string
        platform: string
        pid: number
        memory: { rss: number; heapUsed: number; heapTotal: number }
        listenHost: string
        listenPort: string
    }
    cdn: {
        baseUrl: string
        configuredDir: string
        directoryPresent: boolean
        archiveCount: number
        archiveBytes: number
        latestArchiveMtime: string | null
        fullVersion: string
        detectedVersion: string
        effectiveVersion: string
        manifestVersion: string
        enabledPatchCount: number
        totalPatchCount: number
        activePatchArchiveCount: number
    }
}

function formatDuration(seconds: number): string {
    const days = Math.floor(seconds / 86400)
    const hours = Math.floor((seconds % 86400) / 3600)
    const minutes = Math.floor((seconds % 3600) / 60)
    if (days > 0) return `${days} 天 ${hours} 小时`
    if (hours > 0) return `${hours} 小时 ${minutes} 分钟`
    return `${Math.max(1, minutes)} 分钟`
}

function formatBytes(bytes: number): string {
    if (!bytes) return "0 B"
    const units = ["B", "KB", "MB", "GB", "TB"]
    let value = bytes
    let unit = 0
    while (value >= 1024 && unit < units.length - 1) {
        value /= 1024
        unit += 1
    }
    return `${value.toFixed(value >= 10 || unit === 0 ? 0 : 1)} ${units[unit]}`
}

export default function Dashboard() {
    const qc = useQueryClient()
    const navigate = useNavigate()

    const { data: accounts = [], isLoading: accountsLoading, isError: accountsError, isFetching: accountsFetching } = useQuery({
        queryKey: ["accounts"],
        queryFn: () => apiGet<AccountRow[]>("/api/server/accounts"),
    })

    const { data: status, isError: statusError, isFetching: statusFetching } = useQuery({
        queryKey: ["serverStatus"],
        queryFn: () => apiGet<ServerStatus>("/api/server/status"),
        refetchInterval: 30_000,
    })

    const accountCount = accounts.length
    const saveCount = accounts.reduce((sum, a) => sum + a.saveCount, 0)
    const activeSaveCount = accounts.filter(a => a.defaultPlayerId != null).length

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

    const refreshOverview = () => {
        qc.invalidateQueries({ queryKey: ["accounts"] })
        qc.invalidateQueries({ queryKey: ["serverStatus"] })
    }

    return (
        <AdminPage
            eyebrow="OPERATIONS"
            title="服务器总览"
            description="查看服务端运行状态、CDN 版本和账号存档概况。时间控制已拆分到独立模块，为后续千里眼功能预留空间。"
            actions={
                <Button
                    icon={<ReloadOutlined />}
                    loading={accountsFetching || statusFetching}
                    onClick={refreshOverview}
                >
                    刷新总览
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
                    <Card title="服务端状态">
                        {statusError || !status ? (
                            <Alert type="error" showIcon message="服务端状态加载失败" description="接口 /api/server/status 不可用。" />
                        ) : (
                            <>
                                <Row gutter={[16, 16]}>
                                    <Col xs={12} sm={8}>
                                        <Statistic title="运行时间" value={formatDuration(status.server.uptimeSeconds)} />
                                    </Col>
                                    <Col xs={12} sm={8}>
                                        <Statistic title="RSS 内存" value={formatBytes(status.server.memory.rss)} />
                                    </Col>
                                    <Col xs={12} sm={8}>
                                        <Statistic title="PID" value={status.server.pid} />
                                    </Col>
                                </Row>
                                <Divider style={{ margin: "16px 0" }} />
                                <Descriptions size="small" column={1}>
                                    <Descriptions.Item label="Node">{status.server.nodeVersion}</Descriptions.Item>
                                    <Descriptions.Item label="平台">{status.server.platform}</Descriptions.Item>
                                    <Descriptions.Item label="监听">{status.server.listenHost}:{status.server.listenPort}</Descriptions.Item>
                                </Descriptions>
                            </>
                        )}
                    </Card>

                    <Card title="CDN / 资源版本">
                        {statusError || !status ? (
                            <Alert type="error" showIcon message="CDN 信息加载失败" />
                        ) : (
                            <Space direction="vertical" className="admin-stack">
                                <div className="admin-metric-row">
                                    <Statistic title="基础包版本" value={status.cdn.fullVersion} />
                                    <Statistic title="检测版本" value={status.cdn.detectedVersion} />
                                    <Statistic title="目标版本" value={status.cdn.effectiveVersion} />
                                </div>
                                <Descriptions size="small" column={1}>
                                    <Descriptions.Item label="CDN 地址">{status.cdn.baseUrl}</Descriptions.Item>
                                    <Descriptions.Item label="目录">
                                        <Space wrap>
                                            <code>{status.cdn.configuredDir}/cn</code>
                                            {status.cdn.directoryPresent ? <Tag color="green">存在</Tag> : <Tag color="red">未找到</Tag>}
                                        </Space>
                                    </Descriptions.Item>
                                    <Descriptions.Item label="归档">
                                        {status.cdn.archiveCount} 个 ZIP / {formatBytes(status.cdn.archiveBytes)}
                                    </Descriptions.Item>
                                    <Descriptions.Item label="最新修改">
                                        {status.cdn.latestArchiveMtime ? new Date(status.cdn.latestArchiveMtime).toLocaleString("zh-CN") : "无"}
                                    </Descriptions.Item>
                                    <Descriptions.Item label="Patch Manifest">
                                        {status.cdn.manifestVersion} · 启用 {status.cdn.enabledPatchCount}/{status.cdn.totalPatchCount} · active {status.cdn.activePatchArchiveCount}
                                    </Descriptions.Item>
                                </Descriptions>
                            </Space>
                        )}
                    </Card>
                </div>

                <div className="admin-card-grid">
                    <Card title="账号 / 存档概况">
                        {accountsError ? (
                            <Alert
                                type="error"
                                showIcon
                                message="概览数据加载失败"
                                description="接口 /api/server/accounts 不可用。"
                            />
                        ) : (
                            <Row gutter={[16, 16]}>
                                <Col xs={8}>
                                    <Statistic title="账号总数" value={accountCount} loading={accountsLoading} />
                                </Col>
                                <Col xs={8}>
                                    <Statistic title="存档总数" value={saveCount} loading={accountsLoading} />
                                </Col>
                                <Col xs={8}>
                                    <Statistic title="已绑定生效存档" value={activeSaveCount} loading={accountsLoading} />
                                </Col>
                            </Row>
                        )}
                        <Divider style={{ margin: "16px 0" }} />
                        <Space wrap>
                            <Button icon={<TeamOutlined />} onClick={() => navigate("/accounts")}>账号 / 存档</Button>
                            <Button icon={<MailOutlined />} onClick={() => navigate("/mail")}>邮件</Button>
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
            </Space>
        </AdminPage>
    )
}
