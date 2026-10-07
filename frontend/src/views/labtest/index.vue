<template>
  <section class="page" data-module="labtest">
    <header class="page-head">
      <div>
        <h2>化验室检测委托管理</h2>
        <p class="page-desc">受理 → 在检 → 出报告 → 归档一条线流转；缺样品来源或化验项目卡在受理，报告编号签发后锁定，归档后一律锁死。</p>
      </div>
      <div class="page-actions">
        <button class="btn primary" type="button" @click="openCreate">受理新委托单</button>
        <button class="btn" type="button" @click="exportRows">导出委托单清单</button>
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
      <label v-for="field in filterFields" :key="field" class="filter-item">
        <span>{{ field }}</span>
        <input v-model="filters[field]" :placeholder="`按${field}检索`" />
      </label>
      <label class="filter-item">
        <span>状态</span>
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
        <tr v-for="row in visibleRows" :key="String(row.id)">
          <td v-for="column in columns" :key="column">{{ row[column] || '—' }}</td>
          <td>
            {{ row.status }}
            <span v-if="row.abnormal && row.退回原因" class="legend-item">已退回</span>
            <span v-if="row.更正说明" class="legend-item">有更正</span>
          </td>
          <td class="row-actions">
            <template v-for="action in actionsFor(row)" :key="action">
              <button v-if="action === '出具报告'" class="link" type="button" @click="openReport(row)">
                {{ action }}
              </button>
              <button v-else-if="action === '返回受理'" class="link" type="button" @click="openReturn(row)">
                {{ action }}
              </button>
              <button v-else class="link" type="button" @click="doAction(action, row)">{{ action }}</button>
            </template>
            <button v-if="canEdit(row)" class="link" type="button" @click="openEdit(row)">补录信息</button>
            <button v-if="canCorrect(row)" class="link" type="button" @click="openCorrect(row)">补更正说明</button>
            <span v-if="actionsFor(row).length === 0 && !canEdit(row) && !canCorrect(row)" class="page-desc">—</span>
          </td>
        </tr>
        <tr v-if="!visibleRows.length">
          <td :colspan="columns.length + 2" class="empty-state">暂无检测委托单，可先受理一张新委托</td>
        </tr>
      </tbody>
    </table>

    <footer class="page-foot">
      <span>共 {{ total }} 张检测委托单 · 结果出具后自动回写环保采样台账与待复核监控记录</span>
      <span v-if="errorMessage" class="error-text">{{ errorMessage }}</span>
      <span v-else-if="okMessage" class="ok-text">{{ okMessage }}</span>
    </footer>

    <!-- 受理/补录 -->
    <div v-if="createOpen" class="modal-mask" @click.self="closeCreate">
      <div class="modal-card">
        <h3>{{ editingId ? '补录委托单信息（受理格）' : '受理新检测委托单' }}</h3>
        <p class="page-desc">样品来源、化验项目缺一项，单子就会卡在受理，无法开始检验。</p>
        <div class="form-grid">
          <label v-for="field in createFields" :key="field" class="form-item">
            <span>{{ field }}</span>
            <input
              v-model="createForm[field]"
              :placeholder="`请填${field}`"
              :disabled="Boolean(editingId) && field === '委托单号'"
            />
          </label>
        </div>
        <p v-if="formError" class="error-text">{{ formError }}</p>
        <div class="modal-actions">
          <button class="btn ghost" type="button" @click="closeCreate">取消</button>
          <button class="btn primary" type="button" @click="submitCreate">
            {{ editingId ? '保存补录' : '受理委托' }}
          </button>
        </div>
      </div>
    </div>

    <!-- 出报告 -->
    <div v-if="reportOpen" class="modal-mask" @click.self="reportOpen = false">
      <div class="modal-card">
        <h3>出具检验报告 · {{ activeRow?.委托单号 }}</h3>
        <p class="page-desc">提交后系统自动签发报告编号并锁定；结果同步回写采样台账，环保监控新增一条待复核记录。</p>
        <div class="form-grid single">
          <label class="form-item">
            <span>检验结果 *</span>
            <textarea v-model="reportForm.result" rows="3" placeholder="如：COD 42 mg/L；氨氮 1.5 mg/L"></textarea>
          </label>
          <label class="form-item">
            <span>检验结论 *</span>
            <textarea v-model="reportForm.conclusion" rows="3" placeholder="如：符合排放限值，判定合格"></textarea>
          </label>
        </div>
        <p v-if="formError" class="error-text">{{ formError }}</p>
        <div class="modal-actions">
          <button class="btn ghost" type="button" @click="reportOpen = false">取消</button>
          <button class="btn primary" type="button" @click="submitReport">签发报告并回写</button>
        </div>
      </div>
    </div>

    <!-- 退回受理 -->
    <div v-if="returnOpen" class="modal-mask" @click.self="returnOpen = false">
      <div class="modal-card">
        <h3>退回受理 · {{ activeRow?.委托单号 }}</h3>
        <p class="page-desc">从「在检」退回「受理」必须写清原因，单子将带着退回原因回到受理格。</p>
        <div class="form-grid single">
          <label class="form-item">
            <span>退回原因 *</span>
            <textarea v-model="returnForm.reason" rows="3" placeholder="如：样品标签污损无法确认来源，需送检方重新确认"></textarea>
          </label>
        </div>
        <p v-if="formError" class="error-text">{{ formError }}</p>
        <div class="modal-actions">
          <button class="btn ghost" type="button" @click="returnOpen = false">取消</button>
          <button class="btn primary" type="button" @click="submitReturn">确认退回受理</button>
        </div>
      </div>
    </div>

    <!-- 更正说明 -->
    <div v-if="correctOpen" class="modal-mask" @click.self="correctOpen = false">
      <div class="modal-card">
        <h3>补更正说明 · 报告 {{ activeRow?.报告编号 }}</h3>
        <p class="page-desc">报告编号、检验结果与结论均不可再改，只能在此追加一条更正说明（带日期留痕）。</p>
        <div v-if="activeRow?.更正说明" class="note-history">{{ activeRow.更正说明 }}</div>
        <div class="form-grid single">
          <label class="form-item">
            <span>新增更正说明 *</span>
            <textarea v-model="correctForm.note" rows="3" placeholder="如：报告限值标准年号引用有误，应以GBxxxx-2024为准，结论不变"></textarea>
          </label>
        </div>
        <p v-if="formError" class="error-text">{{ formError }}</p>
        <div class="modal-actions">
          <button class="btn ghost" type="button" @click="correctOpen = false">取消</button>
          <button class="btn primary" type="button" @click="submitCorrect">追加更正说明</button>
        </div>
      </div>
    </div>
  </section>
</template>

<script setup lang="ts">
import { computed, onMounted, reactive, ref } from 'vue'

import {
  appendReportCorrection,
  createLabOrder,
  runLabAction,
  updateLabOrder,
} from '@/api/lab-service'
import { downloadEntries, listEntries } from '@/api/local-service'
import type { EntryRow } from '@/data/types'

const columns = [
  "委托单号", "样品编号", "样品来源", "送检样品", "化验项目",
  "委托单位", "委托人", "受理日期", "检验结果", "检验结论", "报告编号", "更正说明", "退回原因", "委托状态",
]
const statuses = ["受理", "在检", "已出报告", "已归档"]
// 动作严格顺着主线给出：受理只能开始检验，在检出报告或带理由退回，出报告后只能归档，归档无动作。
const ACTIONS_BY_STATUS: Record<string, string[]> = {
  "受理": ["开始检验"],
  "在检": ["出具报告", "返回受理"],
  "已出报告": ["归档"],
  "已归档": [],
}
const createFields = ["委托单号", "样品编号", "样品来源", "送检样品", "化验项目", "委托单位", "委托人", "受理日期"]
type CreateField = (typeof createFields)[number]

const allRows = ref<EntryRow[]>([])
const total = computed(() => visibleRows.value.length)
const errorMessage = ref('')
const okMessage = ref('')
const filters = ref<Record<string, string>>({})
const filterFields = ["委托单号", "样品编号", "送检样品", "化验项目"]

// 文本字段交给 listEntries 模糊匹配，状态下拉在本地再收一道。
const visibleRows = computed(() =>
  filters.value.status
    ? allRows.value.filter((row) => String(row.status) === filters.value.status)
    : allRows.value,
)

const stats = computed(() => [
  { label: '受理中', value: allRows.value.filter((r) => String(r.status) === '受理').length },
  { label: '在检委托单', value: allRows.value.filter((r) => String(r.status) === '在检').length },
  { label: '待归档（已出报告）', value: allRows.value.filter((r) => String(r.status) === '已出报告').length },
  { label: '已归档委托单', value: allRows.value.filter((r) => String(r.status) === '已归档').length },
])
const statusSummary = computed(() =>
  statuses.map((status) => ({ status, count: allRows.value.filter((r) => String(r.status) === status).length })),
)

function actionsFor(row: EntryRow): string[] {
  return ACTIONS_BY_STATUS[String(row.status)] ?? []
}
function canEdit(row: EntryRow): boolean {
  return String(row.status) === '受理'
}
function canCorrect(row: EntryRow): boolean {
  return String(row.报告编号) !== '' && String(row.status) !== '已归档'
}

// ---- 受理 / 补录弹窗 ----
const createOpen = ref(false)
const editingId = ref<number | null>(null)
const createForm = reactive<Record<CreateField, string>>({
  委托单号: '', 样品编号: '', 样品来源: '', 送检样品: '', 化验项目: '', 委托单位: '', 委托人: '', 受理日期: '',
})
const formError = ref('')

function resetCreateForm() {
  for (const field of createFields) {
    createForm[field] = ''
  }
}

function openCreate() {
  editingId.value = null
  resetCreateForm()
  formError.value = ''
  createOpen.value = true
}

function openEdit(row: EntryRow) {
  editingId.value = Number(row.id)
  for (const field of createFields) {
    createForm[field] = String(row[field] ?? '')
  }
  formError.value = ''
  createOpen.value = true
}

function closeCreate() {
  createOpen.value = false
}

function submitCreate() {
  formError.value = ''
  if (editingId.value === null) {
    const result = createLabOrder({ ...createForm })
    if (!result.ok) {
      formError.value = result.message
      return
    }
    okMessage.value = result.message
  } else {
    const result = updateLabOrder(editingId.value, {
      样品编号: createForm.样品编号,
      样品来源: createForm.样品来源,
      送检样品: createForm.送检样品,
      化验项目: createForm.化验项目,
      委托单位: createForm.委托单位,
      委托人: createForm.委托人,
      受理日期: createForm.受理日期,
    })
    if (!result.ok) {
      formError.value = result.message
      return
    }
    okMessage.value = result.message
  }
  createOpen.value = false
  reload()
}

// ---- 出报告弹窗 ----
const reportOpen = ref(false)
const reportForm = reactive({ result: '', conclusion: '' })

function openReport(row: EntryRow) {
  activeRow.value = row
  reportForm.result = ''
  reportForm.conclusion = ''
  formError.value = ''
  reportOpen.value = true
}

function submitReport() {
  if (!activeRow.value) {
    return
  }
  formError.value = ''
  const result = runLabAction(Number(activeRow.value.id), '出具报告', {
    result: reportForm.result,
    conclusion: reportForm.conclusion,
  })
  if (!result.ok) {
    formError.value = result.message
    return
  }
  reportOpen.value = false
  okMessage.value = result.message
  reload()
}

// ---- 退回受理弹窗 ----
const returnOpen = ref(false)
const returnForm = reactive({ reason: '' })

function openReturn(row: EntryRow) {
  activeRow.value = row
  returnForm.reason = ''
  formError.value = ''
  returnOpen.value = true
}

function submitReturn() {
  if (!activeRow.value) {
    return
  }
  formError.value = ''
  const result = runLabAction(Number(activeRow.value.id), '返回受理', { reason: returnForm.reason })
  if (!result.ok) {
    formError.value = result.message
    return
  }
  returnOpen.value = false
  okMessage.value = result.message
  reload()
}

// ---- 更正说明弹窗 ----
const correctOpen = ref(false)
const correctForm = reactive({ note: '' })
const activeRow = ref<EntryRow | null>(null)

function openCorrect(row: EntryRow) {
  activeRow.value = row
  correctForm.note = ''
  formError.value = ''
  correctOpen.value = true
}

function submitCorrect() {
  if (!activeRow.value) {
    return
  }
  formError.value = ''
  const result = appendReportCorrection(Number(activeRow.value.id), correctForm.note)
  if (!result.ok) {
    formError.value = result.message
    return
  }
  correctOpen.value = false
  okMessage.value = result.message
  reload()
}

// ---- 无需弹窗的动作 ----
function doAction(action: string, row: EntryRow) {
  errorMessage.value = ''
  const result = runLabAction(Number(row.id), action)
  if (!result.ok) {
    errorMessage.value = result.message
    return
  }
  okMessage.value = result.message
  reload()
}

function resetFilters() {
  filters.value = {}
  reload()
}

function exportRows() {
  downloadEntries('labtest')
}

function reload() {
  errorMessage.value = ''
  try {
    const payload = listEntries('labtest', {
      委托单号: filters.value.委托单号 ?? '',
      样品编号: filters.value.样品编号 ?? '',
      送检样品: filters.value.送检样品 ?? '',
      化验项目: filters.value.化验项目 ?? '',
    })
    allRows.value = payload.items
  } catch (error) {
    errorMessage.value = error instanceof Error ? error.message : '检测委托单列表读取失败'
  }
}

onMounted(reload)
</script>
