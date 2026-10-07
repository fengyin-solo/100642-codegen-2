<template>
  <section class="page" data-module="sampleledger">
    <header class="page-head">
      <div>
        <h2>环保采样台账</h2>
        <p class="page-desc">检验结果在检测委托单「出具报告」时自动回写到本台账，同一张检测委托只记一次；台账记录不接受手工新增或改状态。</p>
      </div>
      <div class="page-actions">
        <button class="btn" type="button" @click="exportRows">导出台账清单</button>
      </div>
    </header>

    <div class="stat-row">
      <article class="stat-card">
        <span class="stat-label">台账记录数</span>
        <strong class="stat-value">{{ rows.length }}</strong>
      </article>
      <article class="stat-card">
        <span class="stat-label">本月回写</span>
        <strong class="stat-value">{{ monthCount }}</strong>
      </article>
    </div>

    <form class="filter-bar" @submit.prevent="reload">
      <label v-for="field in filterFields" :key="field" class="filter-item">
        <span>{{ field }}</span>
        <input v-model="filters[field]" :placeholder="`按${field}检索`" />
      </label>
      <button class="btn" type="submit">查询</button>
      <button class="btn ghost" type="button" @click="resetFilters">重置条件</button>
    </form>

    <table class="data-table">
      <thead>
        <tr>
          <th v-for="column in columns" :key="column">{{ column }}</th>
          <th>当前状态</th>
        </tr>
      </thead>
      <tbody>
        <tr v-for="row in rows" :key="String(row.id)">
          <td v-for="column in columns" :key="column">{{ row[column] || '—' }}</td>
          <td>{{ row.status }}</td>
        </tr>
        <tr v-if="!rows.length">
          <td :colspan="columns.length + 1" class="empty-state">台账暂无记录，检测委托单出具报告后会自动回写到这里</td>
        </tr>
      </tbody>
    </table>

    <footer class="page-foot">
      <span>共 {{ rows.length }} 条采样台账记录</span>
      <span v-if="errorMessage" class="error-text">{{ errorMessage }}</span>
    </footer>
  </section>
</template>

<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'

import { downloadEntries, listEntries } from '@/api/local-service'
import type { EntryRow } from '@/data/types'

const columns = ["台账编号", "关联委托单", "样品来源", "送检样品", "化验项目", "检验结果", "检验结论", "报告编号", "回写日期", "台账状态"]
const filterFields = ["台账编号", "关联委托单", "送检样品", "化验项目", "报告编号"]

const rows = ref<EntryRow[]>([])
const errorMessage = ref('')
const filters = ref<Record<string, string>>({})

const monthPrefix = new Date().toISOString().slice(0, 7)
const monthCount = computed(
  () => rows.value.filter((row) => String(row.回写日期 ?? '').startsWith(monthPrefix)).length,
)

function resetFilters() {
  filters.value = {}
  reload()
}

function exportRows() {
  downloadEntries('sampleledger')
}

function reload() {
  errorMessage.value = ''
  try {
    rows.value = listEntries('sampleledger', filters.value).items
  } catch (error) {
    errorMessage.value = error instanceof Error ? error.message : '采样台账读取失败'
  }
}

onMounted(reload)
</script>
