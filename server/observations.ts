// 历史观测数据模块：按时间范围构建归档用数据集
// 说明：当前为确定性合成遥测数据（同一时间范围每次生成结果一致），
// 真实部署时可将 buildObservationDataset 内部替换为遥测库查询，
// 归档流程只依赖本文件导出的类型与返回结构。

export const STATION = {
  id: 'M-07',
  name: '雪线自动气象观测站',
  region: '北麓冰川保护区',
  elevationM: 4820,
};

export type SensorDef = {
  id: string;
  code: string;
  name: string;
  unit: string;
  baseline: number;
  dailyAmplitude: number;
  phaseHour: number; // 日变化峰值出现的小时（UTC）
  driftPerDay: number;
  noise: number;
  faultProbability: number; // 单日发生短时故障的概率
};

export const SENSORS: SensorDef[] = [
  { id: 'temp', code: 'TMP-01', name: '山脊温度', unit: '°C', baseline: -8.5, dailyAmplitude: 3.2, phaseHour: 14, driftPerDay: -0.02, noise: 0.7, faultProbability: 0.06 },
  { id: 'wind', code: 'WND-02', name: '风速 / 风向', unit: 'm/s', baseline: 15, dailyAmplitude: 4.5, phaseHour: 5, driftPerDay: 0.03, noise: 2.1, faultProbability: 0.12 },
  { id: 'snow', code: 'SNW-03', name: '积雪深度', unit: 'cm', baseline: 140, dailyAmplitude: 0.6, phaseHour: 16, driftPerDay: 0.18, noise: 0.4, faultProbability: 0.04 },
  { id: 'power', code: 'PWR-04', name: '电池组电量', unit: '%', baseline: 78, dailyAmplitude: 6, phaseHour: 13, driftPerDay: -0.05, noise: 1.0, faultProbability: 0.05 },
];

export type GapReason =
  | 'SCHEDULED_MAINTENANCE'
  | 'SATELLITE_LINK_OUTAGE'
  | 'SENSOR_FAULT'
  | 'LOW_POWER_SHUTDOWN';

export const GAP_REASON_LABEL: Record<GapReason, string> = {
  SCHEDULED_MAINTENANCE: '计划维护窗口',
  SATELLITE_LINK_OUTAGE: '卫星链路中断',
  SENSOR_FAULT: '传感器故障',
  LOW_POWER_SHUTDOWN: '低功耗保护停机',
};

export type QualityFlag = 'OK' | 'ESTIMATED' | 'MISSING';

export type ObservationReading = {
  sensorId: string;
  sensorCode: string;
  value: number | null;
  unit: string;
  qualityFlag: QualityFlag;
  qualityScore: number | null;
};

export type ObservationSlot = {
  timestamp: string;
  readings: ObservationReading[];
};

export type AlertRow = {
  time: string;
  severity: 'info' | 'warning' | 'critical';
  title: string;
  description: string;
};

export type DataGap = {
  sensorId: string | 'ALL_SENSORS';
  reason: GapReason;
  start: string;
  end: string;
  expectedSamples: number; // 每个受影响传感器应有的采样点数
  affectedSensors: number;
  missingSamples: number; // 实际缺失采样点总数（expectedSamples × 受影响传感器）
};

export type EnvironmentSummary = {
  temperature: { avg: number; min: number; max: number; unit: string };
  feelsLike: { avg: number; min: number; unit: string };
  wind: { avg: number; max: number; unit: string };
  snowDepth: { avg: number; max: number; unit: string };
  pressure: { avg: number; min: number; max: number; unit: string };
  visibility: { avgKm: number; maxKm: number };
  snowfall: { totalMm: number; peakMmPerHour: number };
  battery: { avg: number; min: number; unit: string };
};

export type SensorQuality = {
  sensorId: string;
  sensorCode: string;
  expectedSamples: number;
  receivedSamples: number;
  estimatedSamples: number;
  missingSamples: number;
  completenessPct: number;
  averageQualityScore: number | null;
};

export type DataQuality = {
  intervalSeconds: number;
  timezone: 'UTC';
  expectedSamples: number;
  receivedSamples: number;
  estimatedSamples: number;
  missingSamples: number;
  completenessPct: number;
  averageQualityScore: number | null;
  gapCount: number;
  gapReasons: Partial<Record<GapReason, number>>; // 各原因导致的缺失采样点总数
  sensors: SensorQuality[];
};

export type ObservationDataset = {
  station: typeof STATION;
  environmentSummary: EnvironmentSummary;
  alerts: AlertRow[];
  observations: ObservationSlot[];
  dataGaps: DataGap[];
  dataQuality: DataQuality;
};

// ---- 确定性伪随机（FNV-1a 哈希 + mulberry32）----
function hashSeed(input: string): number {
  let h = 2166136261;
  for (let i = 0; i < input.length; i++) {
    h ^= input.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const DAY_MS = 86_400_000;

function round1(n: number): number {
  return Math.round(n * 10) / 10;
}

function dayKey(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

// 每月第一个周四 02:00–05:00（UTC）为全站计划维护窗口
function maintenanceWindow(ms: number): { start: number; end: number } | null {
  const d = new Date(ms);
  const firstOfMonth = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1);
  const firstDow = new Date(firstOfMonth).getUTCDay();
  const firstThursday = 1 + (((4 - firstDow) % 7) + 7) % 7; // 周四 = 4
  if (d.getUTCDate() !== firstThursday) return null;
  const start = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), firstThursday, 2, 0, 0);
  return { start, end: start + 3 * 3_600_000 };
}

type OutageRule = { startSlot: number; lenSlots: number };

// 单传感器单日的随机故障计划（按日期确定性生成）
function dailyOutagePlan(dayMs: number, sensor: SensorDef): OutageRule | null {
  const rng = mulberry32(hashSeed(`${dayKey(dayMs)}|${sensor.id}|outage`));
  if (rng() >= sensor.faultProbability) return null;
  const startSlot = Math.floor(rng() * 24 * 6);
  const lenSlots = 1 + Math.floor(rng() * 5);
  return { startSlot, lenSlots };
}

// 影响全站的缺失原因（维护窗口 / 卫星链路中断）
function globalGapReason(ts: number, dayIndex: number, hour: number): GapReason | null {
  const win = maintenanceWindow(ts);
  if (win && ts >= win.start && ts < win.end) return 'SCHEDULED_MAINTENANCE';
  // 每 7 天中的固定一天凌晨 03:00–04:00 卫星链路中断
  if (dayIndex % 7 === 2 && hour === 3) return 'SATELLITE_LINK_OUTAGE';
  return null;
}

type RunState = { active: boolean; startMs: number; reason: GapReason; count: number };

function newRun(): RunState {
  return { active: false, startMs: 0, reason: 'SENSOR_FAULT', count: 0 };
}

/**
 * 按 [startIso, endIso] 构建归档数据集。
 * 采样间隔：跨度 ≤ 3 天为 10 分钟，否则为 1 小时（月度归档粒度）。
 */
export function buildObservationDataset(startIso: string, endIso: string): ObservationDataset {
  const startMs = Date.parse(startIso);
  const endMs = Date.parse(endIso);
  if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || startMs > endMs) {
    throw new Error('无效的时间范围');
  }

  const spanDays = (endMs - startMs) / DAY_MS;
  const intervalMs = spanDays <= 3 ? 10 * 60_000 : 3_600_000;
  const intervalMin = intervalMs / 60_000;
  const slotsPerDay = (24 * 60) / intervalMin;

  const observations: ObservationSlot[] = [];
  const alerts: AlertRow[] = [];
  const gaps: DataGap[] = [];

  // 全站缺失区间（ALL_SENSORS）与单传感器故障区间分别跟踪
  const globalRun = newRun();
  const sensorRuns = SENSORS.map(() => newRun());

  const expected = SENSORS.map(() => 0);
  const received = SENSORS.map(() => 0);
  const estimated = SENSORS.map(() => 0);
  const scoreSum = SENSORS.map(() => 0);
  const reasonCounts: Partial<Record<GapReason, number>> = {};

  // 环境摘要累加器
  const acc = {
    tempSum: 0, tempMin: Infinity, tempMax: -Infinity, tempN: 0,
    feelSum: 0, feelMin: Infinity, feelN: 0,
    windSum: 0, windMax: 0, windN: 0,
    snowSum: 0, snowMax: 0, snowN: 0,
    presSum: 0, presMin: Infinity, presMax: -Infinity, presN: 0,
    visSum: 0, visMax: 0, visN: 0,
    snowfallTotal: 0, snowfallPeak: 0,
    powerSum: 0, powerMin: Infinity, powerN: 0,
  };

  const firstDay = Date.UTC(new Date(startMs).getUTCFullYear(), new Date(startMs).getUTCMonth(), new Date(startMs).getUTCDate());
  const dayCount = Math.round((endMs - firstDay) / DAY_MS) + 1;

  for (let dayOffset = 0; dayOffset < dayCount; dayOffset++) {
    const dayMs = firstDay + dayOffset * DAY_MS;
    const dayIndex = dayOffset;
    const plans = SENSORS.map(s => dailyOutagePlan(dayMs, s));
    // 低功耗保护：每 11 天中的固定一天 00:00–01:00，仅影响电池传感器
    const lowPowerDay = dayOffset % 11 === 8;
    const dayRng = mulberry32(hashSeed(`${dayKey(dayMs)}|env`));

    for (let slotOfDay = 0; slotOfDay < slotsPerDay; slotOfDay++) {
      const ts = dayMs + slotOfDay * intervalMs;
      if (ts < startMs || ts > endMs) continue;
      const d = new Date(ts);
      const hourFloat = d.getUTCHours() + d.getUTCMinutes() / 60;
      const iso = d.toISOString();

      const gReason = globalGapReason(ts, dayIndex, d.getUTCHours());
      if (gReason) {
        if (!globalRun.active) {
          globalRun.active = true;
          globalRun.startMs = ts;
          globalRun.reason = gReason;
          globalRun.count = 0;
        }
        globalRun.count += 1;
        reasonCounts[gReason] = (reasonCounts[gReason] ?? 0) + SENSORS.length;
      } else if (globalRun.active) {
        flushGlobalGap(gaps, alerts, globalRun, intervalMs, startMs, endMs);
      }

      const readings: ObservationReading[] = [];
      const slotValues: (number | null)[] = [];

      for (let si = 0; si < SENSORS.length; si++) {
        const sensor = SENSORS[si];
        expected[si] += 1;

        // 全站性缺失：所有传感器该点缺失，不计入传感器自身故障区间
        if (gReason) {
          readings.push({ sensorId: sensor.id, sensorCode: sensor.code, value: null, unit: sensor.unit, qualityFlag: 'MISSING', qualityScore: null });
          slotValues.push(null);
          continue;
        }

        let sReason: GapReason | null = null;
        if (sensor.id === 'power' && lowPowerDay && d.getUTCHours() === 0) sReason = 'LOW_POWER_SHUTDOWN';
        const plan = plans[si];
        if (!sReason && plan && slotOfDay >= plan.startSlot && slotOfDay < plan.startSlot + plan.lenSlots) {
          sReason = 'SENSOR_FAULT';
        }

        const run = sensorRuns[si];
        if (sReason) {
          if (!run.active || run.reason !== sReason) {
            if (run.active) flushSensorGap(gaps, alerts, si, run, intervalMs);
            run.active = true;
            run.startMs = ts;
            run.reason = sReason;
            run.count = 0;
          }
          run.count += 1;
          reasonCounts[sReason] = (reasonCounts[sReason] ?? 0) + 1;
          readings.push({ sensorId: sensor.id, sensorCode: sensor.code, value: null, unit: sensor.unit, qualityFlag: 'MISSING', qualityScore: null });
          slotValues.push(null);
          continue;
        }
        if (run.active) flushSensorGap(gaps, alerts, si, run, intervalMs);

        const rng = mulberry32(hashSeed(`${iso}|${sensor.id}`));
        const elapsedDays = (ts - startMs) / DAY_MS;
        const phase = Math.cos(((hourFloat - sensor.phaseHour) / 24) * 2 * Math.PI);
        let v = sensor.baseline + sensor.driftPerDay * elapsedDays + sensor.dailyAmplitude * phase + (rng() - 0.5) * 2 * sensor.noise;
        if (sensor.id === 'power') v = Math.max(0, Math.min(100, v));
        if (sensor.id === 'wind' || sensor.id === 'snow') v = Math.max(0, v);
        const value = round1(v);
        slotValues.push(value);

        const qualityScore = Math.round((0.965 + rng() * 0.0345) * 10000) / 10000;
        const flag: QualityFlag = rng() < 0.035 ? 'ESTIMATED' : 'OK';
        received[si] += 1;
        if (flag === 'ESTIMATED') estimated[si] += 1;
        scoreSum[si] += qualityScore;
        readings.push({ sensorId: sensor.id, sensorCode: sensor.code, value, unit: sensor.unit, qualityFlag: flag, qualityScore });
      }

      observations.push({ timestamp: iso, readings });

      // ---- 环境摘要累加（仅使用有效观测）----
      const tv = slotValues[0], wv = slotValues[1], sv = slotValues[2], pv = slotValues[3];
      if (tv !== null) {
        acc.tempSum += tv; acc.tempN++; acc.tempMin = Math.min(acc.tempMin, tv); acc.tempMax = Math.max(acc.tempMax, tv);
        if (wv !== null) {
          const feel = round1(tv - 5 + wv * 0.15);
          acc.feelSum += feel; acc.feelN++; acc.feelMin = Math.min(acc.feelMin, feel);
        }
      }
      if (wv !== null) { acc.windSum += wv; acc.windN++; acc.windMax = Math.max(acc.windMax, wv); }
      if (sv !== null) { acc.snowSum += sv; acc.snowN++; acc.snowMax = Math.max(acc.snowMax, sv); }
      if (pv !== null) { acc.powerSum += pv; acc.powerN++; acc.powerMin = Math.min(acc.powerMin, pv); }

      const pressure = round1(582 + 2.4 * Math.cos(((hourFloat - 10) / 24) * 2 * Math.PI) + (dayRng() - 0.5) * 1.2);
      acc.presSum += pressure; acc.presN++; acc.presMin = Math.min(acc.presMin, pressure); acc.presMax = Math.max(acc.presMax, pressure);
      const visibility = round1(14 + dayRng() * 5);
      acc.visSum += visibility; acc.visN++; acc.visMax = Math.max(acc.visMax, visibility);
      const snowfall = dayRng() < 0.3 ? round1(dayRng() * 1.2) : 0;
      acc.snowfallTotal += snowfall;
      acc.snowfallPeak = Math.max(acc.snowfallPeak, snowfall);

      // ---- 例行运行事件 ----
      if (d.getUTCHours() === 8 && d.getUTCMinutes() === 0) {
        const selfCheckRng = mulberry32(hashSeed(`${dayKey(ts)}|selfcheck`));
        alerts.push({ time: iso, severity: 'info', title: '雪深传感器完成自检', description: `SNW-03 数据质量 ${(99 + selfCheckRng() * 0.9).toFixed(1)}%` });
      }
      if (d.getUTCHours() === 12 && d.getUTCMinutes() === 0) {
        const linkRng = mulberry32(hashSeed(`${dayKey(ts)}|link`));
        alerts.push({ time: iso, severity: 'info', title: '卫星链路已同步', description: `上行延迟 ${(2 + linkRng() * 1.5).toFixed(1)} 秒 · 下一次同步次日 12:30` });
      }
      if (d.getUTCHours() === 15 && d.getUTCMinutes() === 0 && wv !== null && wv >= 16) {
        alerts.push({ time: iso, severity: 'warning', title: '风速超过巡检阈值', description: `当前 ${wv.toFixed(1)} m/s · 建议延后无人机巡检` });
      }
    }
  }

  if (globalRun.active) flushGlobalGap(gaps, alerts, globalRun, intervalMs, startMs, endMs);
  sensorRuns.forEach((run, si) => {
    if (run.active) flushSensorGap(gaps, alerts, si, run, intervalMs);
  });
  alerts.sort((a, b) => (a.time < b.time ? -1 : a.time > b.time ? 1 : 0));

  const totalExpected = expected.reduce((a, b) => a + b, 0);
  const totalReceived = received.reduce((a, b) => a + b, 0);
  const totalEstimated = estimated.reduce((a, b) => a + b, 0);
  const totalScore = scoreSum.reduce((a, b) => a + b, 0);

  const pct = (n: number, d: number) => (d === 0 ? 100 : Math.round((n / d) * 10000) / 100);

  const environmentSummary: EnvironmentSummary = {
    temperature: { avg: round1(acc.tempSum / acc.tempN), min: round1(acc.tempMin), max: round1(acc.tempMax), unit: '°C' },
    feelsLike: { avg: round1(acc.feelSum / acc.feelN), min: round1(acc.feelMin), unit: '°C' },
    wind: { avg: round1(acc.windSum / acc.windN), max: round1(acc.windMax), unit: 'm/s' },
    snowDepth: { avg: round1(acc.snowSum / acc.snowN), max: round1(acc.snowMax), unit: 'cm' },
    pressure: { avg: round1(acc.presSum / acc.presN), min: round1(acc.presMin), max: round1(acc.presMax), unit: 'hPa' },
    visibility: { avgKm: round1(acc.visSum / acc.visN), maxKm: round1(acc.visMax) },
    snowfall: { totalMm: round1(acc.snowfallTotal), peakMmPerHour: round1(acc.snowfallPeak) },
    battery: { avg: round1(acc.powerSum / acc.powerN), min: round1(acc.powerMin), unit: '%' },
  };

  const dataQuality: DataQuality = {
    intervalSeconds: intervalMs / 1000,
    timezone: 'UTC',
    expectedSamples: totalExpected,
    receivedSamples: totalReceived,
    estimatedSamples: totalEstimated,
    missingSamples: totalExpected - totalReceived,
    completenessPct: pct(totalReceived, totalExpected),
    averageQualityScore: totalReceived ? Math.round((totalScore / totalReceived) * 10000) / 10000 : null,
    gapCount: gaps.length,
    gapReasons: reasonCounts,
    sensors: SENSORS.map((s, si) => ({
      sensorId: s.id,
      sensorCode: s.code,
      expectedSamples: expected[si],
      receivedSamples: received[si],
      estimatedSamples: estimated[si],
      missingSamples: expected[si] - received[si],
      completenessPct: pct(received[si], expected[si]),
      averageQualityScore: received[si] ? Math.round((scoreSum[si] / received[si]) * 10000) / 10000 : null,
    })),
  };

  return { station: STATION, environmentSummary, alerts, observations, dataGaps: gaps, dataQuality };
}

function clampRange(ms: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, ms));
}

function flushGlobalGap(
  gaps: DataGap[],
  alerts: AlertRow[],
  run: RunState,
  intervalMs: number,
  rangeStart: number,
  rangeEnd: number,
): void {
  const rawStart = run.startMs;
  const rawEnd = run.startMs + run.count * intervalMs - 1;
  const start = clampRange(rawStart, rangeStart, rangeEnd);
  const end = clampRange(rawEnd, rangeStart, rangeEnd);
  const count = Math.max(1, Math.round((end - start + 1) / intervalMs));
  gaps.push({
    sensorId: 'ALL_SENSORS',
    reason: run.reason,
    start: new Date(start).toISOString(),
    end: new Date(end).toISOString(),
    expectedSamples: count,
    affectedSensors: SENSORS.length,
    missingSamples: count * SENSORS.length,
  });
  const label = GAP_REASON_LABEL[run.reason];
  alerts.push({
    time: new Date(start).toISOString(),
    severity: run.reason === 'SCHEDULED_MAINTENANCE' ? 'info' : 'warning',
    title: run.reason === 'SCHEDULED_MAINTENANCE' ? '计划维护窗口开始' : `${label}，遥测暂缺`,
    description: `${label} · 全站 ${count} 个采样点缺失`,
  });
  run.active = false;
}

function flushSensorGap(
  gaps: DataGap[],
  alerts: AlertRow[],
  sensorIndex: number,
  run: RunState,
  intervalMs: number,
): void {
  const sensor = SENSORS[sensorIndex];
  const endMs = run.startMs + run.count * intervalMs - 1;
  gaps.push({
    sensorId: sensor.id,
    reason: run.reason,
    start: new Date(run.startMs).toISOString(),
    end: new Date(endMs).toISOString(),
    expectedSamples: run.count,
    affectedSensors: 1,
    missingSamples: run.count,
  });
  alerts.push({
    time: new Date(run.startMs).toISOString(),
    severity: run.reason === 'SENSOR_FAULT' ? 'critical' : 'warning',
    title: `${sensor.code} 数据中断`,
    description: `${GAP_REASON_LABEL[run.reason]} · ${run.count} 个采样点缺失`,
  });
  run.active = false;
}
