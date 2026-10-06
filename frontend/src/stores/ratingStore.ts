/**
 * 定线 store：维护水位流量关系点据、比测记录、分线定线参数与残差派生值。
 * 同一测站、同一定线号下的涨水 / 落水两条支线分别定线形成绳套，
 * 供关系点据页（/ratings）与导出页（/export）共用。
 */
import { defineStore } from 'pinia'
import { computed, ref } from 'vue'
import { db, createId, watchTable } from '@/utils/db'
import type { Compare } from '@/types/compare'
import { DEVIATION_LIMIT_PCT, calcDeviationPct, judgeDeviation, type CompareRow } from '@/types/compare'
import type { Rating, RatingFitResult, RatingTrend } from '@/types/rating'
import {
  buildBranchKey,
  createEmptyRatingFilter,
  curveFlow,
  fitRatingGroup,
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
  /** 当前测站与定线号（跨页保留） */
  const activeStationId = ref<string>('')
  const activeLineNo = ref<string>('A')
  /** 支线定线参数缓存（branchKey = stationId|lineNo|trend） */
  const fits = ref<RatingFitResult[]>([])
  const deviationLimitPct = ref<number>(DEVIATION_LIMIT_PCT)

  let started = false

  function start(): void {
    if (started) return
    started = true
    watchTable<Rating>(() => db.ratings).subscribe((rows) => {
      ratings.value = rows
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

  /** 规范化老数据缺失的水势字段（有 trend 字段用之，否则按涨水处理并标推断） */
  function trendOf(rating: Rating): RatingTrend {
    return rating.trend === 'fall' ? 'fall' : 'rise'
  }

  /** 同测站 + 同定线号的分组键 */
  function groupKeyOf(rating: Rating): string {
    return `${rating.stationId}|${rating.lineNo}`
  }

  /** 当前活跃分组（同测站同定线号）下的全部点据 */
  const activeGroupRatings = computed<Rating[]>(() =>
    ratings.value.filter(
      (rating) => rating.stationId === activeStationId.value && rating.lineNo === activeLineNo.value
    )
  )

  /** 全部「测站 + 定线号」分组 */
  const groups = computed(() => {
    const map = new Map<
      string,
      { stationId: string; lineNo: string; count: number; riseCount: number; fallCount: number }
    >()
    ratings.value.forEach((rating) => {
      const key = groupKeyOf(rating)
      const bucket = map.get(key) ?? { stationId: rating.stationId, lineNo: rating.lineNo, count: 0, riseCount: 0, fallCount: 0 }
      bucket.count += 1
      if (trendOf(rating) === 'rise') bucket.riseCount += 1
      else bucket.fallCount += 1
      map.set(key, bucket)
    })
    return Array.from(map.values()).sort((a, b) =>
      `${a.stationId}${a.lineNo}`.localeCompare(`${b.stationId}${b.lineNo}`)
    )
  })

  const lineNos = computed<string[]>(() => {
    const set = new Set<string>()
    ratings.value.forEach((rating) => set.add(rating.lineNo))
    return Array.from(set).sort((a, b) => a.localeCompare(b))
  })

  const stationNameOf = (stationId: string): string =>
    stations.value.find((station) => station.id === stationId)?.name ?? '未知测站'

  /** 全部分组的支线拟合结果（涨、落各一条） */
  const allFits = computed<RatingFitResult[]>(() =>
    groups.value.flatMap((group) => {
      const result = fitRatingGroup(
        group.stationId,
        group.lineNo,
        ratings.value
          .filter((rating) => rating.stationId === group.stationId && rating.lineNo === group.lineNo)
          .map((rating) => ({ stageM: rating.stageM, flowM3s: rating.flowM3s, trend: trendOf(rating) }))
      )
      return [result.rise, result.fall]
    })
  )

  /** 按支线键取拟合：优先用「重新定线」缓存，否则取实时计算 */
  const fitByBranchKey = computed(() => {
    const map = new Map<string, RatingFitResult>()
    allFits.value.forEach((fit) => map.set(fit.branchKey, fit))
    fits.value.forEach((fit) => map.set(fit.branchKey, fit))
    return map
  })

  function fitOf(stationId: string, lineNo: string, trend: RatingTrend): RatingFitResult {
    const key = buildBranchKey(stationId, lineNo, trend)
    return (
      fitByBranchKey.value.get(key) ?? {
        ...fitRatingGroup(stationId, lineNo, [])[trend],
        branchKey: key
      }
    )
  }

  /** 当前活跃分组的涨、落支线拟合 */
  const activeGroupFit = computed(() => ({
    rise: fitOf(activeStationId.value, activeLineNo.value, 'rise'),
    fall: fitOf(activeStationId.value, activeLineNo.value, 'fall')
  }))

  /** 兼容旧引用：当前涨水支线的拟合结果 */
  const activeFit = computed<RatingFitResult>(() => activeGroupFit.value.rise)

  /** 当前分组点据 + 所属支线曲线流量 + 残差（按水位排序） */
  const pointRows = computed(() =>
    activeGroupRatings.value
      .slice()
      .sort((a, b) => a.stageM - b.stageM)
      .map((rating) => {
        const trend = trendOf(rating)
        const fit = fitOf(rating.stationId, rating.lineNo, trend)
        const predicted = fit.valid ? curveFlow(fit, rating.stageM) : 0
        const residualPct =
          fit.valid && rating.flowM3s > 0
            ? Number((((rating.flowM3s - predicted) / rating.flowM3s) * 100).toFixed(2))
            : 0
        return { rating, trend, fit, predicted, residualPct }
      })
  )

  /** 按筛选条件过滤后的点据 */
  const filteredRatings = computed<Rating[]>(() =>
    ratings.value.filter((rating) => {
      const keyword = filter.value.keyword.trim()
      if (keyword.length > 0) {
        const haystack = `${rating.measureNo}${rating.lineNo}${stationNameOf(rating.stationId)}`
        if (!haystack.includes(keyword)) return false
      }
      if (filter.value.stationIds.length > 0 && !filter.value.stationIds.includes(rating.stationId)) return false
      if (filter.value.lineNos.length > 0 && !filter.value.lineNos.includes(rating.lineNo)) return false
      if (filter.value.trends.length > 0 && !filter.value.trends.includes(trendOf(rating))) return false
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
      filter.value.trends.length > 0 ||
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
          lineNo: rating?.lineNo ?? '-',
          trend: rating ? trendOf(rating) : null
        }
      })
      .sort((a, b) => {
        if (a.compare.verdict === '未定线' && b.compare.verdict !== '未定线') return 1
        if (b.compare.verdict === '未定线' && a.compare.verdict !== '未定线') return -1
        return Math.abs(b.compare.deviationPct) - Math.abs(a.compare.deviationPct)
      })
  )

  const overLimitRows = computed<CompareRow[]>(() =>
    compareRows.value.filter((row) => row.compare.verdict === '超限')
  )

  /** 定线质量派生值：支线平均残差与合格点占比（未定线不计超限） */
  const fitQuality = computed(() => {
    const validFits = allFits.value.filter((fit) => fit.valid)
    const meanResidual = validFits.length
      ? Number((validFits.reduce((sum, fit) => sum + fit.meanResidualPct, 0) / validFits.length).toFixed(2))
      : 0
    const judged = compareRows.value.filter((row) => row.compare.verdict !== '未定线')
    const total = judged.length
    const over = overLimitRows.value.length
    return {
      validLineCount: validFits.length,
      meanResidualPct: meanResidual,
      compareCount: compareRows.value.length,
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

  function setActiveStation(stationId: string): void {
    activeStationId.value = stationId
  }

  function setActiveGroup(stationId: string, lineNo: string): void {
    activeStationId.value = stationId
    activeLineNo.value = lineNo
  }

  /** 缓存某分组的两条支线定线参数（「重新定线」后回写） */
  function setGroupFits(pair: { rise: RatingFitResult; fall: RatingFitResult }): void {
    const others = fits.value.filter(
      (item) => item.branchKey !== pair.rise.branchKey && item.branchKey !== pair.fall.branchKey
    )
    fits.value = [...others, pair.rise, pair.fall]
  }

  function setFit(fit: RatingFitResult): void {
    const others = fits.value.filter((item) => item.branchKey !== fit.branchKey)
    fits.value = [...others, fit]
  }

  function setDeviationLimit(limit: number): void {
    deviationLimitPct.value = limit
  }

  async function createRating(
    payload: Omit<Rating, 'id' | 'createdAt' | 'updatedAt'>
  ): Promise<Rating> {
    const now = Date.now()
    const row: Rating = { trendInferred: false, ...payload, id: createId('rat'), createdAt: now, updatedAt: now }
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

  /** 计算某分组的支线定线（可指定点据集合，供表单提交即时重算用） */
  function computeGroupFit(
    stationId: string,
    lineNo: string,
    source: Rating[] = ratings.value
  ): { rise: RatingFitResult; fall: RatingFitResult } {
    return fitRatingGroup(
      stationId,
      lineNo,
      source
        .filter((rating) => rating.stationId === stationId && rating.lineNo === lineNo)
        .map((rating) => ({ stageM: rating.stageM, flowM3s: rating.flowM3s, trend: trendOf(rating) }))
    )
  }

  /**
   * 由点据生成 / 刷新比测记录：曲线流量取点据所属支线的定线拟合值，
   * 偏差超过限值自动判定超限；支线不足 3 点时曲线流量记 0、判定未定线。
   * 不传参时重算全部分组。
   */
  async function rebuildCompares(lineNo?: string, stationId?: string): Promise<number> {
    const scoped = groups.value.filter(
      (group) =>
        (!lineNo || group.lineNo === lineNo) && (!stationId || group.stationId === stationId)
    )
    const targetRatings = ratings.value.filter((rating) =>
      scoped.some((group) => group.stationId === rating.stationId && group.lineNo === rating.lineNo)
    )
    if (targetRatings.length === 0) return 0

    const fitCache = new Map<string, { rise: RatingFitResult; fall: RatingFitResult }>()
    scoped.forEach((group) => {
      const pair = computeGroupFit(group.stationId, group.lineNo)
      fitCache.set(`${group.stationId}|${group.lineNo}`, pair)
      setGroupFits(pair)
    })

    const now = Date.now()
    const rows: Compare[] = targetRatings.map((rating) => {
      const trend = trendOf(rating)
      const fit = fitCache.get(`${rating.stationId}|${rating.lineNo}`)?.[trend]
      const valid = fit?.valid ?? false
      const predicted = valid && fit ? curveFlow(fit, rating.stageM) : 0
      const deviationPct = valid ? calcDeviationPct(rating.flowM3s, predicted) : 0
      const existing = compares.value.find((item) => item.ratingId === rating.id)
      return {
        id: existing?.id ?? createId('cmp'),
        ratingId: rating.id,
        measuredFlow: rating.flowM3s,
        curveFlow: predicted,
        deviationPct,
        verdict: valid ? judgeDeviation(deviationPct, deviationLimitPct.value) : '未定线',
        trend,
        operator: existing?.operator ?? '林昭',
        comparedAt: existing?.comparedAt ?? rating.measuredAt,
        createdAt: existing?.createdAt ?? now,
        updatedAt: now
      }
    })
    await db.compares.bulkPut(rows)
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
      payload.verdict === '未定线'
        ? 0
        : payload.deviationPct ?? calcDeviationPct(payload.measuredFlow, payload.curveFlow)
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
    activeStationId,
    activeLineNo,
    activeFit,
    activeGroupFit,
    activeGroupRatings,
    groups,
    fits,
    deviationLimitPct,
    lineNos,
    allFits,
    pointRows,
    filteredRatings,
    hasFilter,
    compareRows,
    overLimitRows,
    fitQuality,
    start,
    trendOf,
    stationNameOf,
    fitOf,
    computeGroupFit,
    patchFilter,
    resetFilter,
    setActiveLine,
    setActiveStation,
    setActiveGroup,
    setGroupFits,
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
