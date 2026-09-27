import express from 'express';
import cors from 'cors';
import { MAX_RANGE_DAYS, archiveFilePath, createArchive, listArchives } from './archive.ts';
const app = express();
const port = Number(process.env.PORT || 4002);
app.use(cors()); app.use(express.json());
const readings = [{ sensor: 'TMP-01', value: -8.4, unit: '°C' }, { sensor: 'WND-02', value: 18.6, unit: 'm/s' }, { sensor: 'SNW-03', value: 142, unit: 'cm' }, { sensor: 'PWR-04', value: 76, unit: '%' }];
app.get('/api/health', (_req, res) => res.json({ status: 'ok', project: 'snow-mountain-weather-station', workflow: '采集传感器数据 → 校验质量 → 触发告警 → 同步观测记录' }));
app.get('/api/readings', (_req, res) => res.json(readings));
app.post('/api/sync', (_req, res) => res.json({ status: 'accepted', syncedAt: new Date().toISOString() }));

// 观测归档包：按时间范围生成冻结快照，落盘后内容不再随实时数据变化
app.post('/api/archives', (req, res) => {
  const from = new Date(req.body?.from);
  const to = new Date(req.body?.to);
  if (Number.isNaN(from.getTime()) || Number.isNaN(to.getTime())) return res.status(400).json({ error: '请提供合法的 from / to 时间（ISO 8601）' });
  if (from >= to) return res.status(400).json({ error: '起始时间必须早于结束时间' });
  if (to.getTime() - from.getTime() < 10 * 60_000) return res.status(400).json({ error: '时间范围至少 10 分钟（一个采样间隔）' });
  if (to.getTime() - from.getTime() > MAX_RANGE_DAYS * 24 * 3600_000) return res.status(400).json({ error: `时间范围最长 ${MAX_RANGE_DAYS} 天` });
  res.status(201).json(createArchive(from, to));
});
app.get('/api/archives', (_req, res) => res.json(listArchives()));
app.get('/api/archives/:id/download', (req, res) => {
  const filePath = archiveFilePath(req.params.id);
  if (!filePath) return res.status(404).json({ error: '归档不存在' });
  res.download(filePath);
});
app.listen(port, () => console.log(`Weather station API running at http://localhost:${port}`));
