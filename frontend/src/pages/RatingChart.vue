<script setup lang="ts">
/**
 * 模块 5：/ratings 水位流量关系点据与定线
 * 涨水、落水两条支线分别做幂函数拟合 Q = a×(H-H0)^b（两条支线共用一条基线 H0），
 * 曲线图同时画出两条支线形成绳套；点据的曲线流量、残差与比测按所属支线计算，
 * 支线点据不足 3 个时该支线标未定线，不借用另一条支线的参数。
 */
import { computed, onMounted, reactive, ref } from 'vue'
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
import { LIMB_LABELS, curveFlow, type LimbFitResult, type Rating, type RatingLimb } from '@/types/rating'
import type { CompareVerdict } from '@/types/compare'
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
  limb: 'rising' as RatingLimb,
  measureNo: '',
  measuredAt: new Date().toISOString().slice(0, 16)
})

const loopFit = computed(() => ratingStore.activeLoopFit)
const lineNos = computed(() => (ratingStore.lineNos.length > 0 ? ratingStore.lineNos : ['A']))

/** 支线中文名（表格行数据为 any，经函数入参收窄类型） */
const limbLabel = (limb: RatingLimb): string => LIMB_LABELS[limb]

/** 当前定线号下的点据（曲线流量与残差按所属涨落支线计算） */
const pointRows = computed(() =>
  ratingStore.ratings
    .filter((rating) => rating.lineNo === ratingStore.activeLineNo)
    .sort((a, b) => a.stageM - b.stageM)
    .map((rating) => {
      const limbFit = rating.limb === 'rising' ? loopFit.value.rising : loopFit.value.falling
      const predicted = limbFit.valid ? curveFlow(limbFit, rating.stageM) : 0
      const residualPct =
        limbFit.valid && rating.flowM3s > 0
          ? Number((((rating.flowM3s - predicted) / rating.flowM3s) * 100).toFixed(2))
          : 0
      const compare = ratingStore.compares.find((item) => item.ratingId === rating.id)
      const verdict: CompareVerdict | '未定线' = !limbFit.valid
        ? '未定线'
        : compare?.verdict ?? (Math.abs(residualPct) > ratingStore.deviationLimitPct ? '超限' : '合格')
      return {
        rating,
        stationName: ratingStore.stationNameOf(rating.stationId),
        limbValid: limbFit.valid,
        predicted,
        residualPct,
        verdict
      }
    })
)

const risingCount = computed(() => pointRows.value.filter((row) => row.rating.limb === 'rising').length)
const fallingCount = computed(() => pointRows.value.length - risingCount.value)

/** 绳套定线状态提示：双线有效 / 单线有效 / 均未定线 */
const loopAlert = computed<{ type: 'success' | 'warning'; title: string }>(() => {
  const loop = loopFit.value
  const limbText = (limbFit: LimbFitResult): string =>
    `${LIMB_LABELS[limbFit.limb]} Q = ${limbFit.a} × (H - ${limbFit.h0})^${limbFit.b}` +
    `（${limbFit.sampleCount} 点，平均残差 ${limbFit.meanResidualPct}%，最大 ${limbFit.maxResidualPct}%）`
  if (loop.rising.valid && loop.falling.valid) {
    return {
      type: 'success',
      title: `${loop.lineNo} 线绳套定线有效，涨、落支线共用基线 H0 = ${loop.h0} m：${limbText(loop.rising)}；${limbText(loop.falling)}`
    }
  }
  if (loop.rising.valid || loop.falling.valid) {
    const good = loop.rising.valid ? loop.rising : loop.falling
    const bad = loop.rising.valid ? loop.falling : loop.rising
    return {
      type: 'warning',
      title: `${bad.message}。${LIMB_LABELS[good.limb]}支线有效：${limbText(good)}（共用基线 H0 = ${loop.h0} m）`
    }
  }
  return {
    type: 'warning',
    title:
      `${loop.lineNo} 线涨、落支线均未定线：每条支线至少 3 个点据` +
      `（当前涨水 ${loop.rising.sampleCount} 点、落水 ${loop.falling.sampleCount} 点），两条支线不互相借用参数`
  }
})

const filterModel = computed<FilterModel>(() => ({
  keyword: ratingStore.filter.keyword,
  stationIds: ratingStore.filter.stationIds,
  lineNos: ratingStore.filter.lineNos,
  verdicts: ratingStore.filter.verdicts
}))

/** 关系曲线坐标：横轴水位、纵轴流量，涨落两条支线各自采样 */
const chart = computed(() => {
  const rows = pointRows.value
  if (rows.length === 0) {
    return {
      risingSamples: '',
      fallingSamples: '',
      points: [] as Array<{ id: string; cx: number; cy: number; limb: RatingLimb; verdict: string }>,
      stageMin: 0,
      stageMax: 0,
      flowMax: 0
    }
  }
  const stages = rows.map((row) => row.rating.stageM)
  const stageMin = Math.min(...stages)
  const stageMax = Math.max(...stages)
  const left = 52
  const right = 328
  const top = 20
  const bottom = 190
  // 每条支线只在自身点据的水位范围内采样，避免跨支线外推
  const sampleLimb = (limbFit: LimbFitResult): Array<[number, number]> => {
    if (!limbFit.valid) return []
    const limbStages = rows.filter((row) => row.rating.limb === limbFit.limb).map((row) => row.rating.stageM)
    if (limbStages.length === 0) return []
    const min = Math.min(...limbStages)
    const max = Math.max(...limbStages)
    const sampleCount = 13
    return Array.from({ length: sampleCount }, (_, index) => {
      const stageM = min + ((max - min) * index) / (sampleCount - 1)
      return [stageM, limbFit.a * Math.pow(Math.max(stageM - limbFit.h0, 1e-6), limbFit.b)]
    })
  }
  const risingSamples = sampleLimb(loopFit.value.rising)
  const fallingSamples = sampleLimb(loopFit.value.falling)
  const flowMax =
    Math.max(
      ...rows.map((row) => row.rating.flowM3s),
      ...risingSamples.map((sample) => sample[1]),
      ...fallingSamples.map((sample) => sample[1])
    ) * 1.1
  const toX = (stageM: number): number =>
    stageMax - stageMin < 1e-6 ? (left + right) / 2 : left + ((stageM - stageMin) / (stageMax - stageMin)) * (right - left)
  const toY = (flowM3s: number): number => bottom - (flowM3s / flowMax) * (bottom - top)
  const toSamples = (samples: Array<[number, number]>): string =>
    samples.map(([stageM, flow]) => `${toX(stageM).toFixed(1)},${toY(flow).toFixed(1)}`).join(' ')
  return {
    risingSamples: toSamples(risingSamples),
    fallingSamples: toSamples(fallingSamples),
    points: rows.map((row) => ({
      id: row.rating.id,
      cx: toX(row.rating.stageM),
      cy: toY(row.rating.flowM3s),
      limb: row.rating.limb,
      verdict: row.verdict
    })),
    stageMin,
    stageMax,
    flowMax
  }
})

/** 点据颜色：跟随所属支线，超限一律挂红 */
function pointFill(point: { limb: RatingLimb; verdict: string }): string {
  if (point.verdict === '超限') return '#c0392b'
  return point.limb === 'rising' ? '#eb984e' : '#7fd1e8'
}

function pointStroke(point: { limb: RatingLimb; verdict: string }): string {
  if (point.verdict === '超限') return '#7b241c'
  return point.limb === 'rising' ? '#a04000' : '#0f4c75'
}

function openCreate(): void {
  editingId.value = null
  form.stationId = stationStore.currentStationId ?? stationStore.stations[0]?.id ?? ''
  form.lineNo = ratingStore.activeLineNo
  form.limb = 'rising'
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
  form.limb = rating.limb
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
      limb: form.limb,
      measureNo: form.measureNo.trim(),
      measuredAt: form.measuredAt ? new Date(form.measuredAt).toISOString() : new Date().toISOString()
    }
    if (editingId.value) {
      await ratingStore.updateRating(editingId.value, payload)
      ElMessage.success('点据已更新')
    } else {
      await ratingStore.createRating(payload)
      ElMessage.success('点据已新增，正在重算定线')
    }
    ratingStore.setActiveLine(payload.lineNo)
    dialogVisible.value = false
    await ratingStore.rebuildCompares(payload.lineNo)
  } finally {
    submitting.value = false
  }
}

async function removeRating(rating: Rating): Promise<void> {
  try {
    await ElMessageBox.confirm(
      `删除水位 ${rating.stageM.toFixed(2)} m 处的${LIMB_LABELS[rating.limb]}点据将同时删除其比测记录，确认删除？`,
      '删除确认',
      { type: 'warning', confirmButtonText: '删除', cancelButtonText: '取消' }
    )
  } catch {
    return
  }
  await ratingStore.removeRating(rating.id)
  await ratingStore.rebuildCompares(rating.lineNo)
  ElMessage.success('点据已删除并重算定线')
}

async function refit(): Promise<void> {
  const count = await ratingStore.rebuildCompares(ratingStore.activeLineNo)
  const loop = ratingStore.activeLoopFit
  const limbText = (limbFit: LimbFitResult): string =>
    limbFit.valid
      ? `${LIMB_LABELS[limbFit.limb]} Q = ${limbFit.a}×(H-${limbFit.h0})^${limbFit.b}（平均残差 ${limbFit.meanResidualPct}%）`
      : `${LIMB_LABELS[limbFit.limb]}未定线（${limbFit.sampleCount} 点）`
  if (loop.rising.valid && loop.falling.valid) {
    ElMessage.success(
      `绳套定线完成（涨落共用基线 H0 = ${loop.h0} m）：${limbText(loop.rising)}；${limbText(loop.falling)}，刷新比测 ${count} 条`
    )
  } else if (loop.valid) {
    ElMessage.warning(
      `仅一条支线完成定线：${limbText(loop.rising)}；${limbText(loop.falling)}。未定线支线不借用另一支线参数，已刷新比测 ${count} 条`
    )
  } else {
    ElMessage.warning(loop.message || '涨、落支线点据均不足，无法定线')
  }
}

function handleLineChange(lineNo: string | number | boolean | undefined): void {
  ratingStore.setActiveLine(String(lineNo))
  void ratingStore.rebuildCompares(String(lineNo))
}

function handleFilterChange(): void {
  void router.replace({
    query: {
      ...(ratingStore.filter.keyword.trim() ? { kw: ratingStore.filter.keyword.trim() } : {}),
      ...(ratingStore.filter.stationIds.length ? { stations: ratingStore.filter.stationIds.join(',') } : {}),
      ...(ratingStore.filter.lineNos.length ? { lines: ratingStore.filter.lineNos.join(',') } : {}),
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
  ratingStore.patchFilter({
    keyword: typeof query.kw === 'string' ? query.kw : '',
    stationIds: typeof query.stations === 'string' ? query.stations.split(',') : [],
    lineNos: typeof query.lines === 'string' ? query.lines.split(',') : [],
    verdicts:
      typeof query.verdict === 'string'
        ? (query.verdict.split(',').filter((item) => item === '合格' || item === '超限') as Array<'合格' | '超限'>)
        : []
  })
  void ratingStore.rebuildCompares(ratingStore.activeLineNo)
})
</script>

<template>
  <section class="page">
    <div class="gb-brand-bar" />

    <div class="page__head">
      <div>
        <h2 class="page__title">水位流量关系点据与定线</h2>
        <p class="gb-hint">
          点据按定线号分组，涨水、落水两条支线分别做幂函数拟合 Q = a×(H-H0)^b（两条支线共用一条基线 H0），
          残差超过 {{ ratingStore.deviationLimitPct }}% 的点据自动挂红并进入比测分析清单。
        </p>
      </div>
      <div class="page__actions">
        <el-select
          :model-value="ratingStore.activeLineNo"
          class="page__line-select"
          @change="handleLineChange"
        >
          <el-option v-for="lineNo in lineNos" :key="lineNo" :label="`${lineNo} 线`" :value="lineNo" />
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
          key: 'verdicts',
          label: '判定',
          options: [
            { label: '合格', value: '合格' },
            { label: '超限', value: '超限' }
          ]
        }
      ]"
      keyword-placeholder="搜索测次号 / 定线号 / 涨落 / 测站"
      @change="handleFilterChange"
      @reset="handleReset"
    />

    <div class="gb-stats-row">
      <StatBadge
        :label="`${ratingStore.activeLineNo} 线点据`"
        :value="pointRows.length"
        :suffix="`涨 ${risingCount} · 落 ${fallingCount}`"
        icon="DataLine"
      />
      <StatBadge
        label="共用基线 H0"
        :value="loopFit.valid ? `${loopFit.h0} m` : '—'"
        :suffix="loopFit.valid ? '涨落共用一条' : '未定线'"
        tone="info"
        icon="Odometer"
      />
      <StatBadge
        label="涨水支线 a"
        :value="loopFit.rising.valid ? loopFit.rising.a : '—'"
        :suffix="loopFit.rising.valid ? `b=${loopFit.rising.b} · ${loopFit.rising.sampleCount} 点` : '未定线'"
        tone="warning"
        icon="TrendCharts"
      />
      <StatBadge
        label="落水支线 a"
        :value="loopFit.falling.valid ? loopFit.falling.a : '—'"
        :suffix="loopFit.falling.valid ? `b=${loopFit.falling.b} · ${loopFit.falling.sampleCount} 点` : '未定线'"
        tone="info"
        icon="TrendCharts"
      />
      <StatBadge
        label="超限点据"
        :value="pointRows.filter((row) => row.verdict === '超限').length"
        suffix="点"
        :tone="pointRows.some((row) => row.verdict === '超限') ? 'danger' : 'success'"
        :icon="pointRows.some((row) => row.verdict === '超限') ? 'WarningFilled' : 'DataLine'"
      />
    </div>

    <el-alert :type="loopAlert.type" show-icon :closable="false" :title="loopAlert.title" />

    <div class="page__grid">
      <EmptyPanel
        v-if="pointRows.length === 0"
        title="该定线号下还没有关系点据"
        description="录入实测水位与流量点据并标记涨落支线后即可分线定线；也可以先切换到其他定线号查看已有成果。"
        action-text="新增点据"
        @action="openCreate"
      />

      <el-table v-else :data="pointRows" border stripe class="gb-table-compact">
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
        <el-table-column label="支线" width="90" align="center">
          <template #default="{ row }">
            <el-tag size="small" effect="plain" :type="row.rating.limb === 'rising' ? 'warning' : 'primary'">
              {{ limbLabel(row.rating.limb) }}
            </el-tag>
          </template>
        </el-table-column>
        <el-table-column label="曲线流量 (m³/s)" width="140" align="right">
          <template #default="{ row }">
            <span class="gb-mono">{{ row.predicted > 0 ? row.predicted.toFixed(1) : '—' }}</span>
          </template>
        </el-table-column>
        <el-table-column label="残差" width="200">
          <template #default="{ row }">
            <el-tag v-if="!row.limbValid" type="info" size="small" effect="plain">支线未定线</el-tag>
            <DeviationTag
              v-else
              :deviation-pct="row.residualPct"
              :verdict="row.verdict === '未定线' ? undefined : row.verdict"
              :limit="ratingStore.deviationLimitPct"
            />
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
        <el-table-column label="操作" width="160" fixed="right">
          <template #default="{ row }">
            <el-button size="small" :icon="Edit" @click="openEdit(row.rating)">编辑</el-button>
            <el-button size="small" type="danger" plain :icon="Delete" @click="removeRating(row.rating)">删除</el-button>
          </template>
        </el-table-column>
      </el-table>

      <el-card shadow="never" class="page__chart-card">
        <div class="gb-panel-title">
          <h3>{{ ratingStore.activeLineNo }} 线绳套关系曲线</h3>
          <el-icon><TrendCharts /></el-icon>
        </div>
        <svg v-if="pointRows.length > 0" viewBox="0 0 360 220" class="page__chart">
          <line x1="52" y1="190" x2="340" y2="190" stroke="#b9cfdd" />
          <line x1="52" y1="20" x2="52" y2="190" stroke="#b9cfdd" />
          <text x="6" y="24" class="gb-chart-axis">{{ chart.flowMax.toFixed(0) }}</text>
          <text x="14" y="194" class="gb-chart-axis">0</text>
          <text x="52" y="208" class="gb-chart-axis">{{ chart.stageMin.toFixed(2) }}</text>
          <text x="300" y="208" class="gb-chart-axis">{{ chart.stageMax.toFixed(2) }} m</text>
          <polyline
            v-if="chart.risingSamples"
            :points="chart.risingSamples"
            fill="none"
            stroke="#d35400"
            stroke-width="2"
          />
          <polyline
            v-if="chart.fallingSamples"
            :points="chart.fallingSamples"
            fill="none"
            stroke="#0f4c75"
            stroke-width="2"
            stroke-dasharray="5 3"
          />
          <circle
            v-for="point in chart.points"
            :key="point.id"
            :cx="point.cx"
            :cy="point.cy"
            r="4.5"
            :fill="pointFill(point)"
            :stroke="pointStroke(point)"
          />
        </svg>
        <EmptyPanel v-else title="暂无可绘制的点据" description="录入点据后自动生成绳套关系曲线。" compact />
        <div class="page__legend">
          <span class="page__legend-item"><i class="page__legend-line" />涨水支线（实线）</span>
          <span class="page__legend-item"><i class="page__legend-line page__legend-line--falling" />落水支线（虚线）</span>
          <span class="page__legend-item"><i class="page__legend-dot" />超限点据</span>
        </div>
        <p class="gb-hint">
          涨、落支线共用一条基线 H0 = {{ loopFit.valid ? `${loopFit.h0} m` : '—' }}，各自拟合 a、b；
          点据颜色同所属支线，红色为残差超限点据；支线点据不足 3 个时该支线未定线。
        </p>
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
        <el-form-item label="涨落支线" required>
          <el-radio-group v-model="form.limb">
            <el-radio-button value="rising">涨水</el-radio-button>
            <el-radio-button value="falling">落水</el-radio-button>
          </el-radio-group>
          <span class="page__unit">无归属的老点据已按时间顺序自动补方向</span>
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

.page__line-select {
  width: 120px;
}

.page__grid {
  display: grid;
  grid-template-columns: minmax(520px, 1.5fr) minmax(320px, 1fr);
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

.page__legend {
  display: flex;
  flex-wrap: wrap;
  gap: 14px;
  margin-top: 4px;
  font-size: 12px;
  color: #5b6b78;
}

.page__legend-item {
  display: inline-flex;
  align-items: center;
  gap: 6px;
}

.page__legend-line {
  display: inline-block;
  width: 22px;
  height: 0;
  border-top: 2px solid #d35400;
}

.page__legend-line--falling {
  border-top: 2px dashed #0f4c75;
}

.page__legend-dot {
  display: inline-block;
  width: 9px;
  height: 9px;
  border-radius: 50%;
  background: #c0392b;
  border: 1px solid #7b241c;
}

.page__unit {
  margin-left: 8px;
  font-size: 12px;
  color: #8194a2;
}

.page__full {
  width: 100%;
}

@media (max-width: 1180px) {
  .page__grid {
    grid-template-columns: 1fr;
  }
}
</style>
