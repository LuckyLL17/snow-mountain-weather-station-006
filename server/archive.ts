import { createHash, randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// 观测归档包：在生成时刻把观测数据、告警、环境摘要与质量信息冻结为 JSON 文件。
// 文件落盘后即不可变，下载接口始终返回生成时的快照，不随实时数据变化。

const ARCHIVE_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), 'archives');
const INTERVAL_MINUTES = 10;
const INTERVAL_MS = INTERVAL_MINUTES * 60_000;
export const MAX_RANGE_DAYS = 45;

const STATION = { id: 'M-07', name: '雪线气象站', location: '北麓冰川保护区', elevationM: 4820 };

const SENSORS = [
  { code: 'TMP-01', name: '山脊温度', unit: '°C', base: -8.2, amp: 4.1, noise: 0.5, digits: 1 },
  { code: 'WND-02', name: '风速', unit: 'm/s', base: 12.4, amp: 5.8, noise: 1.6, digits: 1 },
  { code: 'SNW-03', name: '积雪深度', unit: 'cm', base: 141, amp: 2.6, noise: 0.7, digits: 0 },
  { code: 'PWR-04', name: '电池组电量', unit: '%', base: 77, amp: 5.5, noise: 0.9, digits: 0 }
];

// 历史缺测窗口（维护 / 链路中断），归档时如实记录为数据缺失
const GAP_WINDOWS = [
  { sensor: 'TMP-01', from: '2026-09-07T02:00:00.000Z', to: '2026-09-07T05:30:00.000Z', reason: '温度传感器加热除冰维护' },
  { sensor: 'ALL', from: '2026-09-14T13:00:00.000Z', to: '2026-09-14T15:00:00.000Z', reason: '卫星链路中断，数据未回传' },
  { sensor: 'PWR-04', from: '2026-09-21T00:00:00.000Z', to: '2026-09-21T06:00:00.000Z', reason: '电池组切换，电量采集中断' }
];

type SensorDef = (typeof SENSORS)[number];
export type ArchiveMeta = {
  id: string; fileName: string; generatedAt: string;
  range: { from: string; to: string; intervalMinutes: number };
  completeness: number; missingWindows: number; missingSamples: number; sizeBytes: number;
};

// 由传感器编号 + 时间戳派生的确定性伪随机数，保证同一时刻的历史值恒定
function seededNoise(seed: string) {
  const digest = createHash('md5').update(seed).digest();
  return (digest.readUInt32LE(0) / 0xffffffff) * 2 - 1;
}

function sampleValue(sensor: SensorDef, time: Date) {
  const dayMs = 24 * 3600_000;
  const diurnal = Math.sin((time.getTime() / dayMs) * Math.PI * 2 - Math.PI / 2);
  const slow = Math.sin((time.getTime() / (dayMs * 9)) * Math.PI * 2);
  const value = sensor.base + sensor.amp * 0.6 * diurnal + sensor.amp * 0.4 * slow + seededNoise(`${sensor.code}|${time.toISOString()}`) * sensor.noise;
  return Number(value.toFixed(sensor.digits));
}

function gapFor(sensorCode: string, time: Date) {
  const t = time.getTime();
  return GAP_WINDOWS.find(g => (g.sensor === 'ALL' || g.sensor === sensorCode) && t >= Date.parse(g.from) && t < Date.parse(g.to));
}

function gridTimes(from: Date, to: Date) {
  const start = Math.ceil(from.getTime() / INTERVAL_MS) * INTERVAL_MS;
  const end = Math.floor(to.getTime() / INTERVAL_MS) * INTERVAL_MS;
  const times: Date[] = [];
  for (let t = start; t <= end; t += INTERVAL_MS) times.push(new Date(t));
  return times;
}

function buildAlerts(rangeFrom: Date, rangeTo: Date, windSamples: { t: string; v: number }[]) {
  const alerts: { time: string; level: string; title: string; detail: string }[] = [];
  // 滞回阈值：超过 16 m/s 告警，回落到 14 以下才重新设防，避免噪声反复触发
  let armed = true;
  let peak = 0;
  let peakAt = '';
  for (const sample of windSamples) {
    if (armed) {
      if (sample.v > 16) { armed = false; peak = sample.v; peakAt = sample.t; }
    } else if (sample.v >= peak) {
      peak = sample.v; peakAt = sample.t;
    } else if (sample.v < 14) {
      alerts.push({ time: peakAt, level: 'warning', title: '风速超过巡检阈值', detail: `阵风峰值 ${peak} m/s，建议延后无人机巡检` });
      armed = true;
    }
  }
  if (!armed) alerts.push({ time: peakAt, level: 'warning', title: '风速超过巡检阈值', detail: `阵风峰值 ${peak} m/s，建议延后无人机巡检` });
  for (const gap of GAP_WINDOWS) {
    const from = Date.parse(gap.from);
    if (from >= rangeFrom.getTime() && from < rangeTo.getTime()) {
      alerts.push({ time: gap.from, level: 'warning', title: gap.sensor === 'ALL' ? '卫星链路中断' : '传感器维护', detail: gap.reason });
    }
  }
  return alerts.sort((a, b) => a.time.localeCompare(b.time));
}

export function createArchive(rangeFrom: Date, rangeTo: Date): ArchiveMeta {
  const generatedAt = new Date();
  const times = gridTimes(rangeFrom, rangeTo);
  const observations: Record<string, { t: string; v: number }[]> = {};
  const quality: unknown[] = [];
  const missingWindows: { sensor: string; from: string; to: string; reason: string; missingSamples: number }[] = [];
  let totalExpected = 0;
  let totalActual = 0;

  for (const sensor of SENSORS) {
    const samples: { t: string; v: number }[] = [];
    for (const time of times) {
      if (!gapFor(sensor.code, time)) samples.push({ t: time.toISOString(), v: sampleValue(sensor, time) });
    }
    observations[sensor.code] = samples;
    const expected = times.length;
    const missing = expected - samples.length;
    totalExpected += expected;
    totalActual += samples.length;
    const completeness = expected === 0 ? 100 : Number(((samples.length / expected) * 100).toFixed(1));
    quality.push({ sensor: sensor.code, name: sensor.name, unit: sensor.unit, expectedSamples: expected, actualSamples: samples.length, missingSamples: missing, completeness, qualityScore: Number((completeness * 0.98).toFixed(1)) });

    for (const gap of GAP_WINDOWS) {
      if (gap.sensor !== 'ALL' && gap.sensor !== sensor.code) continue;
      const gapFrom = Date.parse(gap.from);
      const gapTo = Date.parse(gap.to);
      const from = Math.max(gapFrom, rangeFrom.getTime());
      const to = Math.min(gapTo, rangeTo.getTime());
      if (from < to) {
        const missingSamples = times.filter(time => time.getTime() >= gapFrom && time.getTime() < gapTo).length;
        missingWindows.push({ sensor: sensor.code, from: new Date(from).toISOString(), to: new Date(to).toISOString(), reason: gap.reason, missingSamples });
      }
    }
  }

  const temps = observations['TMP-01'].map(s => s.v);
  const winds = observations['WND-02'].map(s => s.v);
  const snow = observations['SNW-03'];
  const power = observations['PWR-04'].map(s => s.v);
  const avg = (xs: number[]) => xs.length ? Number((xs.reduce((a, b) => a + b, 0) / xs.length).toFixed(1)) : null;
  const extreme = (xs: number[], compare: (best: number, x: number) => boolean) => xs.length ? xs.reduce((best, x) => compare(x, best) ? x : best) : null;
  const environment = {
    avgTemperature: avg(temps), minTemperature: extreme(temps, (x, best) => x < best), maxTemperature: extreme(temps, (x, best) => x > best),
    maxWindSpeed: extreme(winds, (x, best) => x > best), avgWindSpeed: avg(winds),
    latestSnowDepth: snow.length ? snow[snow.length - 1].v : null,
    minBattery: extreme(power, (x, best) => x < best),
    pressureHPa: 582, visibilityKm: 16.8
  };

  const completeness = totalExpected === 0 ? 100 : Number(((totalActual / totalExpected) * 100).toFixed(1));
  const stamp = generatedAt.toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z');
  const id = `M07-${stamp}-${randomBytes(3).toString('hex')}`;
  const fileName = `${id}.json`;

  const payload = {
    archiveId: id,
    format: 'snow-mountain-weather-station/observation-archive@1',
    frozen: true,
    station: STATION,
    generatedAt: generatedAt.toISOString(),
    range: { from: rangeFrom.toISOString(), to: rangeTo.toISOString(), intervalMinutes: INTERVAL_MINUTES },
    environment,
    quality,
    missing: { totalExpectedSamples: totalExpected, totalActualSamples: totalActual, completeness, windows: missingWindows },
    alerts: buildAlerts(rangeFrom, rangeTo, observations['WND-02']),
    observations
  };

  mkdirSync(ARCHIVE_DIR, { recursive: true });
  const filePath = path.join(ARCHIVE_DIR, fileName);
  writeFileSync(filePath, JSON.stringify(payload, null, 2));
  return toMeta(payload, statSync(filePath).size);
}

function toMeta(payload: any, sizeBytes: number): ArchiveMeta {
  return {
    id: payload.archiveId, fileName: `${payload.archiveId}.json`, generatedAt: payload.generatedAt,
    range: payload.range, completeness: payload.missing.completeness,
    missingWindows: payload.missing.windows.length,
    missingSamples: payload.missing.totalExpectedSamples - payload.missing.totalActualSamples,
    sizeBytes
  };
}

export function listArchives(): ArchiveMeta[] {
  if (!existsSync(ARCHIVE_DIR)) return [];
  return readdirSync(ARCHIVE_DIR)
    .filter(name => name.endsWith('.json'))
    .map(name => {
      try {
        const filePath = path.join(ARCHIVE_DIR, name);
        return toMeta(JSON.parse(readFileSync(filePath, 'utf8')), statSync(filePath).size);
      } catch {
        return null;
      }
    })
    .filter((meta): meta is ArchiveMeta => meta !== null)
    .sort((a, b) => b.generatedAt.localeCompare(a.generatedAt));
}

export function archiveFilePath(id: string) {
  if (!/^[A-Za-z0-9-]+$/.test(id)) return null;
  const filePath = path.join(ARCHIVE_DIR, `${id}.json`);
  return existsSync(filePath) ? filePath : null;
}
