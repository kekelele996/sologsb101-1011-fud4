/** 涨落支线：同一水位下涨水与落水的流量不同，需分别定线形成绳套 */
export type RatingLimb = 'rising' | 'falling'

export const LIMB_LABELS: Record<RatingLimb, string> = {
  rising: '涨水',
  falling: '落水'
}

/** 水位流量关系点据：参与幂函数定线的实测点 */
export interface Rating {
  id: string
  /** 所属测站 */
  stationId: string
  /** 水位（m） */
  stageM: number
  /** 流量（m³/s） */
  flowM3s: number
  /** 定线号：同一定线号的点据参与同一组拟合 */
  lineNo: string
  /** 涨落支线：涨水 / 落水分线定线；老点据由迁移按时间顺序补方向 */
  limb: RatingLimb
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
  /** 系数 a */
  a: number
  /** 指数 b */
  b: number
  /** 基线水位 H0（由点据自动搜索获得） */
  h0: number
  /** 参与拟合的点数 */
  sampleCount: number
  /** 拟合残差（相对误差绝对值均值，%） */
  meanResidualPct: number
  /** 最大残差（%） */
  maxResidualPct: number
  /** 决定系数 R²（对数域） */
  r2: number
  /** 是否可定线（点数 ≥ 3 且 b 为正） */
  valid: boolean
  /** 不可定线时的说明 */
  message: string
}

/** 单条支线（涨水或落水）的定线结果 */
export interface LimbFitResult extends RatingFitResult {
  limb: RatingLimb
}

/**
 * 绳套定线结果：涨、落两条支线分别拟合 a、b。
 * 基线策略：两条支线共用一条基线 H0（同一断面河底控制一致，绳套在低水端闭合），
 * H0 在可定线支线的全部点据上搜索，使各支线残差之和最小。
 */
export interface LoopFitResult {
  lineNo: string
  /** 共用基线水位 H0（涨、落支线共用一条，页面需标注清楚） */
  h0: number
  rising: LimbFitResult
  falling: LimbFitResult
  /** 参与统计的点据总数（含未定线支线的点据） */
  sampleCount: number
  /** 可定线支线按点数加权的平均残差（%），均不可定线时为 0 */
  meanResidualPct: number
  /** 是否至少一条支线完成定线 */
  valid: boolean
  message: string
}

/** 关系点据页筛选条件（存于 ratingStore） */
export interface RatingFilterState {
  keyword: string
  stationIds: string[]
  lineNos: string[]
  verdicts: Array<'合格' | '超限'>
}

export function createEmptyRatingFilter(): RatingFilterState {
  return {
    keyword: '',
    stationIds: [],
    lineNos: [],
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

/** 对数域决定系数 R² */
function logDomainR2(
  samples: Array<{ stageM: number; flowM3s: number }>,
  a: number,
  b: number,
  h0: number
): number {
  const lnFlows = samples.map((point) => Math.log(point.flowM3s))
  const meanLnFlow = lnFlows.reduce((sum, value) => sum + value, 0) / lnFlows.length
  const totalSs = lnFlows.reduce((sum, value) => sum + (value - meanLnFlow) ** 2, 0)
  const residualSs = samples.reduce((sum, point) => {
    const predicted = a * Math.pow(Math.max(point.stageM - h0, 1e-6), b)
    const diff = Math.log(point.flowM3s) - Math.log(Math.max(predicted, 1e-6))
    return sum + diff * diff
  }, 0)
  return totalSs < 1e-9 ? 1 : Number(Math.max(0, 1 - residualSs / totalSs).toFixed(4))
}

/**
 * 幂函数定线：Q = a×(H - H0)^b。
 * 在 [Hmin - 0.9×(Hmax-Hmin) , Hmin - 0.02] 区间内以 0.01 m 步长搜索 H0，
 * 取平均相对残差最小的一组参数，避免「基线贴近最低水位」造成幂函数畸变。
 */
export function fitPowerCurve(
  points: Array<{ stageM: number; flowM3s: number }>,
  lineNo = 'A'
): RatingFitResult {
  const usable = points.filter(
    (point) => Number.isFinite(point.stageM) && Number.isFinite(point.flowM3s) && point.flowM3s > 0
  )
  const base: RatingFitResult = {
    lineNo,
    a: 0,
    b: 0,
    h0: 0,
    sampleCount: usable.length,
    meanResidualPct: 0,
    maxResidualPct: 0,
    r2: 0,
    valid: false,
    message: ''
  }
  if (usable.length < 3) {
    return { ...base, message: '点据少于 3 个，无法定线（至少需要 3 个实测点）' }
  }
  const stageMin = Math.min(...usable.map((point) => point.stageM))
  const stageMax = Math.max(...usable.map((point) => point.stageM))
  const spread = Math.max(stageMax - stageMin, 0.05)
  const lowerH0 = stageMin - spread * 0.9
  const upperH0 = stageMin - 0.02

  let best: { a: number; b: number; h0: number; residuals: number[]; mean: number } | null = null
  const steps = Math.max(1, Math.round((upperH0 - lowerH0) / 0.01))
  for (let index = 0; index <= steps; index += 1) {
    const h0 = Number((lowerH0 + (index * (upperH0 - lowerH0)) / steps).toFixed(4))
    const candidate = fitWithBase(usable, h0)
    if (!candidate) continue
    const mean = candidate.residuals.reduce((sum, value) => sum + value, 0) / candidate.residuals.length
    if (!best || mean < best.mean) {
      best = { ...candidate, h0, mean }
    }
  }
  if (!best) {
    return { ...base, message: '水位点据过于集中，无法求解幂函数指数' }
  }

  const valid = best.b > 0 && Number.isFinite(best.a)
  return {
    lineNo,
    a: Number(best.a.toFixed(4)),
    b: Number(best.b.toFixed(3)),
    h0: Number(best.h0.toFixed(3)),
    sampleCount: usable.length,
    meanResidualPct: Number(best.mean.toFixed(2)),
    maxResidualPct: Number(Math.max(...best.residuals).toFixed(2)),
    r2: logDomainR2(usable, best.a, best.b, best.h0),
    valid,
    message: valid ? '定线有效' : '指数 b ≤ 0，点据趋势异常，请检查水位与流量的对应关系'
  }
}

/** 由定线参数计算曲线流量 */
export function curveFlow(fit: RatingFitResult, stageM: number): number {
  if (!fit.valid) return 0
  const value = fit.a * Math.pow(Math.max(stageM - fit.h0, 1e-6), fit.b)
  return Number(value.toFixed(2))
}

/**
 * 为无涨落归属的老点据按时间顺序补方向：
 * 同一定线号内按点据时间排序，水位不低于上一点记涨水、否则记落水；
 * 序列首点参考下一点的水位变化，孤立点默认涨水。已有归属的点据保持原值。
 */
export function fillMissingLimbs(ratings: Rating[]): Rating[] {
  // 老库 / 旧备份中的记录在运行时可能没有 limb 字段
  if (ratings.every((rating) => rating.limb === 'rising' || rating.limb === 'falling')) return ratings
  const groups = new Map<string, Rating[]>()
  ratings.forEach((rating) => {
    const list = groups.get(rating.lineNo) ?? []
    list.push(rating)
    groups.set(rating.lineNo, list)
  })
  const derived = new Map<string, RatingLimb>()
  groups.forEach((list) => {
    const sorted = [...list].sort(
      (a, b) => String(a.measuredAt ?? '').localeCompare(String(b.measuredAt ?? '')) || a.createdAt - b.createdAt
    )
    sorted.forEach((rating, index) => {
      if (rating.limb === 'rising' || rating.limb === 'falling') return
      let limb: RatingLimb
      if (index > 0) {
        limb = rating.stageM >= sorted[index - 1].stageM ? 'rising' : 'falling'
      } else if (sorted.length > 1) {
        limb = sorted[1].stageM >= rating.stageM ? 'rising' : 'falling'
      } else {
        limb = 'rising'
      }
      derived.set(rating.id, limb)
    })
  })
  return ratings.map((rating) => {
    const limb = derived.get(rating.id)
    return limb ? { ...rating, limb } : rating
  })
}

/** 构造一条支线的未定线结果（点据不足时不借用另一支线参数） */
function emptyLimbFit(limb: RatingLimb, lineNo: string, sampleCount: number, message: string): LimbFitResult {
  return {
    limb,
    lineNo,
    a: 0,
    b: 0,
    h0: 0,
    sampleCount,
    meanResidualPct: 0,
    maxResidualPct: 0,
    r2: 0,
    valid: false,
    message
  }
}

/**
 * 绳套定线：涨、落两条支线分别拟合 Q = a×(H - H0)^b 的 a、b，
 * 两条支线共用一条基线 H0（在可定线支线的全部点据上联合搜索，使残差总和最小）。
 * 某条支线点据不足 3 个时该支线标未定线，不借用另一条支线的参数。
 */
export function fitLoopCurve(
  points: Array<{ stageM: number; flowM3s: number; limb: RatingLimb }>,
  lineNo = 'A'
): LoopFitResult {
  const usable = points.filter(
    (point) => Number.isFinite(point.stageM) && Number.isFinite(point.flowM3s) && point.flowM3s > 0
  )
  const byLimb: Record<RatingLimb, Array<{ stageM: number; flowM3s: number }>> = {
    rising: usable.filter((point) => point.limb === 'rising'),
    falling: usable.filter((point) => point.limb === 'falling')
  }
  const shortageMessage = (limb: RatingLimb): string =>
    `${LIMB_LABELS[limb]}支线点据不足 3 个，支线未定线（不借用${LIMB_LABELS[limb === 'rising' ? 'falling' : 'rising']}支线参数）`
  const fittable = (['rising', 'falling'] as const).filter((limb) => byLimb[limb].length >= 3)

  if (fittable.length === 0) {
    return {
      lineNo,
      h0: 0,
      rising: emptyLimbFit('rising', lineNo, byLimb.rising.length, shortageMessage('rising')),
      falling: emptyLimbFit('falling', lineNo, byLimb.falling.length, shortageMessage('falling')),
      sampleCount: usable.length,
      meanResidualPct: 0,
      valid: false,
      message: '涨、落两条支线点据均不足 3 个，无法定线'
    }
  }

  // 共用基线搜索：区间与步长同单线定线，目标函数为各可定线支线残差总和
  const pool = fittable.flatMap((limb) => byLimb[limb])
  const stageMin = Math.min(...pool.map((point) => point.stageM))
  const stageMax = Math.max(...pool.map((point) => point.stageM))
  const spread = Math.max(stageMax - stageMin, 0.05)
  const lowerH0 = stageMin - spread * 0.9
  const upperH0 = stageMin - 0.02

  let bestH0: number | null = null
  let bestMean = Number.POSITIVE_INFINITY
  const steps = Math.max(1, Math.round((upperH0 - lowerH0) / 0.01))
  for (let index = 0; index <= steps; index += 1) {
    const h0 = Number((lowerH0 + (index * (upperH0 - lowerH0)) / steps).toFixed(4))
    let residualSum = 0
    let residualCount = 0
    let solvable = true
    for (const limb of fittable) {
      const candidate = fitWithBase(byLimb[limb], h0)
      if (!candidate) {
        solvable = false
        break
      }
      residualSum += candidate.residuals.reduce((sum, value) => sum + value, 0)
      residualCount += candidate.residuals.length
    }
    if (!solvable || residualCount === 0) continue
    const mean = residualSum / residualCount
    if (mean < bestMean) {
      bestMean = mean
      bestH0 = h0
    }
  }

  const limbs = {} as Record<RatingLimb, LimbFitResult>
  for (const limb of ['rising', 'falling'] as const) {
    const samples = byLimb[limb]
    if (samples.length < 3) {
      limbs[limb] = emptyLimbFit(limb, lineNo, samples.length, shortageMessage(limb))
      continue
    }
    const candidate = bestH0 === null ? null : fitWithBase(samples, bestH0)
    if (!candidate) {
      limbs[limb] = emptyLimbFit(limb, lineNo, samples.length, '水位点据过于集中，无法求解幂函数指数')
      continue
    }
    const h0 = Number((bestH0 as number).toFixed(3))
    const mean = candidate.residuals.reduce((sum, value) => sum + value, 0) / candidate.residuals.length
    const valid = candidate.b > 0 && Number.isFinite(candidate.a)
    limbs[limb] = {
      limb,
      lineNo,
      a: Number(candidate.a.toFixed(4)),
      b: Number(candidate.b.toFixed(3)),
      h0,
      sampleCount: samples.length,
      meanResidualPct: Number(mean.toFixed(2)),
      maxResidualPct: Number(Math.max(...candidate.residuals).toFixed(2)),
      r2: logDomainR2(samples, candidate.a, candidate.b, bestH0 as number),
      valid,
      message: valid ? '定线有效' : '指数 b ≤ 0，点据趋势异常，请检查水位与流量的对应关系'
    }
  }

  const validLimbs = [limbs.rising, limbs.falling].filter((fit) => fit.valid)
  const validPoints = validLimbs.reduce((sum, fit) => sum + fit.sampleCount, 0)
  const meanResidualPct =
    validPoints === 0
      ? 0
      : Number(
          (
            validLimbs.reduce((sum, fit) => sum + fit.meanResidualPct * fit.sampleCount, 0) / validPoints
          ).toFixed(2)
        )
  const invalidLimb = [limbs.rising, limbs.falling].find((fit) => !fit.valid)
  return {
    lineNo,
    h0: validLimbs.length > 0 ? validLimbs[0].h0 : 0,
    rising: limbs.rising,
    falling: limbs.falling,
    sampleCount: usable.length,
    meanResidualPct,
    valid: validLimbs.length > 0,
    message:
      validLimbs.length === 2
        ? '涨、落双线定线有效（共用基线）'
        : validLimbs.length === 1
          ? `${LIMB_LABELS[(invalidLimb as LimbFitResult).limb]}支线未定线：${(invalidLimb as LimbFitResult).message}`
          : '两条支线均无法定线'
  }
}
