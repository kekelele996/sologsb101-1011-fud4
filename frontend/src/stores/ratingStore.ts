/**
 * 定线 store：维护水位流量关系点据、比测记录、定线参数与残差派生值。
 * 涨、落两条支线分别定线（共用基线 H0），点据的曲线流量 / 残差 / 比测按所属支线计算。
 * 供关系点据页（/ratings）与导出页（/export）共用。
 */
import { defineStore } from 'pinia'
import { computed, ref } from 'vue'
import { db, createId, watchTable } from '@/utils/db'
import type { Compare } from '@/types/compare'
import { DEVIATION_LIMIT_PCT, calcDeviationPct, judgeDeviation, type CompareRow } from '@/types/compare'
import type { LoopFitResult, Rating } from '@/types/rating'
import {
  LIMB_LABELS,
  createEmptyRatingFilter,
  curveFlow,
  fillMissingLimbs,
  fitLoopCurve,
  type RatingFilterState
} from '@/types/rating'
import type { Station } from '@/types/station'

export const useRatingStore = defineStore('rating', () => {
  const ratings = ref<Rating[]>([])
  const compares = ref<Compare[]>([])
  const stations = ref<Station[]>([])
  const ready = ref(false)
  const error = ref<string | null>(null)
  const filter = ref<RatingFilterState>(createEmptyRatingFilter())
  /** 当前定线号与绳套定线参数（跨页保留） */
  const activeLineNo = ref<string>('A')
  const fits = ref<LoopFitResult[]>([])
  const deviationLimitPct = ref<number>(DEVIATION_LIMIT_PCT)

  let started = false

  function start(): void {
    if (started) return
    started = true
    watchTable<Rating>(() => db.ratings).subscribe((rows) => {
      // 老数据可能没有涨落归属，按时间顺序补方向（迁移与导入已处理，这里兜底）
      ratings.value = fillMissingLimbs(rows)
      ready.value = true
      error.value = null
    })
    watchTable<Compare>(() => db.compares).subscribe((rows) => {
      compares.value = rows
    })
    watchTable<Station>(() => db.stations).subscribe((rows) => {
      stations.value = rows
    })
  }

  const lineNos = computed<string[]>(() => {
    const set = new Set<string>()
    ratings.value.forEach((rating) => set.add(rating.lineNo))
    return Array.from(set).sort((a, b) => a.localeCompare(b))
  })

  const stationNameOf = (stationId: string): string =>
    stations.value.find((station) => station.id === stationId)?.name ?? '未知测站'

  /** 逐定线号的绳套拟合结果（涨、落支线共用基线、分别拟合） */
  const allLoopFits = computed<LoopFitResult[]>(() =>
    lineNos.value.map((lineNo) => {
      const points = ratings.value
        .filter((rating) => rating.lineNo === lineNo)
        .map((rating) => ({ stageM: rating.stageM, flowM3s: rating.flowM3s, limb: rating.limb }))
      return fitLoopCurve(points, lineNo)
    })
  )

  const activeLoopFit = computed<LoopFitResult>(() => {
    const cached = fits.value.find((fit) => fit.lineNo === activeLineNo.value)
    if (cached) return cached
    const computedFit = allLoopFits.value.find((fit) => fit.lineNo === activeLineNo.value)
    if (computedFit) return computedFit
    return fitLoopCurve([], activeLineNo.value)
  })

  /** 点据 + 所属支线的曲线流量 + 残差 */
  const pointRows = computed(() =>
    ratings.value
      .filter((rating) => rating.lineNo === activeLineNo.value)
      .sort((a, b) => a.stageM - b.stageM)
      .map((rating) => {
        const limbFit = rating.limb === 'rising' ? activeLoopFit.value.rising : activeLoopFit.value.falling
        const predicted = limbFit.valid ? curveFlow(limbFit, rating.stageM) : 0
        const residualPct =
          limbFit.valid && rating.flowM3s > 0
            ? Number((((rating.flowM3s - predicted) / rating.flowM3s) * 100).toFixed(2))
            : 0
        return { rating, predicted, residualPct }
      })
  )

  /** 按筛选条件过滤后的点据 */
  const filteredRatings = computed<Rating[]>(() =>
    ratings.value.filter((rating) => {
      const keyword = filter.value.keyword.trim()
      if (keyword.length > 0) {
        const haystack = `${rating.measureNo}${rating.lineNo}${LIMB_LABELS[rating.limb]}${stationNameOf(rating.stationId)}`
        if (!haystack.includes(keyword)) return false
      }
      if (filter.value.stationIds.length > 0 && !filter.value.stationIds.includes(rating.stationId)) return false
      if (filter.value.lineNos.length > 0 && !filter.value.lineNos.includes(rating.lineNo)) return false
      if (filter.value.verdicts.length > 0) {
        const compare = compares.value.find((item) => item.ratingId === rating.id)
        if (!compare || !filter.value.verdicts.includes(compare.verdict)) return false
      }
      return true
    })
  )

  const hasFilter = computed<boolean>(
    () =>
      filter.value.keyword.trim().length > 0 ||
      filter.value.stationIds.length > 0 ||
      filter.value.lineNos.length > 0 ||
      filter.value.verdicts.length > 0
  )

  /** 比测行：比测记录 + 点据 + 测站名，导出页与分析清单消费 */
  const compareRows = computed<CompareRow[]>(() =>
    compares.value
      .map((compare) => {
        const rating = ratings.value.find((item) => item.id === compare.ratingId) ?? null
        return {
          compare,
          rating,
          stationName: rating ? stationNameOf(rating.stationId) : '点据已删除',
          lineNo: rating?.lineNo ?? '-'
        }
      })
      .sort((a, b) => Math.abs(b.compare.deviationPct) - Math.abs(a.compare.deviationPct))
  )

  const overLimitRows = computed<CompareRow[]>(() =>
    compareRows.value.filter((row) => row.compare.verdict === '超限')
  )

  /** 定线质量派生值：平均残差与合格点占比（按各定线号可定线支线统计） */
  const fitQuality = computed(() => {
    const valid = allLoopFits.value.filter((fit) => fit.valid)
    const meanResidual = valid.length
      ? Number((valid.reduce((sum, fit) => sum + fit.meanResidualPct, 0) / valid.length).toFixed(2))
      : 0
    const total = compareRows.value.length
    const over = overLimitRows.value.length
    return {
      validLineCount: valid.length,
      meanResidualPct: meanResidual,
      compareCount: total,
      overLimitCount: over,
      qualifyRatePct: total === 0 ? 0 : Number((((total - over) / total) * 100).toFixed(1))
    }
  })

  function patchFilter(patch: Partial<RatingFilterState>): void {
    filter.value = { ...filter.value, ...patch }
  }

  function resetFilter(): void {
    filter.value = createEmptyRatingFilter()
  }

  function setActiveLine(lineNo: string): void {
    activeLineNo.value = lineNo
  }

  function setFit(fit: LoopFitResult): void {
    const others = fits.value.filter((item) => item.lineNo !== fit.lineNo)
    fits.value = [...others, fit]
  }

  function setDeviationLimit(limit: number): void {
    deviationLimitPct.value = limit
  }

  async function createRating(
    payload: Omit<Rating, 'id' | 'createdAt' | 'updatedAt'>
  ): Promise<Rating> {
    const now = Date.now()
    const row: Rating = { ...payload, id: createId('rat'), createdAt: now, updatedAt: now }
    await db.ratings.put(row)
    return row
  }

  async function updateRating(id: string, patch: Partial<Rating>): Promise<void> {
    await db.ratings.update(id, { ...patch, updatedAt: Date.now() } as never)
  }

  async function removeRating(id: string): Promise<void> {
    await db.transaction('rw', [db.ratings, db.compares], async () => {
      await db.compares.where('ratingId').equals(id).delete()
      await db.ratings.delete(id)
    })
  }

  /**
   * 由点据生成 / 刷新比测记录：曲线流量取点据所属支线（涨水 / 落水）的拟合值，
   * 偏差超过限值自动判定超限并进入分析清单。
   * 支线未定线（点据不足 3 个）的点据不参与比测，其旧比测记录一并清除，
   * 不借用另一条支线的参数顶算。
   */
  async function rebuildCompares(lineNo?: string): Promise<number> {
    const targetLine = lineNo ?? activeLineNo.value
    const targets = ratings.value.filter((rating) => rating.lineNo === targetLine)
    const loop = fitLoopCurve(
      targets.map((rating) => ({ stageM: rating.stageM, flowM3s: rating.flowM3s, limb: rating.limb })),
      targetLine
    )
    setFit(loop)
    if (targets.length === 0) return 0
    const now = Date.now()
    const rows: Compare[] = []
    const keptRatingIds = new Set<string>()
    targets.forEach((rating) => {
      const limbFit = rating.limb === 'rising' ? loop.rising : loop.falling
      if (!limbFit.valid) return
      const predicted = curveFlow(limbFit, rating.stageM)
      const deviationPct = calcDeviationPct(rating.flowM3s, predicted)
      const existing = compares.value.find((item) => item.ratingId === rating.id)
      keptRatingIds.add(rating.id)
      rows.push({
        id: existing?.id ?? createId('cmp'),
        ratingId: rating.id,
        measuredFlow: rating.flowM3s,
        curveFlow: predicted,
        deviationPct,
        verdict: judgeDeviation(deviationPct, deviationLimitPct.value),
        operator: existing?.operator ?? '林昭',
        comparedAt: existing?.comparedAt ?? rating.measuredAt,
        createdAt: existing?.createdAt ?? now,
        updatedAt: now
      })
    })
    const targetIds = new Set(targets.map((rating) => rating.id))
    const staleIds = compares.value
      .filter((compare) => targetIds.has(compare.ratingId) && !keptRatingIds.has(compare.ratingId))
      .map((compare) => compare.id)
    await db.transaction('rw', [db.compares], async () => {
      if (staleIds.length > 0) await db.compares.bulkDelete(staleIds)
      if (rows.length > 0) await db.compares.bulkPut(rows)
    })
    return rows.length
  }

  /** 手工登记比测记录（导出页分析清单用） */
  async function createCompare(
    payload: Omit<Compare, 'id' | 'createdAt' | 'updatedAt' | 'deviationPct' | 'verdict'> & {
      deviationPct?: number
      verdict?: Compare['verdict']
    }
  ): Promise<Compare> {
    const now = Date.now()
    const deviationPct =
      payload.deviationPct ?? calcDeviationPct(payload.measuredFlow, payload.curveFlow)
    const row: Compare = {
      ...payload,
      deviationPct,
      verdict: payload.verdict ?? judgeDeviation(deviationPct, deviationLimitPct.value),
      id: createId('cmp'),
      createdAt: now,
      updatedAt: now
    }
    await db.compares.put(row)
    return row
  }

  async function updateCompare(id: string, patch: Partial<Compare>): Promise<void> {
    await db.compares.update(id, { ...patch, updatedAt: Date.now() } as never)
  }

  async function removeCompare(id: string): Promise<void> {
    await db.compares.delete(id)
  }

  return {
    ratings,
    compares,
    stations,
    ready,
    error,
    filter,
    activeLineNo,
    activeLoopFit,
    fits,
    deviationLimitPct,
    lineNos,
    allLoopFits,
    pointRows,
    filteredRatings,
    hasFilter,
    compareRows,
    overLimitRows,
    fitQuality,
    start,
    stationNameOf,
    patchFilter,
    resetFilter,
    setActiveLine,
    setFit,
    setDeviationLimit,
    createRating,
    updateRating,
    removeRating,
    rebuildCompares,
    createCompare,
    updateCompare,
    removeCompare
  }
})
