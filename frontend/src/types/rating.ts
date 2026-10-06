/** 水位流量关系点据：参与幂函数定线的实测点 */

/** 水势支线：涨水支线 / 落水支线（绳套的两支） */
export type RatingTrend = 'rise' | 'fall'

export const TREND_LABELS: Record<RatingTrend, string> = {
  rise: '涨水',
  fall: '落水'
}

export interface Rating {
  id: string
  /** 所属测站 */
  stationId: string
  /** 水位（m） */
  stageM: number
  /** 流量（m³/s） */
  flowM3s: number
  /** 定线号：同一测站同一定线号的点据参与同一组拟合 */
  lineNo: string
  /** 水势：涨水 / 落水支线，两条支线分别定线形成绳套 */
  trend: RatingTrend
  /** 支线方向是否为按时间推断（老点据迁移 / 备份导入时自动补方向） */
  trendInferred?: boolean
  /** 点据来源测次号 */
  measureNo: string
  /** 点据时间 */
  measuredAt: string
  createdAt: number
  updatedAt: number
}

/** 幂函数定线结果：Q = a * (H - H0)^b */
export interface RatingFitResult {
  lineNo: string
  /** 支线方向（涨水 / 落水） */
  trend: RatingTrend
  /** 分组键：同测站同定线号的涨、落支线共用一条基线 */
  stationId: string
  /** 支线键：stationId|lineNo|trend，供缓存与派值索引 */
  branchKey: string
  /** 系数 a */
  a: number
  /** 指数 b */
  b: number
  /** 基线水位 H0（两条支线共用；支线不足 3 点时为 0） */
  h0: number
  /** 基线是否由涨、落两条支线共用（页面需标清楚） */
  baseShared: boolean
  /** 参与拟合的点数 */
  sampleCount: number
  /** 拟合残差（相对误差绝对值均值，%） */
  meanResidualPct: number
  /** 最大残差（%） */
  maxResidualPct: number
  /** 决定系数 R²（对数域） */
  r2: number
  /** 是否可定线（支线点数 ≥ 3 且 b 为正） */
  valid: boolean
  /** 不可定线时的说明 */
  message: string
}

/** 关系点据页筛选条件（存于 ratingStore） */
export interface RatingFilterState {
  keyword: string
  stationIds: string[]
  lineNos: string[]
  trends: RatingTrend[]
  verdicts: Array<'合格' | '超限' | '未定线'>
}

export function createEmptyRatingFilter(): RatingFilterState {
  return {
    keyword: '',
    stationIds: [],
    lineNos: [],
    trends: [],
    verdicts: []
  }
}

/** 对 ln(Q) 与 ln(H - H0) 做最小二乘直线拟合，给定 H0 返回参数与残差 */
function fitWithBase(
  samples: Array<{ stageM: number; flowM3s: number }>,
  h0: number
): { a: number; b: number; residuals: number[] } | null {
  const points = samples.map((point) => ({
    x: Math.log(Math.max(point.stageM - h0, 1e-6)),
    y: Math.log(point.flowM3s)
  }))
  const n = points.length
  const sumX = points.reduce((sum, item) => sum + item.x, 0)
  const sumY = points.reduce((sum, item) => sum + item.y, 0)
  const sumXY = points.reduce((sum, item) => sum + item.x * item.y, 0)
  const sumXX = points.reduce((sum, item) => sum + item.x * item.x, 0)
  const denominator = n * sumXX - sumX * sumX
  if (Math.abs(denominator) < 1e-9) return null
  const b = (n * sumXY - sumX * sumY) / denominator
  const lnA = (sumY - b * sumX) / n
  const a = Math.exp(lnA)
  if (!Number.isFinite(a) || !Number.isFinite(b) || a <= 0) return null
  const residuals = samples.map((point) => {
    const predicted = a * Math.pow(Math.max(point.stageM - h0, 1e-6), b)
    return Math.abs((predicted - point.flowM3s) / point.flowM3s) * 100
  })
  return { a, b, residuals }
}

/** 基线搜索区间：由参与点据的水位范围确定 */
function baseSearchRange(samples: Array<{ stageM: number }>): { lower: number; upper: number } {
  const stageMin = Math.min(...samples.map((point) => point.stageM))
  const stageMax = Math.max(...samples.map((point) => point.stageM))
  const spread = Math.max(stageMax - stageMin, 0.05)
  return { lower: stageMin - spread * 0.9, upper: stageMin - 0.02 }
}

/** 在给定区间以 0.01 m 步长搜索平均相对残差最小的基线 H0 与拟合参数 */
function searchBestFit(
  samples: Array<{ stageM: number; flowM3s: number }>,
  range: { lower: number; upper: number }
): { a: number; b: number; h0: number; residuals: number[]; mean: number } | null {
  let best: { a: number; b: number; h0: number; residuals: number[]; mean: number } | null = null
  const steps = Math.max(1, Math.round((range.upper - range.lower) / 0.01))
  for (let index = 0; index <= steps; index += 1) {
    const h0 = Number((range.lower + (index * (range.upper - range.lower)) / steps).toFixed(4))
    const candidate = fitWithBase(samples, h0)
    if (!candidate) continue
    const mean = candidate.residuals.reduce((sum, value) => sum + value, 0) / candidate.residuals.length
    if (!best || mean < best.mean) {
      best = { ...candidate, h0, mean }
    }
  }
  return best
}

/** 组装不可定线结果（支线点数不足等） */
function invalidFit(
  stationId: string,
  lineNo: string,
  trend: RatingTrend,
  sampleCount: number,
  message: string,
  h0 = 0,
  baseShared = false
): RatingFitResult {
  return {
    lineNo,
    trend,
    stationId,
    branchKey: buildBranchKey(stationId, lineNo, trend),
    a: 0,
    b: 0,
    h0,
    baseShared,
    sampleCount,
    meanResidualPct: 0,
    maxResidualPct: 0,
    r2: 0,
    valid: false,
    message
  }
}

/** 由最佳参数与残差组装可定线结果，并补算对数域 R² */
function buildFitResult(
  stationId: string,
  lineNo: string,
  trend: RatingTrend,
  samples: Array<{ stageM: number; flowM3s: number }>,
  best: { a: number; b: number; h0: number; residuals: number[]; mean: number },
  baseShared: boolean
): RatingFitResult {
  const lnFlows = samples.map((point) => Math.log(point.flowM3s))
  const meanLnFlow = lnFlows.reduce((sum, value) => sum + value, 0) / lnFlows.length
  const totalSs = lnFlows.reduce((sum, value) => sum + (value - meanLnFlow) ** 2, 0)
  const residualSs = samples.reduce((sum, point) => {
    const predicted = best.a * Math.pow(Math.max(point.stageM - best.h0, 1e-6), best.b)
    const diff = Math.log(point.flowM3s) - Math.log(Math.max(predicted, 1e-6))
    return sum + diff * diff
  }, 0)
  const r2 = totalSs < 1e-9 ? 1 : Number(Math.max(0, 1 - residualSs / totalSs).toFixed(4))

  const valid = best.b > 0 && Number.isFinite(best.a)
  if (!valid) {
    return invalidFit(stationId, lineNo, trend, samples.length, '指数 b ≤ 0，点据趋势异常，请检查水位与流量的对应关系')
  }
  return {
    lineNo,
    trend,
    stationId,
    branchKey: buildBranchKey(stationId, lineNo, trend),
    a: Number(best.a.toFixed(4)),
    b: Number(best.b.toFixed(3)),
    h0: Number(best.h0.toFixed(3)),
    baseShared,
    sampleCount: samples.length,
    meanResidualPct: Number(best.mean.toFixed(2)),
    maxResidualPct: Number(Math.max(...best.residuals).toFixed(2)),
    r2,
    valid: true,
    message: '定线有效'
  }
}

export function buildBranchKey(stationId: string, lineNo: string, trend: RatingTrend): string {
  return `${stationId}|${lineNo}|${trend}`
}

/** 单支线拟合（基线 H0 由本支线点据自动搜索） */
export function fitPowerCurve(
  points: Array<{ stageM: number; flowM3s: number }>,
  lineNo = 'A',
  trend: RatingTrend = 'rise',
  stationId = ''
): RatingFitResult {
  const usable = points.filter(
    (point) => Number.isFinite(point.stageM) && Number.isFinite(point.flowM3s) && point.flowM3s > 0
  )
  if (usable.length < 3) {
    return invalidFit(
      stationId,
      lineNo,
      trend,
      usable.length,
      `${TREND_LABELS[trend]}支线点据少于 3 个，未定线（至少需要 3 个实测点，且不借用另一支线参数）`
    )
  }
  const best = searchBestFit(usable, baseSearchRange(usable))
  if (!best) {
    return invalidFit(stationId, lineNo, trend, usable.length, '水位点据过于集中，无法求解幂函数指数')
  }
  return buildFitResult(stationId, lineNo, trend, usable, best, false)
}

/**
 * 绳套分组定线：同一测站、同一定线号下的涨水、落水两条支线分别拟
 * Q = a×(H-H0)^b。
 *
 * 基线策略（页面同步标注）：两条支线各自独立搜索基线 H0、独立求 a、b
 * （baseShared=false）。绳套两支的水势动力不同，强制共用 H0 会把含异常点
 * 支线的指数压变形、放大残差；独立基线使两支各自取平均残差最小的参数。
 * 支线点数不足 3 个时标未定线，绝不拿另一条支线的 a、b、H0 顶上。
 */
export function fitRatingGroup(
  stationId: string,
  lineNo: string,
  allPoints: Array<{ stageM: number; flowM3s: number; trend?: RatingTrend }>
): { rise: RatingFitResult; fall: RatingFitResult } {
  const usable = allPoints.filter(
    (point) => Number.isFinite(point.stageM) && Number.isFinite(point.flowM3s) && point.flowM3s > 0
  )
  const risePoints = usable.filter((point) => (point.trend ?? 'rise') === 'rise')
  const fallPoints = usable.filter((point) => point.trend === 'fall')

  const fitBranch = (
    trend: RatingTrend,
    samples: Array<{ stageM: number; flowM3s: number }>
  ): RatingFitResult => {
    if (samples.length < 3) {
      return invalidFit(
        stationId,
        lineNo,
        trend,
        samples.length,
        `${TREND_LABELS[trend]}支线点据少于 3 个，未定线（至少需要 3 个实测点，且不借用另一支线参数）`
      )
    }
    const best = searchBestFit(samples, baseSearchRange(samples))
    if (!best) {
      return invalidFit(stationId, lineNo, trend, samples.length, '水位点据过于集中，无法求解幂函数指数')
    }
    return buildFitResult(stationId, lineNo, trend, samples, best, false)
  }

  return {
    rise: fitBranch('rise', risePoints),
    fall: fitBranch('fall', fallPoints)
  }
}

/** 由定线参数计算曲线流量 */
export function curveFlow(fit: RatingFitResult, stageM: number): number {
  if (!fit.valid) return 0
  const value = fit.a * Math.pow(Math.max(stageM - fit.h0, 1e-6), fit.b)
  return Number(value.toFixed(2))
}

/**
 * 无归属老点据按时间补水势方向：同一测站、同一定线号内，以洪峰
 * （最高水位点据；并列时取时间最早者）为界，洪峰之前（含洪峰）判为
 * 涨水，洪峰之后判为落水。
 */
export function inferTrends(
  rows: Array<Pick<Rating, 'id' | 'stationId' | 'lineNo' | 'stageM' | 'measuredAt'>>
): Map<string, RatingTrend> {
  const groups = new Map<string, typeof rows>()
  rows.forEach((row) => {
    const key = `${row.stationId}|${row.lineNo}`
    const list = groups.get(key) ?? []
    list.push(row)
    groups.set(key, list)
  })
  const result = new Map<string, RatingTrend>()
  groups.forEach((list) => {
    const byTime = [...list].sort((a, b) => Date.parse(a.measuredAt) - Date.parse(b.measuredAt))
    const peakTime = byTime.reduce(
      (peak, row) => (row.stageM > peak.stageM ? { stageM: row.stageM, time: Date.parse(row.measuredAt) } : peak),
      { stageM: -Infinity, time: Infinity }
    ).time
    byTime.forEach((row) => {
      result.set(row.id, Date.parse(row.measuredAt) <= peakTime ? 'rise' : 'fall')
    })
  })
  return result
}
