/**
 * useRatingFit：水位流量点据的涨 / 落支线拟合、残差与定线状态管理。
 * 被关系点据页与导出页消费；点据数据来自 ratingStore（IndexedDB 实时订阅）。
 * 同一测站、同一定线号下涨水、落水两条支线分别拟 Q = a×(H-H0)^b（共用基线）。
 */
import { computed, ref, type ComputedRef, type Ref } from 'vue'
import { storeToRefs } from 'pinia'
import { useRatingStore } from '@/stores/ratingStore'
import type { Compare } from '@/types/compare'
import {
  TREND_LABELS,
  curveFlow,
  type Rating,
  type RatingFitResult,
  type RatingTrend
} from '@/types/rating'

/** 曲线采样点（用于绳套曲线绘制） */
export interface CurveSample {
  stageM: number
  flowM3s: number
}

/** 带残差的点据行 */
export interface RatingPointRow {
  rating: Rating
  stationName: string
  /** 所属水势支线 */
  trend: RatingTrend
  /** 曲线流量（取所属支线成果） */
  curveFlowM3s: number
  /** 相对残差（%）：(实测 - 曲线) / 实测 × 100 */
  residualPct: number
  fit: RatingFitResult
}

export interface UseRatingFitResult {
  ratings: Ref<Rating[]>
  compares: Ref<Compare[]>
  /** 参与定线的定线号列表 */
  lineNos: ComputedRef<string[]>
  /** 当前选中定线号 */
  activeLineNo: Ref<string>
  /** 当前测站 */
  activeStationId: Ref<string>
  /** 当前分组的涨水支线拟合结果 */
  riseFit: ComputedRef<RatingFitResult>
  /** 当前分组的落水支线拟合结果 */
  fallFit: ComputedRef<RatingFitResult>
  /** 当前分组的点据（含支线残差） */
  pointRows: ComputedRef<RatingPointRow[]>
  /** 某支线的曲线采样点，用于绘制绳套曲线 */
  curveSamples: ComputedRef<Record<RatingTrend, CurveSample[]>>
  /** 超限点据清单（按所属支线判定） */
  overLimitRows: ComputedRef<RatingPointRow[]>
  /** 超限点据对应的比测记录 */
  overLimitCompares: ComputedRef<Compare[]>
  setActiveLine: (lineNo: string) => void
  setActiveStation: (stationId: string) => void
}

/**
 * 组合式函数：按测站 + 定线号分组，涨水、落水支线分别拟合幂函数并给出逐点残差。
 */
export function useRatingFit(initialLineNo = 'A', initialStationId = ''): UseRatingFitResult {
  const ratingStore = useRatingStore()
  const { ratings, compares } = storeToRefs(ratingStore)
  const activeLineNo = ref<string>(initialLineNo)
  const activeStationId = ref<string>(initialStationId)

  const lineNos = computed<string[]>(() => {
    const set = new Set<string>()
    ratings.value.forEach((rating) => set.add(rating.lineNo))
    if (set.size === 0) set.add(initialLineNo)
    return Array.from(set).sort((a, b) => a.localeCompare(b))
  })

  const stationNameOf = (stationId: string): string => {
    const station = ratingStore.stations.find((item) => item.id === stationId)
    return station ? station.name : '未知测站'
  }

  const currentRatings = computed<Rating[]>(() =>
    ratings.value.filter(
      (rating) => rating.stationId === activeStationId.value && rating.lineNo === activeLineNo.value
    )
  )

  const riseFit = computed<RatingFitResult>(() =>
    ratingStore.fitOf(activeStationId.value, activeLineNo.value, 'rise')
  )
  const fallFit = computed<RatingFitResult>(() =>
    ratingStore.fitOf(activeStationId.value, activeLineNo.value, 'fall')
  )

  const pointRows = computed<RatingPointRow[]>(() =>
    currentRatings.value
      .slice()
      .sort((a, b) => a.stageM - b.stageM)
      .map((rating) => {
        const trend: RatingTrend = rating.trend === 'fall' ? 'fall' : 'rise'
        const current = trend === 'rise' ? riseFit.value : fallFit.value
        const predicted = current.valid ? curveFlow(current, rating.stageM) : 0
        const residualPct =
          current.valid && rating.flowM3s > 0
            ? Number((((rating.flowM3s - predicted) / rating.flowM3s) * 100).toFixed(2))
            : 0
        return {
          rating,
          stationName: stationNameOf(rating.stationId),
          trend,
          curveFlowM3s: predicted,
          residualPct,
          fit: current
        }
      })
  )

  const branchSamples = (fit: RatingFitResult, trend: RatingTrend): CurveSample[] => {
    const rows = currentRatings.value.filter((rating) => (rating.trend ?? 'rise') === trend)
    if (!fit.valid || rows.length === 0) return []
    const stages = rows.map((rating) => rating.stageM)
    const min = Math.min(...stages)
    const max = Math.max(...stages)
    const step = (max - min) / 12 || 0.1
    return Array.from({ length: 13 }, (_, index) => {
      const stageM = Number((min + step * index).toFixed(2))
      return { stageM, flowM3s: curveFlow(fit, stageM) }
    })
  }

  const curveSamples = computed<Record<RatingTrend, CurveSample[]>>(() => ({
    rise: branchSamples(riseFit.value, 'rise'),
    fall: branchSamples(fallFit.value, 'fall')
  }))

  const overLimitRows = computed<RatingPointRow[]>(() => {
    const limit = ratingStore.deviationLimitPct
    return ratingStore.allFits.flatMap((fit) =>
      ratings.value
        .filter(
          (rating) =>
            rating.stationId === fit.stationId &&
            rating.lineNo === fit.lineNo &&
            (rating.trend ?? 'rise') === fit.trend
        )
        .map((rating) => {
          const predicted = fit.valid ? curveFlow(fit, rating.stageM) : 0
          const residualPct =
            fit.valid && rating.flowM3s > 0
              ? Number((((rating.flowM3s - predicted) / rating.flowM3s) * 100).toFixed(2))
              : 0
          return {
            rating,
            stationName: stationNameOf(rating.stationId),
            trend: fit.trend,
            curveFlowM3s: predicted,
            residualPct,
            fit
          }
        })
        .filter((row) => fit.valid && Math.abs(row.residualPct) > limit)
    )
  })

  const overLimitCompares = computed<Compare[]>(() =>
    compares.value.filter((compare) => compare.verdict === '超限')
  )

  function setActiveLine(lineNo: string): void {
    activeLineNo.value = lineNo
  }

  function setActiveStation(stationId: string): void {
    activeStationId.value = stationId
  }

  return {
    ratings,
    compares,
    lineNos,
    activeLineNo,
    activeStationId,
    riseFit,
    fallFit,
    pointRows,
    curveSamples,
    overLimitRows,
    overLimitCompares,
    setActiveLine,
    setActiveStation
  }
}

/** 支线方向展示文案（供其他模块复用） */
export { TREND_LABELS }
