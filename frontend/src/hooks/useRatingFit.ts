/**
 * useRatingFit：水位流量点据按涨落支线拟合、残差与定线状态管理。
 * 涨、落两条支线共用一条基线 H0、各自拟合 a、b；被关系点据页与导出页消费；
 * 点据数据来自 ratingStore（IndexedDB 实时订阅）。
 */
import { computed, ref, type ComputedRef, type Ref } from 'vue'
import { storeToRefs } from 'pinia'
import { useRatingStore } from '@/stores/ratingStore'
import type { Compare } from '@/types/compare'
import {
  curveFlow,
  fitLoopCurve,
  type LimbFitResult,
  type LoopFitResult,
  type Rating
} from '@/types/rating'

/** 曲线采样点（用于关系曲线绘制） */
export interface CurveSample {
  stageM: number
  flowM3s: number
}

/** 带残差的点据行（曲线流量与残差按所属支线计算） */
export interface RatingPointRow {
  rating: Rating
  stationName: string
  /** 曲线流量（所属支线拟合值） */
  curveFlowM3s: number
  /** 相对残差（%）：(实测 - 曲线) / 实测 × 100 */
  residualPct: number
  /** 点据所属支线的定线结果 */
  limbFit: LimbFitResult
}

export interface UseRatingFitResult {
  ratings: Ref<Rating[]>
  compares: Ref<Compare[]>
  /** 参与定线的定线号列表 */
  lineNos: ComputedRef<string[]>
  /** 当前选中定线号 */
  activeLineNo: Ref<string>
  /** 当前定线号的绳套拟合结果（涨、落支线共用基线） */
  loopFit: ComputedRef<LoopFitResult>
  /** 全部定线号的绳套拟合结果 */
  allLoopFits: ComputedRef<LoopFitResult[]>
  /** 当前定线的点据（含残差） */
  pointRows: ComputedRef<RatingPointRow[]>
  /** 当前定线两条支线的曲线采样点，用于绘制绳套 */
  curveSamples: ComputedRef<{ rising: CurveSample[]; falling: CurveSample[] }>
  /** 超限点据清单 */
  overLimitRows: ComputedRef<RatingPointRow[]>
  /** 超限点据对应的比测记录 */
  overLimitCompares: ComputedRef<Compare[]>
  setActiveLine: (lineNo: string) => void
  /** 按当前点据重算绳套定线参数并回写 store */
  refit: () => LoopFitResult
}

/** 取点据所属支线的定线结果 */
function limbFitOf(loop: LoopFitResult, rating: Rating): LimbFitResult {
  return rating.limb === 'rising' ? loop.rising : loop.falling
}

/**
 * 组合式函数：按定线号分组、涨落分线拟合幂函数 Q = a×(H-H0)^b，并给出逐点残差。
 */
export function useRatingFit(initialLineNo = 'A'): UseRatingFitResult {
  const ratingStore = useRatingStore()
  const { ratings, compares } = storeToRefs(ratingStore)
  const activeLineNo = ref<string>(initialLineNo)

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

  const allLoopFits = computed<LoopFitResult[]>(() =>
    lineNos.value.map((lineNo) => {
      const points = ratings.value
        .filter((rating) => rating.lineNo === lineNo)
        .map((rating) => ({ stageM: rating.stageM, flowM3s: rating.flowM3s, limb: rating.limb }))
      return fitLoopCurve(points, lineNo)
    })
  )

  const loopFit = computed<LoopFitResult>(() => {
    const found = allLoopFits.value.find((item) => item.lineNo === activeLineNo.value)
    if (found) return found
    return fitLoopCurve([], activeLineNo.value)
  })

  const pointRows = computed<RatingPointRow[]>(() => {
    const loop = loopFit.value
    return ratings.value
      .filter((rating) => rating.lineNo === activeLineNo.value)
      .sort((a, b) => a.stageM - b.stageM)
      .map((rating) => {
        const limbFit = limbFitOf(loop, rating)
        const predicted = limbFit.valid ? curveFlow(limbFit, rating.stageM) : 0
        const residualPct =
          limbFit.valid && rating.flowM3s > 0
            ? Number((((rating.flowM3s - predicted) / rating.flowM3s) * 100).toFixed(2))
            : 0
        return {
          rating,
          stationName: stationNameOf(rating.stationId),
          curveFlowM3s: predicted,
          residualPct,
          limbFit
        }
      })
  })

  const curveSamples = computed<{ rising: CurveSample[]; falling: CurveSample[] }>(() => {
    const loop = loopFit.value
    const sampleLimb = (limbFit: LimbFitResult): CurveSample[] => {
      if (!limbFit.valid) return []
      const stages = ratings.value
        .filter((rating) => rating.lineNo === activeLineNo.value && rating.limb === limbFit.limb)
        .map((rating) => rating.stageM)
      if (stages.length === 0) return []
      const min = Math.min(...stages)
      const max = Math.max(...stages)
      const step = (max - min) / 12 || 0.1
      return Array.from({ length: 13 }, (_, index) => {
        const stageM = Number((min + step * index).toFixed(2))
        return { stageM, flowM3s: curveFlow(limbFit, stageM) }
      })
    }
    return { rising: sampleLimb(loop.rising), falling: sampleLimb(loop.falling) }
  })

  const overLimitRows = computed<RatingPointRow[]>(() => {
    const limit = ratingStore.deviationLimitPct
    return allLoopFits.value.flatMap((loop) =>
      ratings.value
        .filter((rating) => rating.lineNo === loop.lineNo)
        .map((rating) => {
          const limbFit = limbFitOf(loop, rating)
          const predicted = limbFit.valid ? curveFlow(limbFit, rating.stageM) : 0
          const residualPct =
            limbFit.valid && rating.flowM3s > 0
              ? Number((((rating.flowM3s - predicted) / rating.flowM3s) * 100).toFixed(2))
              : 0
          return {
            rating,
            stationName: stationNameOf(rating.stationId),
            curveFlowM3s: predicted,
            residualPct,
            limbFit
          }
        })
        .filter((row) => row.limbFit.valid && Math.abs(row.residualPct) > limit)
    )
  })

  const overLimitCompares = computed<Compare[]>(() =>
    compares.value.filter((compare) => compare.verdict === '超限')
  )

  function setActiveLine(lineNo: string): void {
    activeLineNo.value = lineNo
  }

  function refit(): LoopFitResult {
    const points = ratings.value
      .filter((rating) => rating.lineNo === activeLineNo.value)
      .map((rating) => ({ stageM: rating.stageM, flowM3s: rating.flowM3s, limb: rating.limb }))
    const result = fitLoopCurve(points, activeLineNo.value)
    ratingStore.setFit(result)
    return result
  }

  return {
    ratings,
    compares,
    lineNos,
    activeLineNo,
    loopFit,
    allLoopFits,
    pointRows,
    curveSamples,
    overLimitRows,
    overLimitCompares,
    setActiveLine,
    refit
  }
}
