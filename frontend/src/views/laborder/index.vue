<template>
  <section class="page" data-module="laborder">
    <header class="page-head">
      <div>
        <h2>化验室检测委托管理</h2>
        <p class="page-desc">受理检测委托单，管住送检样品、化验项目与报告编号：受理 → 在检 → 出报告 → 归档，状态只许顺流，归档即锁死。</p>
      </div>
      <div class="page-actions">
        <button class="btn primary" type="button" @click="openCreate">登记检测委托单</button>
        <button class="btn" type="button" @click="exportRows">导出委托清单</button>
      </div>
    </header>

    <div class="stat-row">
      <article v-for="item in stats" :key="item.label" class="stat-card">
        <span class="stat-label">{{ item.label }}</span>
        <strong class="stat-value">{{ item.value }}</strong>
      </article>
    </div>

    <p class="status-legend">
      <span v-for="item in statusSummary" :key="item.status" class="legend-item">
        {{ item.status }}：{{ item.count }}
      </span>
    </p>

    <form class="filter-bar" @submit.prevent="reload">
      <label class="filter-item">
        <span>委托单号 / 报告编号</span>
        <input v-model="filters.kw" placeholder="按委托单号或报告编号检索" />
      </label>
      <label class="filter-item">
        <span>送检样品 / 样品来源</span>
        <input v-model="filters.sample" placeholder="按样品或来源检索" />
      </label>
      <label class="filter-item">
        <span>流转状态</span>
        <select v-model="filters.status">
          <option value="">全部</option>
          <option v-for="status in statuses" :key="status" :value="status">{{ status }}</option>
        </select>
      </label>
      <button class="btn" type="submit">查询</button>
      <button class="btn ghost" type="button" @click="resetFilters">重置条件</button>
    </form>

    <table class="data-table">
      <thead>
        <tr>
          <th v-for="column in columns" :key="column">{{ column }}</th>
          <th>当前状态</th>
          <th>可执行动作</th>
        </tr>
      </thead>
      <tbody>
        <tr v-for="row in rows" :key="String(row.id)">
          <td>{{ row['委托单号'] ?? '—' }}</td>
          <td>{{ row['委托单位'] ?? '—' }}</td>
          <td>{{ row['送检样品'] ?? '—' }}</td>
          <td>
            <span :class="{ 'cell-warn': !String(row['样品来源'] ?? '').trim() }">
              {{ row['样品来源'] || '缺来源' }}
            </span>
          </td>
          <td>
            <span :class="{ 'cell-warn': itemsOf(row).length === 0 }">
              {{ itemsOf(row).join('、') || '缺项目' }}
            </span>
          </td>
          <td>
            <span v-if="row['报告编号']" class="locked-no">{{ row['报告编号'] }} 🔒</span>
            <span v-else class="muted-text">未发号</span>
          </td>
          <td>{{ row['送检日期'] ?? '—' }}</td>
          <td>{{ row.status }}</td>
          <td class="row-actions">
            <template v-if="row.status === '受理'">
              <button class="link" type="button" @click="openSupplement(row)">补充资料</button>
              <button class="link" type="button" @click="startTesting(row)">开始检验</button>
            </template>
            <template v-else-if="row.status === '在检'">
              <button class="link" type="button" @click="openReport(row)">出具报告</button>
              <button class="link danger" type="button" @click="openReturn(row)">退回受理</button>
            </template>
            <template v-else-if="row.status === '已出报告'">
              <button class="link" type="button" @click="archive(row)">归档</button>
              <button class="link" type="button" @click="openCorrect(row)">补更正说明</button>
              <button class="link danger" type="button" @click="openReturn(row)">退回受理</button>
            </template>
            <template v-else>
              <button class="link" type="button" @click="openCorrect(row)">补更正说明</button>
              <span class="muted-text">状态已锁死</span>
            </template>
            <button class="link" type="button" @click="openDetail(row)">流转记录</button>
          </td>
        </tr>
        <tr v-if="!rows.length">
          <td :colspan="columns.length + 2" class="empty-state">暂无检测委托单，可先登记一笔送检委托</td>
        </tr>
      </tbody>
    </table>

    <footer class="page-foot">
      <span>共 {{ total }} 张检测委托单</span>
      <span v-if="message" :class="messageOk ? 'ok-text' : 'error-text'">{{ message }}</span>
    </footer>

    <!-- 登记委托单 -->
    <div v-if="createOpen" class="modal-mask" @click.self="createOpen = false">
      <div class="modal">
        <h3>登记检测委托单</h3>
        <div class="form-grid">
          <label><span>委托单位 *</span><input v-model="createForm.委托单位" placeholder="如：运行甲班 / 飞灰固化班组" /></label>
          <label><span>联系电话</span><input v-model="createForm.联系电话" placeholder="电话或便签留的联系方式" /></label>
          <label class="full"><span>送检样品 *</span><input v-model="createForm.送检样品" placeholder="样品名称/批次，如：FA-20261005-2 固化块" /></label>
          <label class="full">
            <span>样品来源</span>
            <input v-model="createForm.样品来源" placeholder="采样点位/批次；不填的单子会卡在受理格" />
          </label>
          <label class="full">
            <span>化验项目</span>
            <input v-model="createForm.化验项目" placeholder="多个项目用顿号或逗号分隔；不填的单子会卡在受理格" />
          </label>
          <label><span>送检日期</span><input v-model="createForm.送检日期" type="date" /></label>
          <label><span>经办人</span><input v-model="createForm.经办人" /></label>
        </div>
        <p class="modal-hint">同单位、同样品、同化验项目的委托重复递送只记一次。</p>
        <div class="modal-actions">
          <button class="btn ghost" type="button" @click="createOpen = false">取消</button>
          <button class="btn primary" type="button" @click="submitCreate">受理登记</button>
        </div>
      </div>
    </div>

    <!-- 受理阶段补资料 -->
    <div v-if="supplementOpen" class="modal-mask" @click.self="supplementOpen = false">
      <div class="modal">
        <h3>补充资料 · {{ supplementForm.委托单号 }}</h3>
        <div class="form-grid">
          <label class="full">
            <span>样品来源</span>
            <input v-model="supplementForm.样品来源" placeholder="采样点位/批次" />
          </label>
          <label class="full">
            <span>化验项目</span>
            <input v-model="supplementForm.化验项目" placeholder="多个项目用顿号或逗号分隔" />
          </label>
          <label class="full">
            <span>联系电话</span>
            <input v-model="supplementForm.联系电话" />
          </label>
        </div>
        <div class="modal-actions">
          <button class="btn ghost" type="button" @click="supplementOpen = false">取消</button>
          <button class="btn primary" type="button" @click="submitSupplement">保存资料</button>
        </div>
      </div>
    </div>

    <!-- 出具报告 -->
    <div v-if="reportOpen" class="modal-mask" @click.self="reportOpen = false">
      <div class="modal">
        <h3>出具报告 · {{ reportForm.委托单号 }}</h3>
        <div class="form-grid">
          <label class="full">
            <span>报告编号 *</span>
            <input
              v-model="reportForm.报告编号"
              :disabled="!!reportForm.lockedNo"
              :placeholder="reportForm.lockedNo ? '' : '发出后锁定，不可再改'"
            />
            <small v-if="reportForm.lockedNo" class="modal-hint">原报告编号 {{ reportForm.lockedNo }} 已锁定，只能沿用。</small>
          </label>
          <label class="full">
            <span>检验结果 *</span>
            <textarea v-model="reportForm.检验结果" rows="3" placeholder="逐项实测值"></textarea>
          </label>
          <label class="full">
            <span>检验结论 *</span>
            <textarea v-model="reportForm.检验结论" rows="2" placeholder="合格/不合格判定及依据；结论出来后环保监控会多一条待复核记录"></textarea>
          </label>
        </div>
        <div class="modal-actions">
          <button class="btn ghost" type="button" @click="reportOpen = false">取消</button>
          <button class="btn primary" type="button" @click="submitReport">出具报告</button>
        </div>
      </div>
    </div>

    <!-- 退回受理 -->
    <div v-if="returnOpen" class="modal-mask" @click.self="returnOpen = false">
      <div class="modal">
        <h3>退回受理 · {{ returnForm.委托单号 }}</h3>
        <label class="full block-label">
          <span>退回理由 *</span>
          <textarea v-model="returnForm.reason" rows="4" placeholder="必须写清理由，理由会进流转轨迹"></textarea>
        </label>
        <div class="modal-actions">
          <button class="btn ghost" type="button" @click="returnOpen = false">取消</button>
          <button class="btn primary danger-btn" type="button" @click="submitReturn">确认退回</button>
        </div>
      </div>
    </div>

    <!-- 补更正说明 -->
    <div v-if="correctOpen" class="modal-mask" @click.self="correctOpen = false">
      <div class="modal">
        <h3>补更正说明 · {{ correctForm.委托单号 }}</h3>
        <p class="modal-hint">报告编号 {{ correctForm.报告编号 }} 已锁定，不改动原报告，只追加一条更正说明。</p>
        <label class="full block-label">
          <span>更正内容 *</span>
          <textarea v-model="correctForm.note" rows="4" placeholder="写明更正项、更正前后内容与原因"></textarea>
        </label>
        <div class="modal-actions">
          <button class="btn ghost" type="button" @click="correctOpen = false">取消</button>
          <button class="btn primary" type="button" @click="submitCorrect">追加更正</button>
        </div>
      </div>
    </div>

    <!-- 流转记录 / 详情 -->
    <div v-if="detailOpen" class="modal-mask" @click.self="detailOpen = false">
      <div class="modal modal-wide">
        <h3>委托单详情 · {{ detail?.['委托单号'] }}</h3>
        <template v-if="detail">
          <table class="detail-table">
            <tbody>
              <tr><th>当前状态</th><td>{{ detail.status }}</td><th>报告编号</th><td>{{ detail['报告编号'] || '未发号' }}</td></tr>
              <tr><th>委托单位</th><td>{{ detail['委托单位'] }}</td><th>联系电话</th><td>{{ detail['联系电话'] || '—' }}</td></tr>
              <tr><th>送检样品</th><td>{{ detail['送检样品'] }}</td><th>样品来源</th><td>{{ detail['样品来源'] || '缺来源' }}</td></tr>
              <tr><th>化验项目</th><td colspan="3">{{ itemsOf(detail).join('、') || '缺项目' }}</td></tr>
              <tr><th>检验结果</th><td colspan="3">{{ detail['检验结果'] || '—' }}</td></tr>
              <tr><th>检验结论</th><td colspan="3">{{ detail['检验结论'] || '—' }}</td></tr>
            </tbody>
          </table>

          <h4>更正说明</h4>
          <ul v-if="correctionsOf(detail).length" class="note-list">
            <li v-for="(note, i) in correctionsOf(detail)" :key="i">{{ note }}</li>
          </ul>
          <p v-else class="muted-text">暂无更正说明。</p>

          <h4>流转轨迹</h4>
          <ol class="trace-list">
            <li v-for="(entry, i) in traceOf(detail)" :key="i">
              <strong>{{ entry.action }}</strong>
              <span class="muted-text">{{ entry.at }} · {{ entry.by }}</span>
              <span v-if="entry.from || entry.to" class="muted-text">{{ entry.from || '—' }} → {{ entry.to }}</span>
              <span v-if="entry.remark" class="trace-remark">备注：{{ entry.remark }}</span>
            </li>
          </ol>
        </template>
        <div class="modal-actions">
          <button class="btn primary" type="button" @click="detailOpen = false">关闭</button>
        </div>
      </div>
    </div>
  </section>
</template>

<script setup lang="ts">
import { computed, onMounted, reactive, ref } from 'vue'

import {
  archiveLabOrder,
  correctLabReport,
  createLabOrder,
  downloadEntries,
  issueLabReport,
  labOrderHelpers,
  listEntries,
  moduleMeta,
  returnLabOrder,
  startLabTesting,
  supplementLabOrder,
} from '@/api/local-service'
import type { EntryRow } from '@/data/types'

const meta = moduleMeta('laborder')
const columns = ['委托单号', '委托单位', '送检样品', '样品来源', '化验项目', '报告编号', '送检日期']
const statuses = ['受理', '在检', '已出报告', '已归档']
const { itemsOf, correctionsOf, traceOf } = labOrderHelpers()

const rows = ref<EntryRow[]>([])
const total = ref(0)
const message = ref('')
const messageOk = ref(true)
const filters = ref<Record<string, string>>({ kw: '', sample: '', status: '' })

const stats = computed(() => [
  { label: '受理中委托单', value: rows.value.filter((row) => row.status === '受理').length },
  { label: '在检委托单', value: rows.value.filter((row) => row.status === '在检').length },
  { label: '已出报告待归档', value: rows.value.filter((row) => row.status === '已出报告').length },
  { label: '已归档委托单', value: rows.value.filter((row) => row.status === '已归档').length },
])

const statusSummary = computed(() =>
  statuses.map((status) => ({ status, count: rows.value.filter((row) => row.status === status).length })),
)

function flash(ok: boolean, text: string) {
  messageOk.value = ok
  message.value = text
}

function resetFilters() {
  filters.value = { kw: '', sample: '', status: '' }
  reload()
}

function exportRows() {
  downloadEntries(meta.key)
}

function reload() {
  message.value = ''
  const kw = filters.value.kw.trim()
  const sample = filters.value.sample.trim()
  let matched = listEntries(meta.key).items
  if (kw) {
    matched = matched.filter(
      (row) => String(row['委托单号'] ?? '').includes(kw) || String(row['报告编号'] ?? '').includes(kw),
    )
  }
  if (sample) {
    matched = matched.filter(
      (row) =>
        String(row['送检样品'] ?? '').includes(sample) ||
        String(row['样品来源'] ?? '').includes(sample),
    )
  }
  if (filters.value.status) {
    matched = matched.filter((row) => row.status === filters.value.status)
  }
  rows.value = matched
  total.value = matched.length
}

// ---- 登记 ----
const createOpen = ref(false)
const today = new Date().toISOString().slice(0, 10)
const createForm = reactive({
  委托单位: '',
  联系电话: '',
  送检样品: '',
  样品来源: '',
  化验项目: '',
  送检日期: today,
  经办人: '',
})

function openCreate() {
  Object.assign(createForm, {
    委托单位: '',
    联系电话: '',
    送检样品: '',
    样品来源: '',
    化验项目: '',
    送检日期: today,
    经办人: '',
  })
  createOpen.value = true
}

function submitCreate() {
  const result = createLabOrder({ ...createForm })
  flash(result.ok, result.message)
  if (result.ok) {
    createOpen.value = false
    reload()
  }
}

// ---- 补资料 ----
const supplementOpen = ref(false)
const supplementTarget = ref<EntryRow | null>(null)
const supplementForm = reactive({ 委托单号: '', 样品来源: '', 化验项目: '', 联系电话: '' })

function openSupplement(row: EntryRow) {
  supplementTarget.value = row
  Object.assign(supplementForm, {
    委托单号: String(row['委托单号'] ?? ''),
    样品来源: String(row['样品来源'] ?? ''),
    化验项目: itemsOf(row).join('、'),
    联系电话: String(row['联系电话'] ?? ''),
  })
  supplementOpen.value = true
}

function submitSupplement() {
  if (!supplementTarget.value) {
    return
  }
  const result = supplementLabOrder(Number(supplementTarget.value.id), { ...supplementForm })
  flash(result.ok, result.message)
  if (result.ok) {
    supplementOpen.value = false
    reload()
  }
}

// ---- 开始检验 ----
function startTesting(row: EntryRow) {
  const result = startLabTesting(Number(row.id))
  flash(result.ok, result.message)
  if (result.ok) {
    reload()
  }
}

// ---- 出报告 ----
const reportOpen = ref(false)
const reportTarget = ref<EntryRow | null>(null)
const reportForm = reactive({ 委托单号: '', 报告编号: '', 检验结果: '', 检验结论: '', lockedNo: '' })

function openReport(row: EntryRow) {
  reportTarget.value = row
  const lockedNo = String(row['报告编号'] ?? '')
  Object.assign(reportForm, {
    委托单号: String(row['委托单号'] ?? ''),
    报告编号: lockedNo,
    lockedNo,
    检验结果: String(row['检验结果'] ?? ''),
    检验结论: String(row['检验结论'] ?? ''),
  })
  reportOpen.value = true
}

function submitReport() {
  if (!reportTarget.value) {
    return
  }
  const result = issueLabReport(Number(reportTarget.value.id), {
    报告编号: reportForm.报告编号,
    检验结果: reportForm.检验结果,
    检验结论: reportForm.检验结论,
  })
  flash(result.ok, result.message)
  if (result.ok) {
    reportOpen.value = false
    reload()
  }
}

// ---- 归档 ----
function archive(row: EntryRow) {
  const result = archiveLabOrder(Number(row.id))
  flash(result.ok, result.message)
  if (result.ok) {
    reload()
  }
}

// ---- 退回受理 ----
const returnOpen = ref(false)
const returnTarget = ref<EntryRow | null>(null)
const returnForm = reactive({ 委托单号: '', reason: '' })

function openReturn(row: EntryRow) {
  returnTarget.value = row
  returnForm.委托单号 = String(row['委托单号'] ?? '')
  returnForm.reason = ''
  returnOpen.value = true
}

function submitReturn() {
  if (!returnTarget.value) {
    return
  }
  const result = returnLabOrder(Number(returnTarget.value.id), returnForm.reason)
  flash(result.ok, result.message)
  if (result.ok) {
    returnOpen.value = false
    reload()
  }
}

// ---- 更正说明 ----
const correctOpen = ref(false)
const correctTarget = ref<EntryRow | null>(null)
const correctForm = reactive({ 委托单号: '', 报告编号: '', note: '' })

function openCorrect(row: EntryRow) {
  correctTarget.value = row
  correctForm.委托单号 = String(row['委托单号'] ?? '')
  correctForm.报告编号 = String(row['报告编号'] ?? '')
  correctForm.note = ''
  correctOpen.value = true
}

function submitCorrect() {
  if (!correctTarget.value) {
    return
  }
  const result = correctLabReport(Number(correctTarget.value.id), correctForm.note)
  flash(result.ok, result.message)
  if (result.ok) {
    correctOpen.value = false
    reload()
  }
}

// ---- 详情 / 流转记录 ----
const detailOpen = ref(false)
const detail = ref<EntryRow | null>(null)

function openDetail(row: EntryRow) {
  detail.value = row
  detailOpen.value = true
}

onMounted(reload)
</script>
