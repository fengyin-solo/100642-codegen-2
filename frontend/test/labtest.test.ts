import { beforeEach, describe, expect, it } from 'vitest'

// local-store 在 jsdom 下持久化到 localStorage，每个用例前清空并复位三个模块。
import { listRows, resetRows } from '@/data/local-store'
import { runAction } from '@/api/local-service'
import {
  appendReportCorrection,
  createLabOrder,
  runLabAction,
  updateLabOrder,
} from '@/api/lab-service'

const MODULES = ['labtest', 'sampleledger', 'emission']

function reset() {
  if (typeof window !== 'undefined' && window.localStorage) {
    window.localStorage.clear()
  }
  for (const key of MODULES) {
    resetRows(key)
  }
}

type LabRow = { id: number; status: string; [k: string]: unknown }

function labRows(): LabRow[] {
  return listRows('labtest') as unknown as LabRow[]
}

function findByCode(code: string): LabRow {
  return labRows().find((r) => r.委托单号 === code)!
}

describe('化验室检测委托单流转规则', () => {
  beforeEach(reset)

  it('1. 缺样品来源/化验项目的单子卡在受理，不能开始检验', () => {
    const created = createLabOrder({ 委托单号: 'T-001', 送检样品: '水样' })
    expect(created.ok).toBe(true)
    const blocked = runLabAction(created.id!, '开始检验')
    expect(blocked.ok).toBe(false)
    expect(blocked.message).toContain('样品来源')
    expect(blocked.message).toContain('化验项目')
    expect(findByCode('T-001').status).toBe('受理')
  })

  it('2. 补齐信息后开始检验：受理→在检', () => {
    const created = createLabOrder({ 委托单号: 'T-002', 送检样品: '水样' })
    const filled = updateLabOrder(created.id!, { 样品来源: '总排口', 化验项目: 'COD' })
    expect(filled.ok).toBe(true)
    const started = runLabAction(created.id!, '开始检验')
    expect(started.ok).toBe(true)
    expect(findByCode('T-002').status).toBe('在检')
  })

  it('3. 状态只能顺着走：在检直接归档（跳过出报告）被拦', () => {
    const created = createLabOrder({ 委托单号: 'T-003', 样品来源: '总排口', 送检样品: '水样', 化验项目: 'COD' })
    runLabAction(created.id!, '开始检验')
    const skip = runLabAction(created.id!, '归档')
    expect(skip.ok).toBe(false)
    expect(skip.message).toContain('只能顺着往下走')
    expect(findByCode('T-003').status).toBe('在检')
  })

  it('4. 受理格直接出报告（跳过在检）被拦', () => {
    const created = createLabOrder({ 委托单号: 'T-004', 样品来源: '总排口', 送检样品: '水样', 化验项目: 'COD' })
    const skip = runLabAction(created.id!, '出具报告', { result: 'x', conclusion: 'y' })
    expect(skip.ok).toBe(false)
    expect(skip.message).toContain('只能顺着往下走')
  })

  it('5. 出报告必须填结果与结论', () => {
    const created = createLabOrder({ 委托单号: 'T-005', 样品来源: '总排口', 送检样品: '水样', 化验项目: 'COD' })
    runLabAction(created.id!, '开始检验')
    const empty = runLabAction(created.id!, '出具报告', { result: '  ', conclusion: '' })
    expect(empty.ok).toBe(false)
    expect(empty.message).toContain('检验结果')
    expect(empty.message).toContain('检验结论')
  })

  it('6. 出报告：签发报告编号并锁定，回写台账+生成待复核监控记录', () => {
    const created = createLabOrder({
      委托单号: 'T-006', 样品来源: '总排口', 送检样品: '出水样', 化验项目: 'COD',
    })
    runLabAction(created.id!, '开始检验')
    const issued = runLabAction(created.id!, '出具报告', { result: 'COD 42 mg/L', conclusion: '合格' })
    expect(issued.ok).toBe(true)
    const row = findByCode('T-006')
    expect(row.status).toBe('已出报告')
    expect(String(row.报告编号)).toMatch(/^BG-\d{4}-\d{4}$/)

    const ledger = listRows('sampleledger').filter((r) => r.关联委托单 === 'T-006')
    expect(ledger.length).toBe(1)
    expect(ledger[0].检验结果).toBe('COD 42 mg/L')
    expect(ledger[0].status).toBe('已回写')

    const monitors = listRows('emission').filter((r) => r.关联委托单 === 'T-006')
    expect(monitors.length).toBe(1)
    expect(monitors[0].status).toBe('待复核')
    expect(monitors[0].监控指标).toBe('COD')
  })

  it('7. 报告编号发出后不许改：updateLabOrder 被拒，只能补更正说明且可累加', () => {
    const created = createLabOrder({
      委托单号: 'T-007', 样品来源: '总排口', 送检样品: '出水样', 化验项目: 'COD',
    })
    runLabAction(created.id!, '开始检验')
    runLabAction(created.id!, '出具报告', { result: 'COD 42', conclusion: '合格' })
    const no = String(findByCode('T-007').报告编号)
    const edit = updateLabOrder(created.id!, { 样品来源: '别处' })
    expect(edit.ok).toBe(false)
    expect(edit.message).toContain('不能再改')

    const c1 = appendReportCorrection(created.id!, '限值年号更正')
    expect(c1.ok).toBe(true)
    const c2 = appendReportCorrection(created.id!, '第二条更正')
    expect(c2.ok).toBe(true)
    const row = findByCode('T-007')
    expect(row.报告编号).toBe(no)
    expect(String(row.更正说明)).toContain('限值年号更正')
    expect(String(row.更正说明)).toContain('第二条更正')
    expect(String(row.更正说明).split('\n')).toHaveLength(2)
  })

  it('8. 同一张委托重复递送只记一次（委托单号 / 样品编号+化验项目）', () => {
    const first = createLabOrder({ 委托单号: 'T-008', 样品编号: 'S-1008', 样品来源: 'a', 化验项目: 'COD' })
    expect(first.ok).toBe(true)
    const byCode = createLabOrder({ 委托单号: 'T-008', 样品编号: 'S-2', 样品来源: 'b', 化验项目: '氨氮' })
    expect(byCode.ok).toBe(false)
    expect(byCode.message).toContain('只记一次')
    const bySample = createLabOrder({ 委托单号: 'T-009', 样品编号: 'S-1008', 样品来源: 'a', 化验项目: 'COD' })
    expect(bySample.ok).toBe(false)
    // 不同项目不算重复。
    const otherItem = createLabOrder({ 委托单号: 'T-010', 样品编号: 'S-1008', 样品来源: 'a', 化验项目: '氨氮' })
    expect(otherItem.ok).toBe(true)
  })

  it('9. 退回受理：在检可退且必须写理由；已出报告不能退；退回复检后能继续主线', () => {
    const created = createLabOrder({ 委托单号: 'T-011', 样品来源: '总排口', 送检样品: '水样', 化验项目: 'COD' })
    runLabAction(created.id!, '开始检验')
    const noReason = runLabAction(created.id!, '返回受理')
    expect(noReason.ok).toBe(false)
    expect(noReason.message).toContain('退回原因')
    const back = runLabAction(created.id!, '返回受理', { reason: '样品标签污损' })
    expect(back.ok).toBe(true)
    const row = findByCode('T-011')
    expect(row.status).toBe('受理')
    expect(row.退回原因).toBe('样品标签污损')

    // 退回受理后不能直接出报告，必须重新开始检验。
    const skip = runLabAction(created.id!, '出具报告', { result: 'x', conclusion: 'y' })
    expect(skip.ok).toBe(false)
    runLabAction(created.id!, '开始检验')
    runLabAction(created.id!, '出具报告', { result: 'COD 40', conclusion: '合格' })
    const fromReport = runLabAction(created.id!, '返回受理', { reason: '想改' })
    expect(fromReport.ok).toBe(false)
  })

  it('10. 归档锁死：归档后任何动作、编辑、更正都拒绝', () => {
    const created = createLabOrder({ 委托单号: 'T-012', 样品来源: '总排口', 送检样品: '水样', 化验项目: 'COD' })
    runLabAction(created.id!, '开始检验')
    runLabAction(created.id!, '出具报告', { result: 'COD 40', conclusion: '合格' })
    const archived = runLabAction(created.id!, '归档')
    expect(archived.ok).toBe(true)

    expect(runLabAction(created.id!, '开始检验').message).toContain('锁死')
    expect(runLabAction(created.id!, '返回受理', { reason: 'x' }).message).toContain('锁死')
    expect(appendReportCorrection(created.id!, '想更正').message).toContain('锁死')
    expect(updateLabOrder(created.id!, { 样品来源: 'x' }).message).toContain('锁死')
    const row = findByCode('T-012')
    expect(row.status).toBe('已归档')
    expect(row.pending).toBe(false)
  })

  it('11. 回写幂等：重复操作下台账与待复核监控仍然各只有一条', () => {
    const created = createLabOrder({
      委托单号: 'T-013', 样品来源: '总排口', 送检样品: '水样', 化验项目: '氨氮',
    })
    runLabAction(created.id!, '开始检验')
    const first = runLabAction(created.id!, '出具报告', { result: '氨氮 1.5', conclusion: '合格' })
    expect(first.ok).toBe(true)
    // 已出报告不能再次出报告（顺序被拦），因此回写天然只有一次。
    const again = runLabAction(created.id!, '出具报告', { result: '氨氮 1.6', conclusion: '合格' })
    expect(again.ok).toBe(false)
    expect(listRows('sampleledger').filter((r) => r.关联委托单 === 'T-013').length).toBe(1)
    expect(listRows('emission').filter((r) => r.关联委托单 === 'T-013').length).toBe(1)
  })

  it('12. 通用 runAction 对 labtest/采样台账 的绕行被拦；待复核监控可复核通过', () => {
    const created = createLabOrder({ 委托单号: 'T-014', 样品来源: '总排口', 送检样品: '水样', 化验项目: 'COD' })
    const guard = runAction('labtest', created.id!, '开始检验')
    expect(guard.ok).toBe(false)
    expect(guard.message).toContain('专用操作')

    runLabAction(created.id!, '开始检验')
    runLabAction(created.id!, '出具报告', { result: 'COD 50', conclusion: '待判定' })
    const monitor = listRows('emission').find((r) => r.关联委托单 === 'T-014')!
    expect(monitor.status).toBe('待复核')
    const pass = runAction('emission', Number(monitor.id), '复核通过')
    expect(pass.ok).toBe(true)
    expect(listRows('emission').find((r) => r.id === monitor.id)!.status).toBe('已达标')
  })

  it('13. 归档后的同编号委托允许新一轮登记（锁死不拦新单），且不影响判重', () => {
    const first = createLabOrder({ 委托单号: 'T-015', 样品来源: 'a', 送检样品: 'x', 化验项目: 'COD' })
    runLabAction(first.id!, '开始检验')
    runLabAction(first.id!, '出具报告', { result: 'v', conclusion: 'c' })
    runLabAction(first.id!, '归档')
    // 归档单不再参与未归档判重：同一业务场景可重新委托（新周期采样）。
    const again = createLabOrder({ 委托单号: 'T-015', 样品来源: 'a', 送检样品: 'x', 化验项目: 'COD' })
    expect(again.ok).toBe(true)
  })
})
