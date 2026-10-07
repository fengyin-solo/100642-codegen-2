import { listRows, saveRows } from '@/data/local-store'
import type { ActionResult, EntryRow } from '@/data/types'

// 化验室检测委托单的全部业务判断都集中在这里：状态只能顺着走、受理卡口、
// 报告编号锁定、归档锁死、结果回写采样台账与环保监控，页面组件不做业务判断。

const MODULE_KEY = 'labtest'
const LEDGER_KEY = 'sampleledger'
const EMISSION_KEY = 'emission'

// 委托单主线状态：顺序即允许的流转方向，只能从当前态走到紧邻的下一个态。
const FLOW = ['受理', '在检', '已出报告', '已归档'] as const
// 只有「在检」允许带着理由退回受理；归档是终态，谁都不能再动。
const ARCHIVED = '已归档'

// 受理卡口：样品来源、化验项目缺一不可，缺了就只能停在受理格。
const REQUIRED_AT_ACCEPT = ['样品来源', '化验项目'] as const
// 出报告时必须能落报告的内容。
const REQUIRED_AT_REPORT = ['检验结果', '检验结论'] as const

export type LabDraft = {
  委托单号?: string
  样品编号?: string
  样品来源?: string
  送检样品?: string
  化验项目?: string
  委托单位?: string
  委托人?: string
  受理日期?: string
}

function clean(value: unknown): string {
  return String(value ?? '').trim()
}

function fail(message: string): ActionResult {
  return { ok: false, message }
}

function nextId(rows: EntryRow[]): number {
  return rows.reduce((max, row) => Math.max(max, Number(row.id) || 0), 0) + 1
}

function today(): string {
  return new Date().toISOString().slice(0, 10)
}

function listLab(): EntryRow[] {
  return listRows(MODULE_KEY)
}

function saveLab(rows: EntryRow[]): void {
  saveRows(MODULE_KEY, rows)
}

// 同一张检测委托重复递送只记一次：委托单号是唯一键，样品编号+化验项目也兜底判重。
function findDuplicate(draft: LabDraft, exceptId?: number): EntryRow | undefined {
  const code = clean(draft.委托单号)
  const sample = clean(draft.样品编号)
  const items = clean(draft.化验项目)
  return listLab().find((row) => {
    if (exceptId !== undefined && Number(row.id) === exceptId) {
      return false
    }
    // 已归档的历史单不再参与判重，归档锁死的单子不能拦着同编号的新一轮委托。
    if (String(row.status) === ARCHIVED && exceptId === undefined) {
      return false
    }
    if (code && clean(row.委托单号) === code) {
      return true
    }
    return Boolean(sample) && clean(row.样品编号) === sample && Boolean(items) && clean(row.化验项目) === items
  })
}

// 新建委托单：受理是入口状态；重复递送直接拒收，不产生第二条记录。
export function createLabOrder(draft: LabDraft): ActionResult & { id?: number } {
  const duplicate = findDuplicate(draft)
  if (duplicate) {
    return fail(
      `检测委托已登记过（委托单号 ${clean(duplicate.委托单号) || '未编号'}，当前状态「${duplicate.status}」），同一张委托重复递送只记一次`,
    )
  }

  const rows = listLab()
  const id = nextId(rows)
  const code = clean(draft.委托单号) || `LAB-${today().slice(0, 4)}-${String(id).padStart(4, '0')}`
  const row: EntryRow = {
    id,
    status: '受理',
    pending: true,
    abnormal: false,
    委托单号: code,
    样品编号: clean(draft.样品编号) || `SMP-${today().replace(/-/g, '')}-${String(id).padStart(2, '0')}`,
    样品来源: clean(draft.样品来源),
    送检样品: clean(draft.送检样品),
    化验项目: clean(draft.化验项目),
    委托单位: clean(draft.委托单位),
    委托人: clean(draft.委托人),
    受理日期: clean(draft.受理日期) || today(),
    检验结果: '',
    检验结论: '',
    报告编号: '',
    更正说明: '',
    退回原因: '',
    委托状态: '受理',
  }
  saveLab([...rows, row])
  return { ok: true, message: `检测委托单 ${code} 已受理`, id }
}

// 只有受理格的单子允许补录/改正基本信息；样品来源与化验项目补齐后才能往下走。
const EDITABLE_FIELDS = [
  '样品编号',
  '样品来源',
  '送检样品',
  '化验项目',
  '委托单位',
  '委托人',
  '受理日期',
] as const

export function updateLabOrder(id: number, patch: Partial<Record<(typeof EDITABLE_FIELDS)[number], string>>): ActionResult {
  const rows = listLab()
  const index = rows.findIndex((row) => Number(row.id) === id)
  if (index < 0) {
    return fail(`没有找到编号为 ${id} 的检测委托单`)
  }
  const current = rows[index]
  if (String(current.status) === ARCHIVED) {
    return fail('委托单已归档，状态与信息一律锁死，化验室也不能再动')
  }
  if (String(current.status) !== '受理') {
    return fail(`委托单已进入「${current.status}」，基本信息不能再改；报告内容如需更正请走「补更正说明」`)
  }
  const patchWithId = patch as LabDraft
  const duplicate = findDuplicate({ ...current, ...patchWithId } as LabDraft, id)
  if (duplicate) {
    return fail(`改后与委托单 ${clean(duplicate.委托单号)} 撞号/撞样品，同一张委托不能重复登记`)
  }

  const updated: EntryRow = { ...current }
  for (const field of EDITABLE_FIELDS) {
    if (patch[field] !== undefined) {
      updated[field] = clean(patch[field])
    }
  }
  const next = [...rows]
  next[index] = updated
  saveLab(next)
  return { ok: true, message: '委托单信息已更新，仍停留在「受理」' }
}

function missingFields(row: EntryRow, fields: readonly string[]): string[] {
  return fields.filter((field) => clean(row[field]) === '')
}

// 出报告：报告编号当场签发并写死；结果同步回写采样台账与环保监控（各只产生一条）。
function issueReport(row: EntryRow, result: string, conclusion: string): EntryRow {
  const rows = listLab()
  const reportNo = clean(row.报告编号) || `BG-${today().slice(0, 4)}-${String(nextId(rows)).padStart(4, '0')}`
  const issued: EntryRow = {
    ...row,
    status: '已出报告',
    pending: true,
    abnormal: false,
    检验结果: result,
    检验结论: conclusion,
    报告编号: reportNo,
    退回原因: '',
    委托状态: '已出报告',
  }
  writeBackLedger(issued)
  writeBackEmission(issued)
  return issued
}

// 回写环保监控的采样台账：以委托单号去重，同一张委托不管出几次报告只保留一条。
function writeBackLedger(row: EntryRow): void {
  const ledger = listRows(LEDGER_KEY)
  const orderNo = clean(row.委托单号)
  const existing = ledger.findIndex((item) => clean(item.关联委托单) === orderNo)
  const entry: EntryRow = {
    id: existing >= 0 ? ledger[existing].id : nextId(ledger),
    status: '已回写',
    pending: false,
    abnormal: false,
    台账编号:
      existing >= 0
        ? ledger[existing].台账编号
        : `LED-${today().slice(0, 4)}-${String(nextId(ledger)).padStart(4, '0')}`,
    关联委托单: orderNo,
    样品来源: clean(row.样品来源),
    送检样品: clean(row.送检样品),
    化验项目: clean(row.化验项目),
    检验结果: clean(row.检验结果),
    检验结论: clean(row.检验结论),
    报告编号: clean(row.报告编号),
    回写日期: today(),
    台账状态: '已回写',
  }
  if (existing >= 0) {
    const next = [...ledger]
    next[existing] = entry
    saveRows(LEDGER_KEY, next)
  } else {
    saveRows(LEDGER_KEY, [...ledger, entry])
  }
}

// 检验结论出来后，环保指标监控那边跟着多一条「待复核」记录；同样按委托单号去重。
function writeBackEmission(row: EntryRow): void {
  const monitors = listRows(EMISSION_KEY)
  const orderNo = clean(row.委托单号)
  const existing = monitors.findIndex((item) => clean(item.关联委托单) === orderNo)
  const entry: EntryRow = {
    id: existing >= 0 ? monitors[existing].id : nextId(monitors),
    status: '待复核',
    pending: true,
    abnormal: false,
    监控编号:
      existing >= 0
        ? monitors[existing].监控编号
        : `EMIS-LAB-${String(nextId(monitors)).padStart(4, '0')}`,
    关联委托单: orderNo,
    监控指标: clean(row.化验项目),
    限值要求: '',
    实测值: clean(row.检验结果),
    达标判定: '待复核',
    监控日期: today(),
    监控人员: '化验室自动回写',
    监控状态: '待复核',
  }
  if (existing >= 0) {
    const next = [...monitors]
    next[existing] = entry
    saveRows(EMISSION_KEY, next)
  } else {
    saveRows(EMISSION_KEY, [...monitors, entry])
  }
}

export type LabActionPayload = {
  // 返回受理必须写清理由。
  reason?: string
  // 出报告时录入结果与结论。
  result?: string
  conclusion?: string
}

// 委托单状态机：受理→在检→已出报告→已归档，跳步一律拦住；归档之后所有动作拒绝。
export function runLabAction(id: number, action: string, payload: LabActionPayload = {}): ActionResult {
  const rows = listLab()
  const index = rows.findIndex((row) => Number(row.id) === id)
  if (index < 0) {
    return fail(`没有找到编号为 ${id} 的检测委托单`)
  }
  const row = rows[index]
  const current = String(row.status)

  if (current === ARCHIVED) {
    return fail('委托单已归档，状态锁死，化验室自己也不能再动')
  }

  if (action === '返回受理') {
    if (current !== '在检') {
      return fail(`只有「在检」的委托单才能退回受理，当前是「${current}」`)
    }
    const reason = clean(payload.reason)
    if (reason === '') {
      return fail('退回受理必须写清退回原因')
    }
    const nextRow: EntryRow = {
      ...row,
      status: '受理',
      pending: true,
      abnormal: true,
      退回原因: reason,
      委托状态: '受理',
    }
    const next = [...rows]
    next[index] = nextRow
    saveLab(next)
    return { ok: true, message: `委托单已退回受理，原因：${reason}` }
  }

  const targetByAction: Record<string, string> = {
    开始检验: '在检',
    出具报告: '已出报告',
    归档: '已归档',
  }
  const target = targetByAction[action]
  if (!target) {
    return fail(`检测委托单没有登记「${action}」这个动作`)
  }

  // 只能顺着往下走，不允许跳步（如在检未完成就出报告由顺序本身拦住）。
  const currentIndex = FLOW.indexOf(current as (typeof FLOW)[number])
  const targetIndex = FLOW.indexOf(target as (typeof FLOW)[number])
  if (targetIndex !== currentIndex + 1) {
    return fail(`委托单状态只能顺着往下走：当前「${current}」不能直接「${action}」，请先完成上一环节`)
  }

  if (action === '开始检验') {
    const missing = missingFields(row, REQUIRED_AT_ACCEPT)
    if (missing.length > 0) {
      return fail(`委托单还缺${missing.join('、')}，卡在受理这一格，补齐后才能开始检验`)
    }
    const testing: EntryRow = {
      ...row,
      status: '在检',
      pending: true,
      abnormal: false,
      退回原因: '',
      委托状态: '在检',
    }
    const next = [...rows]
    next[index] = testing
    saveLab(next)
    return { ok: true, message: '委托单已开始检验，当前状态「在检」' }
  }

  if (action === '出具报告') {
    const missingAccept = missingFields(row, REQUIRED_AT_ACCEPT)
    if (missingAccept.length > 0) {
      return fail(`委托单还缺${missingAccept.join('、')}，不能出具报告`)
    }
    const result = clean(payload.result)
    const conclusion = clean(payload.conclusion)
    const missingInput: string[] = []
    if (result === '') {
      missingInput.push('检验结果')
    }
    if (conclusion === '') {
      missingInput.push('检验结论')
    }
    if (missingInput.length > 0) {
      return fail(`出报告前必须填${missingInput.join('、')}`)
    }
    const issued = issueReport(row, result, conclusion)
    const next = [...rows]
    next[index] = issued
    saveLab(next)
    return {
      ok: true,
      message: `报告 ${issued.报告编号} 已签发，结果已回写采样台账并生成一条环保监控待复核记录`,
    }
  }

  // 剩下的唯一动作是「归档」：终态锁死。
  const nextRow: EntryRow = {
    ...row,
    status: ARCHIVED,
    pending: false,
    abnormal: false,
    委托状态: ARCHIVED,
  }
  const next = [...rows]
  next[index] = nextRow
  saveLab(next)
  return { ok: true, message: '委托单已归档，状态与内容就此锁死' }
}

// 报告编号签发后不许再改：只能补一条更正说明，且说明只能追加不能覆盖。
export function appendReportCorrection(id: number, note: string): ActionResult {
  const text = clean(note)
  if (text === '') {
    return fail('更正说明不能为空')
  }
  const rows = listLab()
  const index = rows.findIndex((row) => Number(row.id) === id)
  if (index < 0) {
    return fail(`没有找到编号为 ${id} 的检测委托单`)
  }
  const row = rows[index]
  const current = String(row.status)
  if (current === ARCHIVED) {
    return fail('委托单已归档，状态锁死，连更正说明也不能再补')
  }
  if (clean(row.报告编号) === '') {
    return fail('报告还没签发、报告编号未生成，谈不上更正')
  }
  const stamped = `[${today()}] ${text}`
  const history = clean(row.更正说明)
  const merged = history ? `${history}\n${stamped}` : stamped
  const nextRow: EntryRow = { ...row, 更正说明: merged }
  const next = [...rows]
  next[index] = nextRow
  saveLab(next)
  return { ok: true, message: `已为报告 ${row.报告编号} 追加更正说明（报告编号与结果保持不变）` }
}
