// 业务规则验证：用 esbuild 把 TS 数据层打包成临时 CJS 后执行（scripts/lab-test-build.mjs 完成打包）。
const store = new Map()
globalThis.window = { localStorage: { getItem: (k) => (store.has(k) ? store.get(k) : null), setItem: (k, v) => store.set(k, v) } }

const svc = await import('./.lab-test-dist/local-service.cjs')

let passed = 0
let failed = 0
function check(name, cond, detail = '') {
  if (cond) {
    passed += 1
    console.log(`  ✓ ${name}`)
  } else {
    failed += 1
    console.error(`  ✗ ${name} ${detail}`)
  }
}

function rows() {
  return svc.listEntries('laborder').items
}
function byId(id) {
  return rows().find((r) => Number(r.id) === id)
}

// 1. 受理：缺样品/缺单位拦截；缺来源或缺项目也能登记但卡在受理
const r0 = svc.createLabOrder({ 委托单位: '', 联系电话: '', 送检样品: '水样', 样品来源: '池', 化验项目: 'COD', 送检日期: '2026-10-07', 经办人: '' })
check('缺委托单位不能受理', !r0.ok, r0.message)
const r1 = svc.createLabOrder({ 委托单位: '甲班', 联系电话: '', 送检样品: '', 样品来源: '池', 化验项目: 'COD', 送检日期: '2026-10-07', 经办人: '' })
check('缺送检样品不能受理', !r1.ok, r1.message)
const r2 = svc.createLabOrder({ 委托单位: '甲班', 联系电话: '', 送检样品: '渗滤液水样', 样品来源: '', 化验项目: '', 送检日期: '2026-10-07', 经办人: '' })
check('缺来源+缺项目可以登记受理', r2.ok, r2.message)
check('受理时提示卡在受理格', r2.message.includes('卡在受理格'))
const id2 = r2.id
const s1 = svc.startLabTesting(id2)
check('缺样品来源/化验项目不能开始检验', !s1.ok && s1.message.includes('样品来源') && s1.message.includes('化验项目'), s1.message)
// 跳过在检直接出报告（在受理态）
const rep1 = svc.issueLabReport(id2, { 报告编号: 'R-1', 检验结果: 'x', 检验结论: '合格' })
check('受理态不能跳过在检直接出报告', !rep1.ok, rep1.message)

// 2. 补齐资料后可开始检验
const sup = svc.supplementLabOrder(id2, { 样品来源: '调节池 10-07 采样', 化验项目: 'COD、氨氮', 联系电话: '8001' })
check('补资料成功', sup.ok, sup.message)
// 非受理态不能补资料
const s2 = svc.startLabTesting(id2)
check('补齐后可以开始检验', s2.ok, s2.message)
const sup2 = svc.supplementLabOrder(id2, { 样品来源: '改' })
check('离开受理后不能改基础资料', !sup2.ok, sup2.message)

// 3. 出报告：缺项拦截；发出后回写环保台账并生成待复核
const rep2 = svc.issueLabReport(id2, { 报告编号: '', 检验结果: 'COD 40', 检验结论: '合格' })
check('缺报告编号不能出报告', !rep2.ok, rep2.message)
const rep3 = svc.issueLabReport(id2, { 报告编号: 'RPT-202610-1001', 检验结果: 'COD 40 mg/L；氨氮 2.1 mg/L', 检验结论: '符合 GB 16889 表2 限值' })
check('在检态可以出报告', rep3.ok, rep3.message)
const emis = svc.listEntries('emission', { 来源委托单: byId(id2)['委托单号'] }).items
check('环保台账回写一条记录', emis.length === 1)
check('回写记录状态为待复核', emis[0]?.status === '待复核', emis[0]?.status)
check('回写记录带报告编号与实测结果', emis[0]?.['报告编号'] === 'RPT-202610-1001' && String(emis[0]?.['实测值']).includes('COD 40'))

// 4. 报告编号锁定：编号不许改；更正只能追加说明
const rep4 = svc.issueLabReport(id2, { 报告编号: 'RPT-CHANGED', 检验结果: 'COD 41', 检验结论: '合格' })
check('报告编号发出后不许改', !rep4.ok && rep4.message.includes('不许再改'), rep4.message)
// 用原编号重新出（退回再出场景）允许，结果可更新
const rep5 = svc.issueLabReport(id2, { 报告编号: 'RPT-202610-1001', 检验结果: 'COD 41 mg/L', 检验结论: '合格（修正）' })
check('沿用原报告编号可以更新结论', rep5.ok, rep5.message)
check('台账仍只有一条（不重复生成）', svc.listEntries('emission', { 来源委托单: byId(id2)['委托单号'] }).items.length === 1)

const cor0 = svc.correctLabReport(id2, '   ')
check('空更正说明被拦', !cor0.ok, cor0.message)
const cor1 = svc.correctLabReport(id2, '氨氮检出限表述更正，结论不变')
check('已出报告可补更正说明', cor1.ok, cor1.message)
const orderRow = byId(id2)
check('更正说明追加且编号未动', svc.labOrderHelpers().correctionsOf(orderRow).length === 1 && orderRow['报告编号'] === 'RPT-202610-1001')

// 5. 退回受理：必须写理由；归档后不能退
const ret0 = svc.returnLabOrder(id2, '')
check('退回受理不写理由被拦', !ret0.ok, ret0.message)
const ret1 = svc.returnLabOrder(id2, '样品留样不足，需重新送检')
check('写明理由可退回受理', ret1.ok && byId(id2).status === '受理', ret1.message)
check('退回理由进流转轨迹', svc.labOrderHelpers().traceOf(byId(id2)).some((t) => t.action === '退回受理' && t.remark?.includes('留样不足')))
check('退回后报告编号仍锁定保留', byId(id2)['报告编号'] === 'RPT-202610-1001')

// 6. 重复递送只记一次（不同分隔符/空格也算同一委托）
const dup = svc.createLabOrder({ 委托单位: '甲班 ', 联系电话: '', 送检样品: '渗滤液水样', 样品来源: '调节池', 化验项目: '氨氮,COD', 送检日期: '2026-10-07', 经办人: '' })
check('同单位同样品同项目重复递送被拦', !dup.ok && dup.message.includes('重复递送只记一次'), dup.message)

// 7. 归档：只有已出报告可归档；归档后锁死（含化验室自己）
svc.startLabTesting(id2)
svc.issueLabReport(id2, { 报告编号: 'RPT-202610-1001', 检验结果: 'COD 41 mg/L', 检验结论: '合格' })
const arc0 = svc.archiveLabOrder(id2)
check('已出报告可以归档', arc0.ok && byId(id2).status === '已归档', arc0.message)
check('归档后 pending=false', byId(id2).pending === false)
check('归档后不能开始检验', !svc.startLabTesting(id2).ok)
check('归档后不能再出报告', !svc.issueLabReport(id2, { 报告编号: 'X', 检验结果: 'y', 检验结论: 'z' }).ok)
check('归档后不能退回受理', !svc.returnLabOrder(id2, '想改').ok)
check('归档后不能补资料', !svc.supplementLabOrder(id2, { 样品来源: 'x' }).ok)
const corArc = svc.correctLabReport(id2, '归档后追加一条勘误')
check('归档后仍可补更正说明（状态不动）', corArc.ok && byId(id2).status === '已归档', corArc.message)
check('通用 runAction 对委托单一律拒绝', !svc.runAction('laborder', id2, '归档').ok)

// 8. 在检态不能直接归档（跳状态）
const r3 = svc.createLabOrder({ 委托单位: '乙班', 联系电话: '', 送检样品: '炉渣样', 样品来源: '2#炉 10-07', 化验项目: '热灼减率', 送检日期: '2026-10-07', 经办人: '' })
svc.startLabTesting(r3.id)
check('在检态不能直接归档', !svc.archiveLabOrder(r3.id).ok)

// 9. 出报告更正后台账待复核记录刷新为最新结论
const labRow = byId(id2)
const em = svc.listEntries('emission', { 来源委托单: labRow['委托单号'] }).items[0]
check('台账待复核记录随更正刷新', em?.status === '待复核' && String(em['实测值']).includes('COD 41'))

console.log(`\n结果：${passed} 通过，${failed} 失败`)
process.exit(failed > 0 ? 1 : 0)
