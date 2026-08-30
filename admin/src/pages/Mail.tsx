import { ReactNode, useMemo, useState } from "react"
import { Card, Form, Select, InputNumber, Input, Button, message, Alert, Typography, Radio, Modal, Descriptions, Table, Tag, Space } from "antd"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { apiGet, apiPost } from "../api/client"
import { AdminPage } from "../components/AdminPage"
import { getMailAttachmentRule } from "../lib/mailRules"
import { ScheduledResourceRules } from "../components/ScheduledResourceRules"

const { TextArea } = Input
const { Text } = Typography

// 新后台只暴露常用且客户端领取校验稳定的附件类型。
const MAIL_TYPES = [
    { value: 1, label: "道具", needsId: true },
    { value: 4, label: "免费星导石" },
    { value: 5, label: "角色", needsId: true, singleOnly: true },
    { value: 6, label: "装备", needsId: true, singleOnly: true },
    { value: 7, label: "星之碎片" },
    { value: 8, label: "玛纳" },
    { value: 9, label: "经验值" },
    { value: 10, label: "羁绊之证" },
]

const TYPE_LABEL: Record<number, string> = Object.fromEntries(MAIL_TYPES.map(t => [t.value, t.label]))

function requiresTypeId(type: number | undefined): boolean {
    return !!MAIL_TYPES.find(t => t.value === type)?.needsId
}

type TargetMode = "all" | "account" | "player"

interface SendResult { ok: boolean; sent: number }
interface AccountRow { id: number; saveCount: number; defaultPlayerId: number | null; defaultPlayerName: string | null; playerIds: number[] }
interface PlayerBrief { id: number; name: string; lastLoginTime: string; degreeId: number }
interface MailRecord { time: string; type: number; typeId: number | null; number: number; subject: string | null; target: string; sent: number; expirationDays: number }
interface CharacterLookupRow { name: string; title: string; rarity: string; element: string }
interface EquipmentLookupRow { name: string; rarity: string; category: string }
type ItemLookup = Record<string, string>
type CharacterLookup = Record<string, CharacterLookupRow>
type EquipmentLookup = Record<string, EquipmentLookupRow>
type AttachmentLookup = ItemLookup | CharacterLookup | EquipmentLookup
interface AttachmentOption {
    value: number
    label: ReactNode
    searchText: string
    titleText: string
}

function norm(value: unknown): string {
    return String(value ?? "").normalize("NFKC").trim().toLowerCase()
}

function lookupEndpoint(type: number | undefined): string | null {
    if (type === 1) return "/api/lookup/items"
    if (type === 5) return "/api/lookup/characters"
    if (type === 6) return "/api/lookup/equipment"
    return null
}

function attachmentTitle(type: number | undefined, id: number | null | undefined, lookup: AttachmentLookup | undefined): string {
    if (id == null || !lookup) return id == null ? "" : `#${id}`
    const row = lookup[String(id)]
    if (!row) return `#${id}`
    if (type === 1 && typeof row === "string") return `${row} #${id}`
    if (type === 5 && typeof row !== "string") {
        const character = row as CharacterLookupRow
        return `${character.name}${character.title ? ` · ${character.title}` : ""} #${id}`
    }
    if (type === 6 && typeof row !== "string") return `${(row as EquipmentLookupRow).name} #${id}`
    return `#${id}`
}

function buildAttachmentOptions(type: number | undefined, lookup: AttachmentLookup | undefined): AttachmentOption[] {
    if (!type || !lookup) return []
    return Object.entries(lookup)
        .map(([rawId, row]): AttachmentOption | null => {
            const id = Number(rawId)
            if (type === 1 && typeof row === "string") {
                const titleText = `${row} #${id}`
                return {
                    value: id,
                    titleText,
                    searchText: norm(`${id} ${row}`),
                    label: (
                        <Space direction="vertical" size={0}>
                            <Text>{row}</Text>
                            <Text type="secondary">#{id}</Text>
                        </Space>
                    ),
                }
            }
            if (type === 5 && typeof row !== "string") {
                const character = row as CharacterLookupRow
                const titleText = `${character.name}${character.title ? ` · ${character.title}` : ""} #${id}`
                return {
                    value: id,
                    titleText,
                    searchText: norm(`${id} ${character.name} ${character.title} ${character.rarity} ${character.element}`),
                    label: (
                        <Space direction="vertical" size={0}>
                            <Text>{character.name}</Text>
                            <Text type="secondary">#{id} · {character.title || "无称号"} · {character.rarity} · {character.element}</Text>
                        </Space>
                    ),
                }
            }
            if (type === 6 && typeof row !== "string") {
                const equipment = row as EquipmentLookupRow
                const titleText = `${equipment.name} #${id}`
                return {
                    value: id,
                    titleText,
                    searchText: norm(`${id} ${equipment.name} ${equipment.rarity} ${equipment.category}`),
                    label: (
                        <Space direction="vertical" size={0}>
                            <Text>{equipment.name}</Text>
                            <Text type="secondary">#{id} · {equipment.rarity} · {equipment.category}</Text>
                        </Space>
                    ),
                }
            }
            return null
        })
        .filter((option): option is AttachmentOption => option !== null)
        .sort((a, b) => a.value - b.value)
}

function filterAttachmentOption(input: string, option?: AttachmentOption): boolean {
    if (!option) return false
    const query = norm(input)
    if (!query) return true
    if (/^[0-9]+$/.test(query)) return String(option.value) === query
    return option.searchText.includes(query)
}

export default function Mail() {
    const qc = useQueryClient()
    const [form] = Form.useForm()
    const type = Form.useWatch("type", form)
    const typeId = Form.useWatch("type_id", form)
    const targetMode: TargetMode = Form.useWatch("targetMode", form) ?? "all"
    const needsId = requiresTypeId(type)
    const attachmentEndpoint = lookupEndpoint(type)

    // 预览确认：暂存待发送的表单值 + 计算好的对象描述/角色数
    const [confirm, setConfirm] = useState<null | { values: any; count: number; targetText: string; attachmentText: string }>(null)

    const { data: accounts = [] } = useQuery({ queryKey: ["accounts"], queryFn: () => apiGet<AccountRow[]>("/api/server/accounts") })
    const { data: players = [] } = useQuery({ queryKey: ["players"], queryFn: () => apiGet<PlayerBrief[]>("/api/player") })
    const { data: history = [] } = useQuery({ queryKey: ["mailHistory"], queryFn: () => apiGet<MailRecord[]>("/api/mail/history") })
    const { data: attachmentLookup, isLoading: attachmentLoading, isError: attachmentError } = useQuery({
        queryKey: ["mailAttachmentLookup", type],
        queryFn: () => apiGet<AttachmentLookup>(attachmentEndpoint!),
        enabled: needsId && !!attachmentEndpoint,
        staleTime: Infinity,
    })
    const { data: itemMaxCounts } = useQuery({
        queryKey: ["itemMaxCounts"],
        queryFn: () => apiGet<Record<string, number>>("/api/lookup/item-max-counts"),
        enabled: type === 1,
        staleTime: Infinity,
    })
    const quantityRule = getMailAttachmentRule(type, typeId, itemMaxCounts?.[String(typeId)])
    const attachmentOptions = useMemo(
        () => buildAttachmentOptions(type, attachmentLookup),
        [type, attachmentLookup],
    )

    const totalSaves = accounts.reduce((n, a) => n + a.saveCount, 0)

    const send = useMutation({
        mutationFn: (v: any) => apiPost<SendResult>("/api/mail/send", {
            type: String(v.type),
            type_id: requiresTypeId(v.type) && v.type_id != null ? String(v.type_id) : undefined,
            number: String(v.number ?? 1),
            subject: v.subject ?? "",
            description: v.description ?? "",
            accountId: v.targetMode === "account" && v.accountId != null ? String(v.accountId) : "",
            playerId: v.targetMode === "player" && v.playerId != null ? String(v.playerId) : "",
            expirationDays: String(v.expirationDays ?? 31),
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
        const attachmentName = attachmentTitle(v.type, v.type_id, attachmentLookup)
        const attachmentText = attachmentName
            ? `${TYPE_LABEL[v.type] ?? v.type} · ${attachmentName}`
            : `${TYPE_LABEL[v.type] ?? v.type}`
        setConfirm({ values: v, count, targetText, attachmentText })
    }

    return (
        <AdminPage
            eyebrow="MAIL"
            title="邮件"
            description="按全体、账号或单个存档发送附件邮件。高风险发送动作会先展示目标和附件摘要。"
        >
        <Space direction="vertical" size="large" className="admin-stack">
            <Card title="发送邮件" className="admin-form-panel">
                <Alert type={targetMode === "all" ? "warning" : "info"} showIcon style={{ marginBottom: 16 }}
                    message={
                        targetMode === "all" ? `将向全体 ${totalSaves} 个存档发送同一封邮件`
                            : targetMode === "account" ? "将向所选账号下的所有存档发送邮件"
                                : "将向所选的单个存档发送邮件"
                    } />
                <Form form={form} layout="vertical" onFinish={openConfirm} initialValues={{ number: 1, expirationDays: 31, targetMode: "all" }}>
                    <Form.Item name="targetMode" label="发送对象">
                        <Radio.Group optionType="button" buttonStyle="solid">
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
                        <Radio.Group
                            className="admin-mail-type-group"
                            optionType="button"
                            buttonStyle="solid"
                            onChange={(event) => {
                                const nextRule = getMailAttachmentRule(event.target.value, null)
                                form.setFieldsValue({
                                    type_id: undefined,
                                    number: nextRule.max === 1 ? 1 : 1,
                                })
                                form.validateFields(["type_id", "number"]).catch(() => {})
                            }}
                        >
                            {MAIL_TYPES.map(t => (
                                <Radio.Button key={t.value} value={t.value} className="admin-mail-type-option">
                                    {t.label}
                                </Radio.Button>
                            ))}
                        </Radio.Group>
                    </Form.Item>

                    {needsId && (
                        <Form.Item
                            name="type_id"
                            label="附件"
                            rules={[
                                {
                                    validator: async (_, value) => {
                                        if (attachmentError) throw new Error("附件索引加载失败，无法发送")
                                        if (value == null) throw new Error("请选择附件")
                                    },
                                },
                            ]}
                            extra="输入完整 ID 或中文名称搜索；数字查询按完整 ID 精确匹配，避免误选相近编号。"
                        >
                            <Select
                                showSearch
                                allowClear
                                placeholder="输入 ID 或名称搜索附件"
                                loading={attachmentLoading}
                                disabled={attachmentError}
                                options={attachmentOptions}
                                filterOption={filterAttachmentOption}
                                optionLabelProp="titleText"
                                notFoundContent={attachmentLoading ? "正在加载附件索引" : "没有匹配附件"}
                                onChange={(nextTypeId) => {
                                    const nextRule = getMailAttachmentRule(type, nextTypeId)
                                    const currentNumber = form.getFieldValue("number") ?? 1
                                    form.setFieldValue("number", Math.min(currentNumber, nextRule.max))
                                    form.validateFields(["number"]).catch(() => {})
                                }}
                            />
                        </Form.Item>
                    )}

                    <Form.Item
                        name="number"
                        label="数量"
                        rules={[
                            { required: true, message: "请输入数量" },
                            {
                                validator: async (_, value) => {
                                    if (value == null) throw new Error("请输入数量")
                                    if (value < quantityRule.min || value > quantityRule.max) {
                                        throw new Error(`数量需在 ${quantityRule.min}-${quantityRule.max} 之间`)
                                    }
                                },
                            },
                        ]}
                        extra={`${quantityRule.label}：${quantityRule.min}-${quantityRule.max}。${quantityRule.reason}`}
                    >
                        <InputNumber
                            style={{ width: "100%" }}
                            min={quantityRule.min}
                            max={quantityRule.max}
                            disabled={quantityRule.max === 1}
                        />
                    </Form.Item>

                    <Form.Item name="subject" label="标题（可选）">
                        <Input maxLength={64} showCount placeholder="留空使用游戏默认" />
                    </Form.Item>

                    <Form.Item name="description" label="正文（可选）">
                        <TextArea rows={3} maxLength={512} showCount placeholder="留空使用游戏默认" />
                    </Form.Item>

                    <Form.Item
                        name="expirationDays"
                        label="有效天数"
                        rules={[
                            { required: true, message: "请输入有效天数" },
                            { type: "number", min: 1, max: 3650, message: "有效天数需在 1-3650 之间" },
                        ]}
                        extra="到期后邮件会在打开邮箱或领取时自动删除。"
                    >
                        <InputNumber style={{ width: "100%" }} min={1} max={3650} precision={0} />
                    </Form.Item>

                    <Form.Item>
                        <Space wrap>
                            <Button type="primary" htmlType="submit">发送</Button>
                            <Text type="secondary">发送后无法撤回，请确认附件 ID</Text>
                        </Space>
                    </Form.Item>
                </Form>
            </Card>

            <ScheduledResourceRules players={players} />

            <Card title="最近群发记录" size="small" className="admin-table-card">
                <Table<MailRecord & { key: number }>
                    rowKey="key"
                    size="small"
                    pagination={false}
                    dataSource={history.map((h, i) => ({ ...h, key: i }))}
                    locale={{ emptyText: "暂无记录" }}
                    scroll={{ x: "max-content" }}
                    columns={[
                        { title: "时间", dataIndex: "time", width: 160 },
                        { title: "对象", dataIndex: "target" },
                        {
                            title: "附件", key: "attach",
                            render: (_: unknown, r) => `${TYPE_LABEL[r.type] ?? r.type}${r.typeId ? ` #${r.typeId}` : ""} × ${r.number}`,
                        },
                        { title: "发送数", dataIndex: "sent", width: 80, render: (n: number) => <Tag color="blue">{n}</Tag> },
                        { title: "有效期", dataIndex: "expirationDays", width: 90, render: (n: number) => String(n ?? 31) + " 天" },
                    ]}
                />
            </Card>
        </Space>

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
                            <Descriptions.Item label="附件">{confirm.attachmentText}</Descriptions.Item>
                            {confirm.values.type_id != null && (
                                <Descriptions.Item label="附件 ID">{confirm.values.type_id}</Descriptions.Item>
                            )}
                            <Descriptions.Item label="数量">× {confirm.values.number}</Descriptions.Item>
                            <Descriptions.Item label="有效期">{confirm.values.expirationDays} 天</Descriptions.Item>
                            {confirm.values.subject && (
                                <Descriptions.Item label="标题">{confirm.values.subject}</Descriptions.Item>
                            )}
                        </Descriptions>
                        <Alert style={{ marginTop: 12 }} type="warning" showIcon
                            message={`将向 ${confirm.count} 个角色发送 ${TYPE_LABEL[confirm.values.type] ?? confirm.values.type} × ${confirm.values.number}，发送后无法撤回`} />
                    </>
                )}
            </Modal>
        </AdminPage>
    )
}
