import { MODULE_BY_KEY } from '@/data/modules'
import { allRows, listRows, resetRows, saveRows } from '@/data/local-store'
import { useSessionStore } from '@/stores/session'
import type {
  ActionResult,
  EntryRow,
  LabOrderDraft,
  LabReportDraft,
  LabTraceEntry,
  ModuleMeta,
  OverviewResult,
  PageResult,
} from '@/data/types'

// 会写进数据的「往回走」动作：命中就把这条记录标成异常态，看板上能一眼看出来。
const NEGATIVE_ACTIONS = ['撤销', '作废', '拒绝', '驳回', '停用', '忽略', '下线', '回滚']

// 检测委托单的状态顺序：只能顺着走，退回受理必须写明理由。
const LAB_KEY = 'laborder'
export const LAB_STATUSES = ['受理', '在检', '已出报告', '已归档'] as const
const LAB_FIELDS = {
  orderNo: '委托单号',
  client: '委托单位',
  phone: '联系电话',
  sample: '送检样品',
  sampleSource: '样品来源',
  items: '化验项目',
  reportNo: '报告编号',
  result: '检验结果',
  conclusion: '检验结论',
  correction: '更正说明',
  sentDate: '送检日期',
  handler: '经办人',
} as const

function operatorName(): string {
  try {
    return useSessionStore().operator || '化验室'
  } catch {
    return '化验室'
  }
}

function nowStamp(): string {
  const d = new Date()
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`
}

function nextRowId(key: string): number {
  return listRows(key).reduce((max, row) => Math.max(max, Number(row.id) || 0), 0) + 1
}

function nextSerial(prefix: string, key: string, field: string): string {
  let max = 0
  for (const row of listRows(key)) {
    const value = String(row[field] ?? '')
    const matched = value.startsWith(prefix) ? Number(value.slice(prefix.length)) : NaN
    if (Number.isFinite(matched)) {
      max = Math.max(max, matched)
    }
  }
  return `${prefix}${String(max + 1).padStart(4, '0')}`
}

function parseJsonList(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value.map((item) => String(item)).filter(Boolean)
  }
  if (typeof value === 'string' && value.trim().startsWith('[')) {
    try {
      const parsed = JSON.parse(value)
      return Array.isArray(parsed) ? parsed.map((item) => String(item)).filter(Boolean) : []
    } catch {
      return []
    }
  }
  return []
}

function parseTrace(row: EntryRow): LabTraceEntry[] {
  return parseJsonList(row['流转轨迹']).flatMap((raw) => {
    try {
      return [JSON.parse(raw) as LabTraceEntry]
    } catch {
      return []
    }
  })
}

function splitItems(value: string): string[] {
  return value
    .split(/[、,，;；\n]/)
    .map((item) => item.trim())
    .filter(Boolean)
}

// 重复递送判定用的归一化键：委托单位 + 送检样品 + 化验项目，空格/分隔符差异视为同一委托。
function dedupKey(client: string, sample: string, items: string[]): string {
  const normalize = (value: string) => value.replace(/[\s、,，;；]/g, '').toLowerCase()
  return [client, sample, [...items].sort().join('|')].map(normalize).join('@@')
}

function findLabRow(rows: EntryRow[], id: number): EntryRow | undefined {
  return rows.find((row) => Number(row.id) === id)
}

function appendTrace(row: EntryRow, entry: Omit<LabTraceEntry, 'at' | 'by'>): EntryRow {
  const trace = parseTrace(row)
  trace.push({ at: nowStamp(), by: operatorName(), ...entry })
  return { ...row, 流转轨迹: JSON.stringify(trace.map((item) => JSON.stringify(item))) }
}

function missingAcceptInfo(row: EntryRow): string[] {
  const missing: string[] = []
  if (!String(row[LAB_FIELDS.sampleSource] ?? '').trim()) {
    missing.push('样品来源')
  }
  if (parseJsonList(row[LAB_FIELDS.items]).length === 0) {
    missing.push('化验项目')
  }
  return missing
}

// 出报告/补更正后，把检验结果回写到环保监控的采样台账，并挂一条待复核的监控记录。
function syncResultToEmission(row: EntryRow): void {
  const rows = listRows('emission')
  const orderNo = String(row[LAB_FIELDS.orderNo])
  const existing = rows.find(
    (item) => String(item['来源委托单'] ?? '') === orderNo,
  )
  const items = parseJsonList(row[LAB_FIELDS.items])
  const monitorRow: EntryRow = {
    id: existing ? existing.id : nextRowId('emission'),
    status: '待复核',
    pending: true,
    abnormal: false,
    监控编号: existing ? existing['监控编号'] : nextSerial('EMIS-', 'emission', '监控编号'),
    监控指标: items.join('、') || '化验委托指标',
    限值要求: '按对应排放/质量标准限值复核',
    实测值: String(row[LAB_FIELDS.result] ?? ''),
    达标判定: String(row[LAB_FIELDS.conclusion] ?? ''),
    监控日期: nowStamp().slice(0, 10),
    监控人员: operatorName(),
    来源委托单: orderNo,
    报告编号: String(row[LAB_FIELDS.reportNo] ?? ''),
    监控状态: '待复核',
  }
  const next = existing
    ? rows.map((item) => (item === existing ? { ...existing, ...monitorRow } : item))
    : [...rows, monitorRow]
  saveRows('emission', next)
}

export function createLabOrder(draft: LabOrderDraft): ActionResult & { id?: number } {
  const client = draft.委托单位.trim()
  const sample = draft.送检样品.trim()
  if (!client) {
    return { ok: false, message: '委托单位不能为空，电话和便签上的委托得先落到单子上' }
  }
  if (!sample) {
    return { ok: false, message: '送检样品不能为空，没有样品的委托单不能受理' }
  }
  const items = splitItems(draft.化验项目)
  const rows = listRows(LAB_KEY)
  const key = dedupKey(client, sample, items)
  const duplicated = rows.find(
    (row) =>
      dedupKey(
        String(row[LAB_FIELDS.client] ?? ''),
        String(row[LAB_FIELDS.sample] ?? ''),
        parseJsonList(row[LAB_FIELDS.items]),
      ) === key,
  )
  if (duplicated) {
    return {
      ok: false,
      message: `同一检测委托已登记过（委托单号 ${duplicated[LAB_FIELDS.orderNo]}），重复递送只记一次`,
    }
  }
  const id = nextRowId(LAB_KEY)
  let row: EntryRow = {
    id,
    status: '受理',
    pending: true,
    abnormal: false,
    [LAB_FIELDS.orderNo]: nextSerial('LAB-', LAB_KEY, LAB_FIELDS.orderNo),
    [LAB_FIELDS.client]: client,
    [LAB_FIELDS.phone]: draft.联系电话.trim(),
    [LAB_FIELDS.sample]: sample,
    [LAB_FIELDS.sampleSource]: draft.样品来源.trim(),
    [LAB_FIELDS.items]: JSON.stringify(items),
    [LAB_FIELDS.reportNo]: '',
    [LAB_FIELDS.result]: '',
    [LAB_FIELDS.conclusion]: '',
    [LAB_FIELDS.correction]: '',
    [LAB_FIELDS.sentDate]: draft.送检日期 || nowStamp().slice(0, 10),
    [LAB_FIELDS.handler]: draft.经办人.trim() || operatorName(),
  }
  row = appendTrace(row, { action: '登记受理', from: '', to: '受理' })
  saveRows(LAB_KEY, [...rows, row])
  const missing = missingAcceptInfo(row)
  return {
    ok: true,
    id,
    message:
      missing.length > 0
        ? `委托单已受理，但缺${missing.join('、')}，卡在受理格，补齐后才能开始检验`
        : '委托单已受理，资料齐全，可以开始检验',
  }
}

// 受理阶段允许补齐样品来源/化验项目等资料；一旦离开受理，基础资料冻结。
export function supplementLabOrder(
  id: number,
  patch: Partial<Pick<LabOrderDraft, '样品来源' | '化验项目' | '联系电话'>>,
): ActionResult {
  const rows = listRows(LAB_KEY)
  const index = rows.findIndex((row) => Number(row.id) === id)
  const current = findLabRow(rows, id)
  if (!current) {
    return { ok: false, message: `没有找到编号为 ${id} 的检测委托单` }
  }
  if (current.status !== '受理') {
    return { ok: false, message: '只有受理中的委托单能补资料，离开受理后基础资料冻结' }
  }
  let updated: EntryRow = { ...current }
  if (patch.样品来源 !== undefined) {
    updated[LAB_FIELDS.sampleSource] = patch.样品来源.trim()
  }
  if (patch.化验项目 !== undefined) {
    updated[LAB_FIELDS.items] = JSON.stringify(splitItems(patch.化验项目))
  }
  if (patch.联系电话 !== undefined) {
    updated[LAB_FIELDS.phone] = patch.联系电话.trim()
  }
  updated = appendTrace(updated, { action: '补充资料', from: '受理', to: '受理' })
  const next = [...rows]
  next[index] = updated
  saveRows(LAB_KEY, next)
  const missing = missingAcceptInfo(updated)
  return {
    ok: true,
    message:
      missing.length > 0
        ? `资料已保存，仍缺${missing.join('、')}，还不能开始检验`
        : '资料已补齐，可以开始检验',
  }
}

export function startLabTesting(id: number): ActionResult {
  const rows = listRows(LAB_KEY)
  const index = rows.findIndex((row) => Number(row.id) === id)
  const current = findLabRow(rows, id)
  if (!current) {
    return { ok: false, message: `没有找到编号为 ${id} 的检测委托单` }
  }
  if (current.status === '已归档') {
    return { ok: false, message: '委托单已归档，状态锁死，化验室自己也不能再动' }
  }
  if (current.status !== '受理') {
    return { ok: false, message: '只有受理中的委托单能开始检验，状态只能顺着往下走' }
  }
  const missing = missingAcceptInfo(current)
  if (missing.length > 0) {
    return { ok: false, message: `缺${missing.join('、')}的委托单卡在受理格，补齐后才能开始检验` }
  }
  const updated = appendTrace(
    { ...current, status: '在检', pending: true },
    { action: '开始检验', from: '受理', to: '在检' },
  )
  const next = [...rows]
  next[index] = updated
  saveRows(LAB_KEY, next)
  return { ok: true, message: '委托单已进入在检' }
}

export function issueLabReport(id: number, draft: LabReportDraft): ActionResult {
  const reportNo = draft.报告编号.trim()
  const result = draft.检验结果.trim()
  const conclusion = draft.检验结论.trim()
  if (!reportNo) {
    return { ok: false, message: '出具报告必须填写报告编号' }
  }
  if (!result || !conclusion) {
    return { ok: false, message: '检验结果和检验结论都填写后才能出报告' }
  }
  const rows = listRows(LAB_KEY)
  const index = rows.findIndex((row) => Number(row.id) === id)
  const current = findLabRow(rows, id)
  if (!current) {
    return { ok: false, message: `没有找到编号为 ${id} 的检测委托单` }
  }
  if (current.status === '已归档') {
    return { ok: false, message: '委托单已归档，状态锁死，不能再出具或修改报告' }
  }
  if (current.status === '受理') {
    return { ok: false, message: '不能跳过在检直接出报告，请先开始检验' }
  }
  const oldReportNo = String(current[LAB_FIELDS.reportNo] ?? '')
  if (oldReportNo && oldReportNo !== reportNo) {
    return {
      ok: false,
      message: `报告编号 ${oldReportNo} 发出后不许再改；如需更正请补一条更正说明`,
    }
  }
  let updated: EntryRow = {
    ...current,
    status: '已出报告',
    pending: true,
    [LAB_FIELDS.reportNo]: reportNo,
    [LAB_FIELDS.result]: result,
    [LAB_FIELDS.conclusion]: conclusion,
  }
  updated = appendTrace(updated, { action: '出具报告', from: String(current.status), to: '已出报告', remark: reportNo })
  const next = [...rows]
  next[index] = updated
  saveRows(LAB_KEY, next)
  // 检验结论出来后：结果回写环保监控采样台账，并新增一条待复核的监控记录。
  syncResultToEmission(updated)
  return { ok: true, message: `报告 ${reportNo} 已出具，环保监控已生成待复核记录` }
}

export function correctLabReport(id: number, note: string): ActionResult {
  const text = note.trim()
  if (!text) {
    return { ok: false, message: '更正说明必须写清更正内容，不能留空' }
  }
  const rows = listRows(LAB_KEY)
  const index = rows.findIndex((row) => Number(row.id) === id)
  const current = findLabRow(rows, id)
  if (!current) {
    return { ok: false, message: `没有找到编号为 ${id} 的检测委托单` }
  }
  if (current.status !== '已出报告' && current.status !== '已归档') {
    return { ok: false, message: '报告尚未发出，没有可更正的报告编号' }
  }
  const notes = parseJsonList(current[LAB_FIELDS.correction])
  notes.push(`${nowStamp()} ${operatorName()}：${text}`)
  let updated: EntryRow = { ...current, [LAB_FIELDS.correction]: JSON.stringify(notes) }
  updated = appendTrace(updated, {
    action: '补更正说明',
    from: String(current.status),
    to: String(current.status),
    remark: text,
  })
  const next = [...rows]
  next[index] = updated
  saveRows(LAB_KEY, next)
  // 更正后以最新结论刷新台账上的待复核记录，不另开新单。
  syncResultToEmission(updated)
  return { ok: true, message: '更正说明已补记，报告编号未改动；环保台账待复核记录已刷新' }
}

export function archiveLabOrder(id: number): ActionResult {
  const rows = listRows(LAB_KEY)
  const index = rows.findIndex((row) => Number(row.id) === id)
  const current = findLabRow(rows, id)
  if (!current) {
    return { ok: false, message: `没有找到编号为 ${id} 的检测委托单` }
  }
  if (current.status === '已归档') {
    return { ok: false, message: '委托单已归档，状态锁死' }
  }
  if (current.status !== '已出报告') {
    return { ok: false, message: '只有已出报告的委托单能归档，状态只能顺着往下走' }
  }
  const updated = appendTrace(
    { ...current, status: '已归档', pending: false },
    { action: '归档', from: '已出报告', to: '已归档' },
  )
  const next = [...rows]
  next[index] = updated
  saveRows(LAB_KEY, next)
  return { ok: true, message: '委托单已归档，状态锁死，化验室不能再改动' }
}

export function returnLabOrder(id: number, reason: string): ActionResult {
  const text = reason.trim()
  if (!text) {
    return { ok: false, message: '退回受理必须写清理由' }
  }
  const rows = listRows(LAB_KEY)
  const index = rows.findIndex((row) => Number(row.id) === id)
  const current = findLabRow(rows, id)
  if (!current) {
    return { ok: false, message: `没有找到编号为 ${id} 的检测委托单` }
  }
  if (current.status === '已归档') {
    return { ok: false, message: '已归档的委托单状态锁死，不能退回受理' }
  }
  if (current.status === '受理') {
    return { ok: false, message: '委托单本来就在受理格，无需退回' }
  }
  let updated: EntryRow = { ...current, status: '受理', pending: true }
  updated = appendTrace(updated, {
    action: '退回受理',
    from: String(current.status),
    to: '受理',
    remark: `理由：${text}`,
  })
  const next = [...rows]
  next[index] = updated
  saveRows(LAB_KEY, next)
  return {
    ok: true,
    message:
      current.status === '已出报告'
        ? '已退回受理（理由已记录）；报告编号仍锁定，重新出报告时只能沿用原编号'
        : '已退回受理，退回理由已记录',
  }
}

export function labOrderHelpers() {
  return {
    statuses: LAB_STATUSES,
    traceOf: parseTrace,
    itemsOf: (row: EntryRow) => parseJsonList(row[LAB_FIELDS.items]),
    correctionsOf: (row: EntryRow) => parseJsonList(row[LAB_FIELDS.correction]),
    missingOf: missingAcceptInfo,
  }
}

export function moduleMeta(key: string): ModuleMeta {
  const meta = MODULE_BY_KEY.get(key)
  if (!meta) {
    throw new Error(`没有登记名为 ${key} 的业务模块`)
  }
  return meta
}

export function filterRows(rows: EntryRow[], filters: Record<string, string>): EntryRow[] {
  const pairs = Object.entries(filters).filter(([, value]) => value.trim() !== '')
  if (pairs.length === 0) {
    return rows
  }
  return rows.filter((row) =>
    pairs.every(([field, value]) => String(row[field] ?? '').includes(value.trim())),
  )
}

export function listEntries(key: string, filters: Record<string, string> = {}): PageResult {
  const matched = filterRows(listRows(key), filters)
  return { items: matched, total: matched.length, page: 1, size: matched.length }
}

export function runAction(key: string, id: number, action: string): ActionResult {
  const meta = moduleMeta(key)
  if (key === LAB_KEY) {
    return {
      ok: false,
      message: `检测委托单不能走通用「${action}」，请使用受理/检验/出报告/归档等专用操作`,
    }
  }
  const target = meta.actionTargets[action]
  if (!target) {
    return { ok: false, message: `${meta.entity}没有登记「${action}」这个动作` }
  }
  const rows = listRows(key)
  const index = rows.findIndex((row) => Number(row.id) === id)
  if (index < 0) {
    return { ok: false, message: `没有找到编号为 ${id} 的${meta.entity}` }
  }
  const current = String(rows[index].status)
  if (current === target) {
    return { ok: false, message: `${meta.entity}已经是「${target}」，不用重复操作` }
  }
  const lastStatus = meta.statuses[meta.statuses.length - 1]
  const updated: EntryRow = {
    ...rows[index],
    status: target,
    pending: target !== lastStatus,
    abnormal: NEGATIVE_ACTIONS.some((verb) => action.startsWith(verb)),
  }
  const next = [...rows]
  next[index] = updated
  saveRows(key, next)
  return { ok: true, message: `${meta.entity}已${action}，当前状态「${target}」` }
}

export function resetModule(key: string): PageResult {
  resetRows(key)
  return listEntries(key)
}

export function exportEntries(key: string): { filename: string; content: string } {
  const meta = moduleMeta(key)
  const header = ['编号', ...meta.fields, '当前状态']
  const lines = [header.join(',')]
  for (const row of listRows(key)) {
    lines.push([row.id, ...meta.fields.map((field) => csvCell(row[field], field)), row.status].join(','))
  }
  return { filename: `${meta.name}-清单.csv`, content: `\uFEFF${lines.join('\n')}` }
}

export function downloadEntries(key: string): void {
  const { filename, content } = exportEntries(key)
  const blob = new Blob([content], { type: 'text/csv;charset=utf-8' })
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = filename
  document.body.appendChild(anchor)
  anchor.click()
  document.body.removeChild(anchor)
  URL.revokeObjectURL(url)
}

// 委托单里的多值字段以 JSON 字符串存储，导出 CSV 时展平并转义。
function csvCell(value: unknown, field: string): string {
  let text: string
  if (field === LAB_FIELDS.items || field === LAB_FIELDS.correction) {
    text = parseJsonList(value).join('；')
  } else {
    text = String(value ?? '')
  }
  return /[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text
}

export function loadOverview(): OverviewResult {
  const rows = allRows()
  const modules = [...MODULE_BY_KEY.values()].map((meta) => {
    const entries = rows[meta.key] ?? []
    return {
      name: meta.name,
      created: entries.length,
      pending: entries.filter((row) => row.pending).length,
      abnormal: entries.filter((row) => row.abnormal).length,
    }
  })
  const cards = [
    { label: '业务模块', value: modules.length },
    { label: '登记总量', value: modules.reduce((sum, item) => sum + item.created, 0) },
    { label: '待处理', value: modules.reduce((sum, item) => sum + item.pending, 0) },
    { label: '异常量', value: modules.reduce((sum, item) => sum + item.abnormal, 0) },
  ]
  return { cards, modules }
}
