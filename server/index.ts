import express from 'express';
import cors from 'cors';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  createArchive,
  listArchives,
  getArchive,
  parseRangeBody,
  archiveCount,
} from './archiveStore.ts';

const PROJECT_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

const app = express();
const port = Number(process.env.PORT || 4002);
app.use(cors());
app.use(express.json({ limit: '1mb' }));

const readings = [
  { sensor: 'TMP-01', value: -8.4, unit: '°C' },
  { sensor: 'WND-02', value: 18.6, unit: 'm/s' },
  { sensor: 'SNW-03', value: 142, unit: 'cm' },
  { sensor: 'PWR-04', value: 76, unit: '%' },
];

app.get('/api/health', (_req, res) =>
  res.json({
    status: 'ok',
    project: 'snow-mountain-weather-station',
    workflow: '采集传感器数据 → 校验质量 → 触发告警 → 归档观测包',
  }),
);

app.get('/api/readings', (_req, res) => res.json(readings));

app.post('/api/sync', (_req, res) => res.json({ status: 'accepted', syncedAt: new Date().toISOString() }));

// ---- 观测归档包 ----

// 归档列表（只读元数据，不含观测正文）
app.get('/api/archives', (_req, res) => {
  res.json({ archives: listArchives(), count: archiveCount() });
});

// 按时间范围生成归档：生成后内容冻结，不再随实时数据变化
app.post('/api/archives', (req, res) => {
  const range = parseRangeBody(req.body);
  if ('error' in range) {
    res.status(400).json({ error: range.error });
    return;
  }
  const body = (req.body ?? {}) as Record<string, unknown>;
  const meta = createArchive({
    start: range.start,
    end: range.end,
    rangeLabel: typeof body.rangeLabel === 'string' ? body.rangeLabel : undefined,
    createdBy: typeof body.createdBy === 'string' ? body.createdBy : undefined,
  });
  res.status(201).json({ archive: meta });
});

// 下载归档机器可读文件（自生成起内容固定）
app.get('/api/archives/:id/download', (req, res) => {
  const found = getArchive(req.params.id);
  if (!found) {
    res.status(404).json({ error: '归档不存在或已被移除' });
    return;
  }
  const { meta, content } = found;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  const fallback = encodeURIComponent(meta.displayName).replace(/['()*]/g, '');
  res.setHeader(
    'Content-Disposition',
    `attachment; filename="${fallback}"; filename*=UTF-8''${encodeURIComponent(meta.displayName)}`,
  );
  res.setHeader('X-Archive-Id', meta.id);
  res.setHeader('X-Archive-SHA256', meta.sha256);
  res.setHeader('X-Archive-Immutable', 'true');
  res.send(content);
});

// 单条归档元数据
app.get('/api/archives/:id', (req, res) => {
  const found = getArchive(req.params.id);
  if (!found) {
    res.status(404).json({ error: '归档不存在或已被移除' });
    return;
  }
  res.json({ archive: found.meta });
});

// 生产环境托管构建产物
const distDir = join(PROJECT_ROOT, 'dist');
if (existsSync(distDir)) {
  app.use(express.static(distDir));
}

app.listen(port, () => console.log(`Weather station API running at http://localhost:${port} (archives dir: ./archives)`));
