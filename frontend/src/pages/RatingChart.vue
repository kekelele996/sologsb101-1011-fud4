<script setup lang="ts">
/**
 * 模块 5：/ratings 水位流量关系点据与分线定线
 * 同一测站、同一定线号下按涨水 / 落水两条支线分别做幂函数拟合
 * Q = a×(H-H0)^b（两条支线共用一条基线 H0），曲线图同框绘出绳套；
 * 点据的曲线流量、残差与比测均按所属支线计算。
 */
import { computed, onMounted, reactive, ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { ElMessage, ElMessageBox } from 'element-plus'
import { Delete, Edit, Plus, Refresh, TrendCharts } from '@element-plus/icons-vue'
import FilterBar from '@/components/common/FilterBar.vue'
import type { FilterModel } from '@/types/filter'
import StatBadge from '@/components/common/StatBadge.vue'
import DeviationTag from '@/components/common/DeviationTag.vue'
import EmptyPanel from '@/components/common/EmptyPanel.vue'
import { useRatingStore } from '@/stores/ratingStore'
import { useStationStore } from '@/stores/stationStore'
import {
  TREND_LABELS,
  fitRatingGroup,
  type Rating,
  type RatingFitResult,
  type RatingTrend
} from '@/types/rating'
import { initDatabase } from '@/utils/db'

const route = useRoute()
const router = useRouter()
const ratingStore = useRatingStore()
const stationStore = useStationStore()

const dialogVisible = ref(false)
const editingId = ref<string | null>(null)
const submitting = ref(false)
const form = reactive({
  stationId: '',
  stageM: 0,
  flowM3s: 0,
  lineNo: 'A',
  trend: 'rise' as RatingTrend,
  measureNo: '',
  measuredAt: new Date().toISOString().slice(0, 16)
})

/** 当前活跃分组的涨 / 落支线定线 */
const branchFits = computed(() => ratingStore.activeGroupFit)
const riseFit = computed<RatingFitResult>(() => branchFits.value.rise)
const fallFit = computed<RatingFitResult>(() => branchFits.value.fall)
/**
 * 基线策略：两条支线各自独立搜索基线 H0、独立求 a、b（绳套两支水势动力不同，
 * 不共用基线，以免一支的异常点拖累另一支）；不足 3 点的支线标未定线。
 */
const baselineText = computed(() => {
  const parts: string[] = []
  if (riseFit.value.valid) parts.push(`涨水 H0 = ${riseFit.value.h0} m`)
  if (fallFit.value.valid) parts.push(`落水 H0 = ${fallFit.value.h0} m`)
  if (parts.length === 2) return `涨水、落水两条支线各自独立定基线（${parts.join('；')}），分别求 a、b`
  if (parts.length === 1) return `${parts[0]}（仅一条支线可定线，基线独立、不与另一支线共用）`
  return '两条支线点据均不足 3 个，暂未定基线'
})

const lineNos = computed(() => (ratingStore.lineNos.length > 0 ? ratingStore.lineNos : ['A']))
/** 当前测站下已有的定线号（切换测站时联动） */
const lineNosOfActiveStation = computed(() => {
  const set = new Set<string>(
    ratingStore.ratings
      .filter((rating) => rating.stationId === ratingStore.activeStationId)
      .map((rating) => rating.lineNo)
  )
  return Array.from(set).sort((a, b) => a.localeCompare(b))
})

const activeStationName = computed(
  () => ratingStore.stationNameOf(ratingStore.activeStationId || stationStore.stations[0]?.id || '')
)

/** 当前定线号下的点据（含所属支线、曲线流量与残差），涨水在前、落水在后 */
const pointRows = computed(() =>
  ratingStore.pointRows
    .map((row) => {
      const compare = ratingStore.compares.find((item) => item.ratingId === row.rating.id)
      const verdict =
        compare?.verdict ??
        (row.fit.valid
          ? Math.abs(row.residualPct) > ratingStore.deviationLimitPct
            ? '超限'
            : '合格'
          : '未定线')
      return {
        ...row,
        stationName: ratingStore.stationNameOf(row.rating.stationId),
        trendLabel: TREND_LABELS[row.trend],
        inferred: row.rating.trendInferred === true,
        verdict
      }
    })
    .sort((a, b) => {
      if (a.trend !== b.trend) return a.trend === 'rise' ? -1 : 1
      return a.rating.stageM - b.rating.stageM
    })
)

const riseRows = computed(() => pointRows.value.filter((row) => row.trend === 'rise'))
const fallRows = computed(() => pointRows.value.filter((row) => row.trend === 'fall'))
const overLimitCount = computed(() => pointRows.value.filter((row) => row.verdict === '超限').length)
const unfittedCount = computed(() => pointRows.value.filter((row) => row.verdict === '未定线').length)

const filterModel = computed<FilterModel>(() => ({
  keyword: ratingStore.filter.keyword,
  stationIds: ratingStore.filter.stationIds,
  lineNos: ratingStore.filter.lineNos,
  trends: ratingStore.filter.trends,
  verdicts: ratingStore.filter.verdicts
}))

/** 绳套关系曲线坐标：横轴水位、纵轴流量；涨水实线、落水虚线，同框成套 */
const chart = computed(() => {
  const empty = {
    riseSamples: '',
    fallSamples: '',
    riseArrow: null as null | { x: number; y: number; angle: number },
    fallArrow: null as null | { x: number; y: number; angle: number },
    points: [] as Array<{ id: string; cx: number; cy: number; trend: RatingTrend; verdict: string }>,
    stageMin: 0,
    stageMax: 0,
    flowMax: 0
  }
  const rows = pointRows.value
  if (rows.length === 0) return empty
  const stages = rows.map((row) => row.rating.stageM)
  const flows = rows.map((row) => row.rating.flowM3s)
  const stageMin = Math.min(...stages)
  const stageMax = Math.max(...stages)
  const flowMax = Math.max(...flows) * 1.1
  const left = 52
  const right = 328
  const top = 20
  const bottom = 190
  const toX = (stageM: number): number =>
    stageMax - stageMin < 1e-6 ? (left + right) / 2 : left + ((stageM - stageMin) / (stageMax - stageMin)) * (right - left)
  const toY = (flowM3s: number): number => bottom - (flowM3s / flowMax) * (bottom - top)

  const buildSamples = (fit: RatingFitResult, list: typeof rows): string => {
    if (!fit.valid || list.length === 0) return ''
    const min = Math.min(...list.map((row) => row.rating.stageM))
    const max = Math.max(...list.map((row) => row.rating.stageM))
    return Array.from({ length: 17 }, (_, index) => {
      const stageM = min + ((max - min) * index) / 16
      const value = fit.a * Math.pow(Math.max(stageM - fit.h0, 1e-6), fit.b)
      return `${toX(stageM).toFixed(1)},${toY(value).toFixed(1)}`
    }).join(' ')
  }
  /** 支线箭头：涨水指向高水位（右端），落水指向低水位（左端） */
  const buildArrow = (fit: RatingFitResult, list: typeof rows, atMax: boolean) => {
    if (!fit.valid || list.length < 2) return null
    const min = Math.min(...list.map((row) => row.rating.stageM))
    const max = Math.max(...list.map((row) => row.rating.stageM))
    const s1 = atMax ? max - 0.02 * (max - min || 1) : min + 0.02 * (max - min || 1)
    const s2 = atMax ? max : min
    const x1 = toX(s1)
    const y1 = toY(fit.a * Math.pow(Math.max(s1 - fit.h0, 1e-6), fit.b))
    const x2 = toX(s2)
    const y2 = toY(fit.a * Math.pow(Math.max(s2 - fit.h0, 1e-6), fit.b))
    return { x: x2, y: y2, angle: (Math.atan2(y2 - y1, x2 - x1) * 180) / Math.PI }
  }

  return {
    riseSamples: buildSamples(riseFit.value, riseRows.value),
    fallSamples: buildSamples(fallFit.value, fallRows.value),
    riseArrow: buildArrow(riseFit.value, riseRows.value, true),
    fallArrow: buildArrow(fallFit.value, fallRows.value, false),
    points: rows.map((row) => ({
      id: row.rating.id,
      cx: toX(row.rating.stageM),
      cy: toY(row.rating.flowM3s),
      trend: row.trend,
      verdict: row.verdict
    })),
    stageMin,
    stageMax,
    flowMax
  }
})

const pointColor = (point: { trend: RatingTrend; verdict: string }): { fill: string; stroke: string } => {
  if (point.verdict === '超限') return { fill: '#c0392b', stroke: '#7b241c' }
  return point.trend === 'rise'
    ? { fill: '#7fd1e8', stroke: '#0f4c75' }
    : { fill: '#f6c177', stroke: '#b9651a' }
}

function ensureActiveStation(): string {
  if (!ratingStore.activeStationId) {
    const first = stationStore.stations[0]?.id ?? ''
    ratingStore.setActiveStation(first)
  }
  return ratingStore.activeStationId
}

// 首屏 store 订阅可能尚未把测站推到页面：列表到达后自动锁定首个分组
watch(
  () => stationStore.stations,
  (stations) => {
    if (ratingStore.activeStationId || stations.length === 0) return
    const queryStations = typeof route.query.stations === 'string' ? route.query.stations.split(',') : []
    const preferred = queryStations.find((id) => stations.some((station) => station.id === id)) ?? stations[0].id
    const line = ratingStore.ratings.find((rating) => rating.stationId === preferred)?.lineNo ?? 'A'
    ratingStore.setActiveGroup(preferred, line)
    void ratingStore.rebuildCompares(undefined, preferred)
  }
)

function handleStationChange(stationId: string | number | boolean | undefined): void {
  const id = String(stationId)
  const line =
    ratingStore.ratings.find((rating) => rating.stationId === id)?.lineNo ?? ratingStore.activeLineNo
  ratingStore.setActiveGroup(id, line)
  void ratingStore.rebuildCompares(undefined, id)
}

function handleLineChange(lineNo: string | number | boolean | undefined): void {
  ratingStore.setActiveLine(String(lineNo))
  void ratingStore.rebuildCompares(String(lineNo), ratingStore.activeStationId)
}

function openCreate(): void {
  editingId.value = null
  form.stationId = ensureActiveStation() || stationStore.stations[0]?.id || ''
  form.lineNo = ratingStore.activeLineNo
  form.trend = 'rise'
  const last = pointRows.value[pointRows.value.length - 1]
  form.stageM = last ? Number((last.rating.stageM + 0.2).toFixed(2)) : 3
  form.flowM3s = last ? Number((last.rating.flowM3s * 1.2).toFixed(1)) : 50
  form.measureNo = `${new Date().getFullYear()}-${String(ratingStore.ratings.length + 1).padStart(3, '0')}`
  form.measuredAt = new Date().toISOString().slice(0, 16)
  dialogVisible.value = true
}

function openEdit(rating: Rating): void {
  editingId.value = rating.id
  form.stationId = rating.stationId
  form.stageM = rating.stageM
  form.flowM3s = rating.flowM3s
  form.lineNo = rating.lineNo
  form.trend = ratingStore.trendOf(rating)
  form.measureNo = rating.measureNo
  form.measuredAt = rating.measuredAt.slice(0, 16)
  dialogVisible.value = true
}

async function submitForm(): Promise<void> {
  if (!form.stationId) {
    ElMessage.warning('请选择所属测站')
    return
  }
  if (!Number.isFinite(form.stageM)) {
    ElMessage.warning('请填写水位（m）')
    return
  }
  if (!Number.isFinite(form.flowM3s) || form.flowM3s <= 0) {
    ElMessage.warning('流量应为大于 0 的数字（m³/s）')
    return
  }
  submitting.value = true
  try {
    const payload = {
      stationId: form.stationId,
      stageM: form.stageM,
      flowM3s: form.flowM3s,
      lineNo: form.lineNo.trim() || 'A',
      trend: form.trend,
      trendInferred: false,
      measureNo: form.measureNo.trim(),
      measuredAt: form.measuredAt ? new Date(form.measuredAt).toISOString() : new Date().toISOString()
    }
    if (editingId.value) {
      await ratingStore.updateRating(editingId.value, payload)
      ElMessage.success('点据已更新')
    } else {
      await ratingStore.createRating(payload)
      ElMessage.success('点据已新增，正在按涨 / 落支线重算定线')
    }
    ratingStore.setActiveGroup(payload.stationId, payload.lineNo)
    dialogVisible.value = false
    await ratingStore.rebuildCompares(payload.lineNo, payload.stationId)
  } finally {
    submitting.value = false
  }
}

async function removeRating(rating: Rating): Promise<void> {
  try {
    await ElMessageBox.confirm(
      `删除水位 ${rating.stageM.toFixed(2)} m 处的${TREND_LABELS[ratingStore.trendOf(rating)]}点据将同时删除其比测记录，确认删除？`,
      '删除确认',
      { type: 'warning', confirmButtonText: '删除', cancelButtonText: '取消' }
    )
  } catch {
    return
  }
  await ratingStore.removeRating(rating.id)
  await ratingStore.rebuildCompares(rating.lineNo, rating.stationId)
  ElMessage.success('点据已删除并按支线重算定线')
}

async function refit(): Promise<void> {
  const stationId = ratingStore.activeStationId
  const lineNo = ratingStore.activeLineNo
  const source = ratingStore.activeGroupRatings
  const pair = fitRatingGroup(
    stationId,
    lineNo,
    source.map((rating) => ({
      stageM: rating.stageM,
      flowM3s: rating.flowM3s,
      trend: ratingStore.trendOf(rating)
    }))
  )
  ratingStore.setGroupFits(pair)
  const count = await ratingStore.rebuildCompares(lineNo, stationId)
  const validParts = [pair.rise, pair.fall]
    .filter((fit) => fit.valid)
    .map((fit) => `${TREND_LABELS[fit.trend]}线 Q=${fit.a}×(H-${fit.h0})^${fit.b}，平均残差 ${fit.meanResidualPct}%`)
  if (validParts.length > 0) {
    ElMessage.success(`定线完成：${validParts.join('；')}；刷新比测 ${count} 条`)
  } else {
    ElMessage.warning('涨水、落水支线点据均不足 3 个，均未定线')
  }
}

function handleFilterChange(): void {
  void router.replace({
    query: {
      ...(ratingStore.filter.keyword.trim() ? { kw: ratingStore.filter.keyword.trim() } : {}),
      ...(ratingStore.filter.stationIds.length ? { stations: ratingStore.filter.stationIds.join(',') } : {}),
      ...(ratingStore.filter.lineNos.length ? { lines: ratingStore.filter.lineNos.join(',') } : {}),
      ...(ratingStore.filter.trends.length ? { trends: ratingStore.filter.trends.join(',') } : {}),
      ...(ratingStore.filter.verdicts.length ? { verdict: ratingStore.filter.verdicts.join(',') } : {})
    }
  })
}

function handleReset(): void {
  ratingStore.resetFilter()
  void router.replace({ query: {} })
}

onMounted(() => {
  if (stationStore.stations.length === 0) void initDatabase()
  const query = route.query
  const stationIds = typeof query.stations === 'string' ? query.stations.split(',') : []
  ratingStore.patchFilter({
    keyword: typeof query.kw === 'string' ? query.kw : '',
    stationIds,
    lineNos: typeof query.lines === 'string' ? query.lines.split(',') : [],
    trends:
      typeof query.trends === 'string'
        ? (query.trends.split(',').filter((item) => item === 'rise' || item === 'fall') as RatingTrend[])
        : [],
    verdicts:
      typeof query.verdict === 'string'
        ? (query.verdict
            .split(',')
            .filter((item) => item === '合格' || item === '超限' || item === '未定线') as Array<'合格' | '超限' | '未定线'>)
        : []
  })
  // 深链或首屏：锁定到一个具体「测站 + 定线号」分组，保证涨落支线同源
  if (!ratingStore.activeStationId) {
    ratingStore.setActiveStation(stationIds[0] ?? stationStore.stations[0]?.id ?? '')
  }
  void ratingStore.rebuildCompares()
})
</script>

<template>
  <section class="page">
    <div class="gb-brand-bar" />

    <div class="page__head">
      <div>
        <h2 class="page__title">水位流量关系点据与绳套定线</h2>
        <p class="gb-hint">
          同一测站、同一定线号下按涨水、落水两条支线分别拟合 Q = a×(H-H0)^b，两线同框成绳套；
          曲线流量、残差与比测均按点据所属支线计算，残差超过 {{ ratingStore.deviationLimitPct }}% 挂红。
        </p>
      </div>
      <div class="page__actions">
        <el-select
          :model-value="ratingStore.activeStationId"
          class="page__station-select"
          placeholder="选择测站"
          @change="handleStationChange"
        >
          <el-option
            v-for="station in stationStore.stations"
            :key="station.id"
            :label="station.name"
            :value="station.id"
          />
        </el-select>
        <el-select
          :model-value="ratingStore.activeLineNo"
          class="page__line-select"
          @change="handleLineChange"
        >
          <el-option
            v-for="lineNo in (lineNosOfActiveStation.length > 0 ? lineNosOfActiveStation : lineNos)"
            :key="lineNo"
            :label="`${lineNo} 线`"
            :value="lineNo"
          />
        </el-select>
        <el-button :icon="Refresh" @click="refit">重新定线</el-button>
        <el-button type="primary" :icon="Plus" @click="openCreate">新增点据</el-button>
      </div>
    </div>

    <FilterBar
      :model-value="filterModel"
      :selects="[
        {
          key: 'stationIds',
          label: '测站',
          options: stationStore.stations.map((station) => ({ label: station.name, value: station.id }))
        },
        { key: 'lineNos', label: '定线号', options: lineNos.map((lineNo) => ({ label: `${lineNo} 线`, value: lineNo })) },
        {
          key: 'trends',
          label: '支线',
          options: [
            { label: '涨水支线', value: 'rise' },
            { label: '落水支线', value: 'fall' }
          ]
        },
        {
          key: 'verdicts',
          label: '判定',
          options: [
            { label: '合格', value: '合格' },
            { label: '超限', value: '超限' },
            { label: '未定线', value: '未定线' }
          ]
        }
      ]"
      keyword-placeholder="搜索测次号 / 定线号 / 测站"
      @change="handleFilterChange"
      @reset="handleReset"
    />

    <div class="gb-stats-row">
      <StatBadge
        :label="`${activeStationName} · ${ratingStore.activeLineNo}线 点据`"
        :value="pointRows.length"
        suffix="点"
        icon="DataLine"
      />
      <StatBadge
        label="涨水支线"
        :value="riseFit.valid ? riseFit.a : '未定线'"
        :suffix="riseFit.valid ? `b=${riseFit.b}，残差 ${riseFit.meanResidualPct}%` : `${riseRows.length} 点`"
        tone="info"
        icon="TrendCharts"
      />
      <StatBadge
        label="落水支线"
        :value="fallFit.valid ? fallFit.a : '未定线'"
        :suffix="fallFit.valid ? `b=${fallFit.b}，残差 ${fallFit.meanResidualPct}%` : `${fallRows.length} 点`"
        tone="info"
        icon="TrendCharts"
      />
      <StatBadge
        label="超限 / 未定线"
        :value="`${overLimitCount} / ${unfittedCount}`"
        suffix="点"
        :tone="overLimitCount > 0 ? 'danger' : 'success'"
        :icon="overLimitCount > 0 ? 'WarningFilled' : 'DataLine'"
      />
    </div>

    <el-alert
      :type="riseFit.valid || fallFit.valid ? 'success' : 'warning'"
      show-icon
      :closable="false"
    >
      <template #title>
        <div class="page__fit-line">
          <span><strong>基线：</strong>{{ baselineText }}</span>
        </div>
        <div class="page__fit-line">
          <el-tag size="small" effect="plain" type="primary">涨水</el-tag>
          <span v-if="riseFit.valid">
            Q = {{ riseFit.a }} × (H - {{ riseFit.h0 }})^{{ riseFit.b }}；样本 {{ riseFit.sampleCount }} 点，
            平均残差 {{ riseFit.meanResidualPct }}%，最大 {{ riseFit.maxResidualPct }}%，R² {{ riseFit.r2 }}
          </span>
          <span v-else class="gb-hint">{{ riseFit.message }}（当前 {{ riseRows.length }} 点）</span>
        </div>
        <div class="page__fit-line">
          <el-tag size="small" effect="plain" type="warning">落水</el-tag>
          <span v-if="fallFit.valid">
            Q = {{ fallFit.a }} × (H - {{ fallFit.h0 }})^{{ fallFit.b }}；样本 {{ fallFit.sampleCount }} 点，
            平均残差 {{ fallFit.meanResidualPct }}%，最大 {{ fallFit.maxResidualPct }}%，R² {{ fallFit.r2 }}
          </span>
          <span v-else class="gb-hint">{{ fallFit.message }}（当前 {{ fallRows.length }} 点）</span>
        </div>
      </template>
    </el-alert>

    <div class="page__grid">
      <EmptyPanel
        v-if="pointRows.length === 0"
        title="该测站、该定线号下还没有关系点据"
        description="录入实测水位与流量点据并选择涨水 / 落水支线后即可分线定线；支线不足 3 点时标未定线。"
        action-text="新增点据"
        @action="openCreate"
      />

      <el-table v-else :data="pointRows" border stripe class="gb-table-compact" :row-class-name="rowClassName">
        <el-table-column label="支线" width="86" align="center">
          <template #default="{ row }">
            <el-tag size="small" :type="row.trend === 'rise' ? 'primary' : 'warning'" effect="plain">
              {{ row.trendLabel }}
            </el-tag>
            <el-tooltip v-if="row.inferred" content="该点据原为老数据、未记水势，方向按时间（洪峰前涨、峰后落）自动补定" placement="top">
              <el-icon class="page__inferred"><Warning /></el-icon>
            </el-tooltip>
          </template>
        </el-table-column>
        <el-table-column label="水位 (m)" width="100" align="right">
          <template #default="{ row }">
            <span class="gb-mono">{{ row.rating.stageM.toFixed(2) }}</span>
          </template>
        </el-table-column>
        <el-table-column label="实测流量 (m³/s)" width="140" align="right">
          <template #default="{ row }">
            <span class="gb-mono">{{ row.rating.flowM3s.toFixed(1) }}</span>
          </template>
        </el-table-column>
        <el-table-column label="曲线流量 (m³/s)" width="140" align="right">
          <template #default="{ row }">
            <span class="gb-mono">{{ row.predicted > 0 ? row.predicted.toFixed(1) : '—' }}</span>
          </template>
        </el-table-column>
        <el-table-column label="残差 / 比测" min-width="208">
          <template #default="{ row }">
            <DeviationTag
              v-if="row.verdict !== '未定线'"
              :deviation-pct="row.residualPct"
              :verdict="row.verdict"
              :limit="ratingStore.deviationLimitPct"
            />
            <el-tag v-else size="small" type="info" effect="plain">支线未定线</el-tag>
          </template>
        </el-table-column>
        <el-table-column label="测站 / 测次" min-width="170">
          <template #default="{ row }">
            <div>{{ row.stationName }}</div>
            <div class="gb-hint gb-mono">{{ row.rating.measureNo || '未标记测次' }}</div>
          </template>
        </el-table-column>
        <el-table-column label="点据时间" width="160">
          <template #default="{ row }">
            <span class="gb-mono">{{ new Date(row.rating.measuredAt).toLocaleDateString('zh-CN') }}</span>
          </template>
        </el-table-column>
        <el-table-column label="操作" width="150" fixed="right">
          <template #default="{ row }">
            <el-button size="small" :icon="Edit" @click="openEdit(row.rating)">编辑</el-button>
            <el-button size="small" type="danger" plain :icon="Delete" @click="removeRating(row.rating)">删除</el-button>
          </template>
        </el-table-column>
      </el-table>

      <el-card shadow="never" class="page__chart-card">
        <div class="gb-panel-title">
          <h3>{{ activeStationName }} · {{ ratingStore.activeLineNo }} 线绳套关系曲线</h3>
          <el-icon><TrendCharts /></el-icon>
        </div>
        <svg v-if="pointRows.length > 0" viewBox="0 0 360 220" class="page__chart">
          <line x1="52" y1="190" x2="340" y2="190" stroke="#b9cfdd" />
          <line x1="52" y1="20" x2="52" y2="190" stroke="#b9cfdd" />
          <text x="6" y="24" class="gb-chart-axis">{{ chart.flowMax.toFixed(0) }}</text>
          <text x="14" y="194" class="gb-chart-axis">0</text>
          <text x="52" y="208" class="gb-chart-axis">{{ chart.stageMin.toFixed(2) }}</text>
          <text x="300" y="208" class="gb-chart-axis">{{ chart.stageMax.toFixed(2) }} m</text>
          <!-- 落水支线（虚线，绘于下层） -->
          <polyline
            v-if="chart.fallSamples"
            :points="chart.fallSamples"
            fill="none"
            stroke="#d98324"
            stroke-width="2"
            stroke-dasharray="6 4"
          />
          <g v-if="chart.fallArrow" :transform="`translate(${chart.fallArrow.x},${chart.fallArrow.y}) rotate(${chart.fallArrow.angle})`">
            <path d="M0,0 L-7,-3.6 L-7,3.6 Z" fill="#d98324" />
          </g>
          <!-- 涨水支线（实线） -->
          <polyline
            v-if="chart.riseSamples"
            :points="chart.riseSamples"
            fill="none"
            stroke="#0f4c75"
            stroke-width="2"
          />
          <g v-if="chart.riseArrow" :transform="`translate(${chart.riseArrow.x},${chart.riseArrow.y}) rotate(${chart.riseArrow.angle})`">
            <path d="M0,0 L-7,-3.6 L-7,3.6 Z" fill="#0f4c75" />
          </g>
          <circle
            v-for="point in chart.points"
            :key="point.id"
            :cx="point.cx"
            :cy="point.cy"
            r="4.5"
            :fill="pointColor(point).fill"
            :stroke="pointColor(point).stroke"
          />
        </svg>
        <EmptyPanel v-else title="暂无可绘制的点据" description="录入点据后自动生成绳套关系曲线。" compact />
        <div class="page__legend">
          <span class="page__legend-item"><i class="page__legend-line is-rise" />涨水支线</span>
          <span class="page__legend-item"><i class="page__legend-line is-fall" />落水支线</span>
          <span class="page__legend-item"><i class="page__legend-dot is-rise" />涨水点据</span>
          <span class="page__legend-item"><i class="page__legend-dot is-fall" />落水点据</span>
          <span class="page__legend-item"><i class="page__legend-dot is-over" />超限点据</span>
        </div>
        <p class="gb-hint">箭头指向水势方向（涨水指向峰端、落水指向退水端）；支线不足 3 点时不绘线、不套用另一支线参数。</p>
      </el-card>
    </div>

    <el-dialog v-model="dialogVisible" :title="editingId ? '编辑关系点据' : '新增关系点据'" width="560px" :close-on-click-modal="false">
      <el-form label-width="110px">
        <el-form-item label="所属测站" required>
          <el-select v-model="form.stationId" placeholder="选择测站" class="page__full">
            <el-option v-for="station in stationStore.stations" :key="station.id" :label="station.name" :value="station.id" />
          </el-select>
        </el-form-item>
        <el-form-item label="定线号" required>
          <el-input v-model="form.lineNo" placeholder="如 A / B / C" maxlength="8" />
        </el-form-item>
        <el-form-item label="水势支线" required>
          <el-radio-group v-model="form.trend">
            <el-radio value="rise">涨水支线</el-radio>
            <el-radio value="fall">落水支线</el-radio>
          </el-radio-group>
          <span class="page__unit">同水位涨、落流量分别归属，避免互相牵制</span>
        </el-form-item>
        <el-form-item label="水位" required>
          <el-input-number v-model="form.stageM" :min="-50" :max="200" :step="0.01" :precision="2" controls-position="right" />
          <span class="page__unit">m</span>
        </el-form-item>
        <el-form-item label="流量" required>
          <el-input-number v-model="form.flowM3s" :min="0.01" :max="100000" :step="1" :precision="1" controls-position="right" />
          <span class="page__unit">m³/s</span>
        </el-form-item>
        <el-form-item label="测次号">
          <el-input v-model="form.measureNo" placeholder="如：2024-06-001" maxlength="32" />
        </el-form-item>
        <el-form-item label="点据时间">
          <el-date-picker v-model="form.measuredAt" type="datetime" value-format="YYYY-MM-DDTHH:mm" placeholder="选择时间" />
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="dialogVisible = false">取消</el-button>
        <el-button type="primary" :loading="submitting" @click="submitForm">
          {{ editingId ? '保存并重算' : '新增并定线' }}
        </el-button>
      </template>
    </el-dialog>
  </section>
</template>

<script lang="ts">
/** 支线行底色：涨水浅蓝、落水浅橙，表格与绳套配色一致 */
function rowClassName({ row }: { row: { trend?: RatingTrend } }): string {
  return row.trend === 'fall' ? 'page__row-fall' : 'page__row-rise'
}
</script>

<style scoped>
.page {
  display: flex;
  flex-direction: column;
  gap: 14px;
}

.page__head {
  display: flex;
  flex-wrap: wrap;
  align-items: flex-start;
  justify-content: space-between;
  gap: 12px;
}

.page__title {
  margin: 0 0 4px;
  font-size: 19px;
  color: #0f4c75;
}

.page__actions {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
}

.page__station-select {
  width: 170px;
}

.page__line-select {
  width: 104px;
}

.page__grid {
  display: grid;
  grid-template-columns: minmax(560px, 1.5fr) minmax(320px, 1fr);
  gap: 14px;
  align-items: start;
}

.page__chart-card {
  border: 1px solid #d8e4ec;
}

.page__chart {
  width: 100%;
  height: 240px;
}

.page__fit-line {
  display: flex;
  align-items: center;
  gap: 8px;
  line-height: 22px;
}

.page__fit-line + .page__fit-line {
  margin-top: 2px;
}

.page__inferred {
  margin-left: 4px;
  vertical-align: -2px;
  color: #b9770e;
}

.page__legend {
  display: flex;
  flex-wrap: wrap;
  gap: 12px;
  margin: 6px 0 2px;
  font-size: 12px;
  color: #5b6b78;
}

.page__legend-item {
  display: inline-flex;
  align-items: center;
  gap: 5px;
}

.page__legend-line {
  display: inline-block;
  width: 22px;
  height: 0;
  border-top: 3px solid #0f4c75;
}

.page__legend-line.is-fall {
  border-top: 3px dashed #d98324;
}

.page__legend-dot {
  display: inline-block;
  width: 9px;
  height: 9px;
  border-radius: 50%;
  background: #7fd1e8;
  border: 1px solid #0f4c75;
}

.page__legend-dot.is-fall {
  background: #f6c177;
  border-color: #b9651a;
}

.page__legend-dot.is-over {
  background: #c0392b;
  border-color: #7b241c;
}

.page__unit {
  margin-left: 8px;
  font-size: 12px;
  color: #8194a2;
}

.page__full {
  width: 100%;
}

:deep(.page__row-fall) {
  background: #fdf6ec;
}

:deep(.page__row-rise) {
  background: #f4fafe;
}

@media (max-width: 1180px) {
  .page__grid {
    grid-template-columns: 1fr;
  }
}
</style>
