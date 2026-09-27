// 观测归档包存储：生成时一次性写入磁盘，之后只读，绝不随实时数据变化。
import { mkdirSync, readFileSync, readdirSync, writeFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { buildObservationDataset } from './observations.ts';

// 固定在项目根目录的 archives/ 下，与服务启动时的工作目录无关
const PROJECT_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
export const ARCHIVE_DIR = join(PROJECT_ROOT, 'archives');
const INDEX_FILE = join(ARCHIVE_DIR, 'index.json');
const MAX_RANGE_DAYS = 370;

export type ArchiveMeta = {
  id: string;
  stationId: string;
  rangeLabel: string;
  start: string;
  end: string;
  generatedAt: string;
  createdBy: string;
  fileName: string;
  fileSizeBytes: number;
  completenessPct: number;
  missingSamples: number;
  gapCount: number;
  alertCount: number;
  observationSlots: number;
  sha256: string;
  displayName: string;
  immutable: true;
};

type IndexFile = { archives: ArchiveMeta[] };

let indexCache: IndexFile | null = null;

export function ensureArchiveStore(): void {
  if (!existsSync(ARCHIVE_DIR)) mkdirSync(ARCHIVE_DIR, { recursive: true });
  if (!existsSync(INDEX_FILE)) writeFileSync(INDEX_FILE, JSON.stringify({ archives: [] }, null, 2), 'utf-8');
}

function loadIndex(): IndexFile {
  ensureArchiveStore();
  if (indexCache) return indexCache;
  try {
    indexCache = JSON.parse(readFileSync(INDEX_FILE, 'utf-8')) as IndexFile;
    if (!Array.isArray(indexCache.archives)) indexCache = { archives: [] };
  } catch {
    indexCache = { archives: [] };
  }
  return indexCache;
}

function saveIndex(index: IndexFile): void {
  ensureArchiveStore();
  // 先写临时文件再重命名，避免归档列表读取到半截文件
  writeFileSync(INDEX_FILE, JSON.stringify(index, null, 2), 'utf-8');
  indexCache = index;
}

export function listArchives(): ArchiveMeta[] {
  return loadIndex().archives.sort((a, b) => (a.generatedAt < b.generatedAt ? 1 : -1));
}

export function getArchive(id: string): { meta: ArchiveMeta; content: string } | null {
  const meta = loadIndex().archives.find(a => a.id === id);
  if (!meta) return null;
  const path = join(ARCHIVE_DIR, meta.fileName);
  if (!existsSync(path)) return null;
  return { meta, content: readFileSync(path, 'utf-8') };
}

export function parseRangeBody(body: unknown): { start: string; end: string } | { error: string } {
  const b = (body ?? {}) as Record<string, unknown>;
  if (typeof b.start !== 'string' || typeof b.end !== 'string') {
    return { error: '请提供 ISO 8601 格式的 start 与 end 时间' };
  }
  const startMs = Date.parse(b.start);
  const endMs = Date.parse(b.end);
  if (!Number.isFinite(startMs) || !Number.isFinite(endMs)) {
    return { error: 'start 或 end 不是有效的时间格式' };
  }
  if (startMs > endMs) return { error: '开始时间不能晚于结束时间' };
  if ((endMs - startMs) / 86_400_000 > MAX_RANGE_DAYS) {
    return { error: `单次归档时间范围不能超过 ${MAX_RANGE_DAYS} 天` };
  }
  return { start: b.start, end: b.end };
}

export function createArchive(params: { start: string; end: string; rangeLabel?: string; createdBy?: string }): ArchiveMeta {
  ensureArchiveStore();
  const generatedAt = new Date();
  const id = makeArchiveId(generatedAt);
  const dataset = buildObservationDataset(params.start, params.end);

  const document = {
    format: 'observation-archive',
    schemaVersion: '1.0',
    station: dataset.station,
    archive: {
      id,
      rangeLabel: params.rangeLabel ?? '',
      start: params.start,
      end: params.end,
      generatedAt: generatedAt.toISOString(),
      createdBy: params.createdBy || 'external-analyst',
      immutable: true,
      frozen: true,
    },
    generatedAt: generatedAt.toISOString(),
    source: {
      type: 'synthetic-deterministic',
      note: '归档在生成时刻冻结；重新下载本文件不会随实时数据变化。',
    },
    environmentSummary: dataset.environmentSummary,
    alerts: dataset.alerts,
    observations: dataset.observations,
    dataGaps: dataset.dataGaps,
    dataQuality: dataset.dataQuality,
  };

  const content = JSON.stringify(document, null, 2);
  const sha256 = createHash('sha256').update(content, 'utf-8').digest('hex');
  const rangeTag = `${params.start.slice(0, 10)}_${params.end.slice(0, 10)}`;
  const fileName = `${dataset.station.id}_${rangeTag}_${id}.json`;
  const displayName = params.rangeLabel
    ? `${dataset.station.id}_${params.rangeLabel}_${id}.json`
    : fileName;
  const filePath = join(ARCHIVE_DIR, fileName);

  // 只写一次：文件已存在则拒绝覆盖
  if (existsSync(filePath)) throw new Error('归档文件已存在，拒绝覆盖');
  writeFileSync(filePath, content, { encoding: 'utf-8', flag: 'wx' });

  const meta: ArchiveMeta = {
    id,
    stationId: dataset.station.id,
    rangeLabel: params.rangeLabel ?? '',
    start: params.start,
    end: params.end,
    generatedAt: generatedAt.toISOString(),
    createdBy: params.createdBy || 'external-analyst',
    fileName,
    fileSizeBytes: Buffer.byteLength(content, 'utf-8'),
    completenessPct: dataset.dataQuality.completenessPct,
    missingSamples: dataset.dataQuality.missingSamples,
    gapCount: dataset.dataQuality.gapCount,
    alertCount: dataset.alerts.length,
    observationSlots: dataset.observations.length,
    sha256,
    displayName,
    immutable: true,
  };

  const index = loadIndex();
  if (index.archives.some(a => a.id === id)) throw new Error('归档编号已存在');
  index.archives.push(meta);
  saveIndex(index);
  return meta;
}

function makeArchiveId(at: Date): string {
  const p = (n: number, l = 2) => String(n).padStart(l, '0');
  const stamp = `${at.getUTCFullYear()}${p(at.getUTCMonth() + 1)}${p(at.getUTCDate())}T${p(at.getUTCHours())}${p(at.getUTCMinutes())}${p(at.getUTCSeconds())}Z`;
  const rand = createHash('sha1').update(`${at.toISOString()}|${Math.random()}`).digest('hex').slice(0, 6);
  return `ARC-${stamp}-${rand}`;
}

// 启动时确保目录存在
ensureArchiveStore();

// 供诊断使用：归档目录下已有文件数量
export function archiveCount(): number {
  return readdirSync(ARCHIVE_DIR).filter(f => f.endsWith('.json') && f !== 'index.json').length;
}
