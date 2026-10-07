/** 纯前端数据层的公共类型：与全栈版后端返回的结构保持一致，换回后端时页面不用改。 */

export type EntryRow = {
  id: number
  status: string
  pending: boolean
  abnormal: boolean
  [field: string]: string | number | boolean
}

export type ModuleMeta = {
  key: string
  name: string
  entity: string
  desc: string
  fields: string[]
  statuses: string[]
  actions: string[]
  actionTargets: Record<string, string>
  metrics: string[]
}

export type PageResult = {
  items: EntryRow[]
  total: number
  page: number
  size: number
}

export type ActionResult = {
  ok: boolean
  message: string
}

export type OverviewResult = {
  cards: { label: string; value: number }[]
  modules: { name: string; created: number; pending: number; abnormal: number }[]
}

// 化验室检测委托单：多值字段（化验项目、流转轨迹、更正说明）以 JSON 字符串挂在 EntryRow 上。
export type LabOrderDraft = {
  委托单位: string
  联系电话: string
  送检样品: string
  样品来源: string
  化验项目: string
  送检日期: string
  经办人: string
}

export type LabReportDraft = {
  报告编号: string
  检验结果: string
  检验结论: string
}

export type LabTraceEntry = {
  at: string
  by: string
  action: string
  from: string
  to: string
  remark?: string
}
