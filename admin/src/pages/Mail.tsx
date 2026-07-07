import { useState } from "react"
import { Card, Form, Select, InputNumber, Input, Button, message, Alert, Typography, Radio, Modal, Descriptions, Table, Tag } from "antd"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { apiGet, apiPost } from "../api/client"

const { TextArea } = Input
const { Text } = Typography

// 附件类型对应旧 mail.html 下拉；needsId=需 type_id，singleOnly=每封仅 1 个
const MAIL_TYPES = [
    { value: 1, label: "道具 (Item)", needsId: true },
    { value: 3, label: "付费星导石 (Paid Vmoney)" },
    { value: 4, label: "免费星导石 (Free Vmoney)" },
    { value: 5, label: "角色 (Character)", needsId: true, singleOnly: true },
    { value: 6, label: "装备 (Equipment)", needsId: true, singleOnly: true },
    { value: 7, label: "星之碎片 (Star Crumb)" },
    { value: 8, label: "法力 (Mana)" },
    { value: 9, label: "经验池 (Exp Pool)" },
    { value: 10, label: "羁绊之证 (Bond Token)" },
    { value: 11, label: "Boss Boost 点" },
    { value: 12, label: "Boost 点" },
    { value: 15, label: "Rank 点" },
]

const MAX_INT = 2147483647
const TYPE_LABEL: Record<number, string> = Object.fromEntries(MAIL_TYPES.map(t => [t.value, t.label]))

type TargetMode = "all" | "account" | "player"

interface SendResult { ok: boolean; sent: number }
interface AccountRow { id: number; saveCount: number; defaultPlayerId: number | null; defaultPlayerName: string | null; playerIds: number[] }
interface PlayerBrief { id: number; name: string; lastLoginTime: string; degreeId: number }
interface MailRecord { time: string; type: number; typeId: number | null; number: number; subject: string | null; target: string; sent: number }

export default function Mail() {
    const qc = useQueryClient()
    const [form] = Form.useForm()
    const type = Form.useWatch("type", form)
    const targetMode: TargetMode = Form.useWatch("targetMode", form) ?? "all"
    const meta = MAIL_TYPES.find(t => t.value === type)
    const needsId = !!meta?.needsId
    const singleOnly = !!meta?.singleOnly

    // 预览确认：暂存待发送的表单值 + 计算好的对象描述/角色数
    const [confirm, setConfirm] = useState<null | { values: any; count: number; targetText: string }>(null)

    const { data: accounts = [] } = useQuery({ queryKey: ["accounts"], queryFn: () => apiGet<AccountRow[]>("/api/server/accounts") })
    const { data: players = [] } = useQuery({ queryKey: ["players"], queryFn: () => apiGet<PlayerBrief[]>("/api/player") })
    const { data: history = [] } = useQuery({ queryKey: ["mailHistory"], queryFn: () => apiGet<MailRecord[]>("/api/mail/history") })

    const totalSaves = accounts.reduce((n, a) => n + a.saveCount, 0)

    const send = useMutation({
        mutationFn: (v: any) => apiPost<SendResult>("/api/mail/send", {
            type: String(v.type),
            type_id: v.type_id != null ? String(v.type_id) : "",
            number: String(v.number ?? 1),
            subject: v.subject ?? "",
            description: v.description ?? "",
            accountId: v.targetMode === "account" && v.accountId != null ? String(v.accountId) : "",
            playerId: v.targetMode === "player" && v.playerId != null ? String(v.playerId) : "",
        }),
        onSuccess: (r) => {
            message.success(`已向 ${r.sent} 个角色发送邮件`)
            setConfirm(null)
            // 保留发送对象设置，仅清空附件与文案，便于连续操作
            form.resetFields(["type", "type_id", "number", "subject", "description"])
            qc.invalidateQueries({ queryKey: ["mailHistory"] })
        },
        onError: (e: Error) => message.error(e.message),
    })

    // 通过表单校验后，先算好预览再弹确认框
    const openConfirm = (v: any) => {
        let count = 0
        let targetText = ""
        if (v.targetMode === "player") {
            const p = players.find(pp => pp.id === v.playerId)
            count = 1
            targetText = p ? `存档 #${p.id}（${p.name}）` : `存档 #${v.playerId}`
        } else if (v.targetMode === "account") {
            const a = accounts.find(aa => aa.id === v.accountId)
            count = a?.saveCount ?? 0
            targetText = `账号 #${v.accountId}${a ? `（${a.saveCount} 个存档）` : ""}`
        } else {
            count = totalSaves
            targetText = `全体（${accounts.length} 个账号 / ${totalSaves} 个存档）`
        }
        setConfirm({ values: v, count, targetText })
    }

    return (
        <div style={{ maxWidth: 640 }}>
            <Card title="邮件群发">
                <Alert type={targetMode === "all" ? "warning" : "info"} showIcon style={{ marginBottom: 16 }}
                    message={
                        targetMode === "all" ? `将向全体 ${totalSaves} 个存档发送同一封邮件`
                            : targetMode === "account" ? "将向所选账号下的所有存档发送邮件"
                                : "将向所选的单个存档发送邮件"
                    } />
                <Form form={form} layout="vertical" onFinish={openConfirm} initialValues={{ number: 1, targetMode: "all" }}>
                    <Form.Item name="targetMode" label="发送对象">
                        <Radio.Group>
                            <Radio.Button value="all">全体存档</Radio.Button>
                            <Radio.Button value="account">指定账号</Radio.Button>
                            <Radio.Button value="player">指定存档</Radio.Button>
                        </Radio.Group>
                    </Form.Item>

                    {targetMode === "account" && (
                        <Form.Item name="accountId" label="选择账号" rules={[{ required: true, message: "请选择账号" }]}>
                            <Select
                                showSearch
                                placeholder="选择账号"
                                optionFilterProp="label"
                                options={accounts.map(a => ({
                                    value: a.id,
                                    label: `账号 #${a.id}（${a.saveCount} 个存档${a.defaultPlayerName ? `，生效：${a.defaultPlayerName}` : ""}）`,
                                }))}
                                notFoundContent="暂无账号"
                            />
                        </Form.Item>
                    )}

                    {targetMode === "player" && (
                        <Form.Item name="playerId" label="选择存档" rules={[{ required: true, message: "请选择存档" }]}>
                            <Select
                                showSearch
                                placeholder="选择存档"
                                optionFilterProp="label"
                                options={players.map(p => ({ value: p.id, label: `${p.name}（#${p.id}）` }))}
                                notFoundContent="暂无存档"
                            />
                        </Form.Item>
                    )}

                    <Form.Item name="type" label="附件类型" rules={[{ required: true, message: "请选择附件类型" }]}>
                        <Select
                            placeholder="-- 请选择附件类型 --"
                            options={MAIL_TYPES.map(t => ({ value: t.value, label: t.label }))}
                            onChange={() => {
                                const m = MAIL_TYPES.find(t => t.value === form.getFieldValue("type"))
                                if (m?.singleOnly) form.setFieldValue("number", 1)
                                form.validateFields(["type_id"]).catch(() => {})
                            }}
                        />
                    </Form.Item>

                    <Form.Item
                        name="type_id"
                        label="附件 ID (type_id)"
                        rules={needsId ? [{ required: true, message: "此类型需填写附件 ID" }] : []}
                        extra={needsId
                            ? "道具=道具ID / 角色=6位 business code / 装备=7位 ID，发送前会校验 CDN 数据"
                            : "此附件类型无需填写附件 ID"}
                    >
                        <InputNumber style={{ width: "100%" }} min={1} max={MAX_INT} disabled={!needsId}
                            placeholder="道具 ID / 角色 code / 装备 ID" />
                    </Form.Item>

                    <Form.Item name="number" label="数量" rules={[{ required: true, message: "请输入数量" }]}
                        extra={singleOnly ? "角色 / 装备每封邮件仅可发送 1 个" : undefined}>
                        <InputNumber style={{ width: "100%" }} min={1} max={MAX_INT} disabled={singleOnly} />
                    </Form.Item>

                    <Form.Item name="subject" label="标题（可选）">
                        <Input maxLength={64} showCount placeholder="留空使用游戏默认" />
                    </Form.Item>

                    <Form.Item name="description" label="正文（可选）">
                        <TextArea rows={3} maxLength={512} showCount placeholder="留空使用游戏默认" />
                    </Form.Item>

                    <Form.Item>
                        <Button type="primary" htmlType="submit">发送</Button>
                        <Text type="secondary" style={{ marginLeft: 12 }}>发送后无法撤回，请确认附件 ID</Text>
                    </Form.Item>
                </Form>
            </Card>

            <Card title="最近群发记录" size="small" style={{ marginTop: 16 }}>
                <Table<MailRecord & { key: number }>
                    rowKey="key"
                    size="small"
                    pagination={false}
                    dataSource={history.map((h, i) => ({ ...h, key: i }))}
                    locale={{ emptyText: "暂无记录" }}
                    columns={[
                        { title: "时间", dataIndex: "time", width: 160 },
                        { title: "对象", dataIndex: "target" },
                        {
                            title: "附件", key: "attach",
                            render: (_: unknown, r) => `${TYPE_LABEL[r.type] ?? r.type}${r.typeId ? ` #${r.typeId}` : ""} × ${r.number}`,
                        },
                        { title: "发送数", dataIndex: "sent", width: 80, render: (n: number) => <Tag color="blue">{n}</Tag> },
                    ]}
                />
            </Card>

            <Modal
                open={!!confirm}
                title="确认群发"
                onOk={() => confirm && send.mutate(confirm.values)}
                onCancel={() => setConfirm(null)}
                okText="确认发送"
                cancelText="取消"
                confirmLoading={send.isPending}
                okButtonProps={{ danger: true }}
            >
                {confirm && (
                    <>
                        <Descriptions column={1} size="small" bordered>
                            <Descriptions.Item label="发送对象">{confirm.targetText}</Descriptions.Item>
                            <Descriptions.Item label="角色数量">{confirm.count} 个</Descriptions.Item>
                            <Descriptions.Item label="附件类型">{TYPE_LABEL[confirm.values.type] ?? confirm.values.type}</Descriptions.Item>
                            {confirm.values.type_id != null && (
                                <Descriptions.Item label="附件 ID">{confirm.values.type_id}</Descriptions.Item>
                            )}
                            <Descriptions.Item label="数量">× {confirm.values.number}</Descriptions.Item>
                            {confirm.values.subject && (
                                <Descriptions.Item label="标题">{confirm.values.subject}</Descriptions.Item>
                            )}
                        </Descriptions>
                        <Alert style={{ marginTop: 12 }} type="warning" showIcon
                            message={`将向 ${confirm.count} 个角色发送 ${TYPE_LABEL[confirm.values.type] ?? confirm.values.type} × ${confirm.values.number}，发送后无法撤回`} />
                    </>
                )}
            </Modal>
        </div>
    )
}
