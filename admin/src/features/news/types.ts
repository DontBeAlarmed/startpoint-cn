export interface AdminNewsRow {
    id: number
    category: 1 | 2 | 3
    title: string
    publishedAtReal: string
    bodyRichText: string
    label: number
    thumbnail: number
    enabled: boolean
    revision: number
    createdAt: string
    updatedAt: string
}

export type NewsDraft = Pick<AdminNewsRow,
    "category" | "title" | "publishedAtReal" | "bodyRichText" |
    "label" | "thumbnail" | "enabled">

export interface NewsPage {
    rows: AdminNewsRow[]
    totalCount: number
    page: number
    pageSize: number
}
