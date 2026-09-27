# 雪山气象站

React + Vite + TypeScript 的高海拔自动气象站监控基础项目。提供山地站点环境概览、传感器阵列、观测动态、趋势图和链路状态，并为月度巡护提供**观测归档包**，保留后续接入真实遥测、卫星同步、告警规则和历史数据服务的空间。

```bash
npm install
npm run dev
```

## 观测归档包

月度巡护结束后，外部分析人员可在「观测归档包」面板按时间范围（最近 7 天 / 本月 / 上一个月 / 自定义日期）生成并下载机器可读 JSON。归档在生成时刻一次性写入磁盘并冻结，之后重复下载字节完全一致，不会随实时数据变化。

每份归档包含：

- 归档元信息：编号、时间范围、**生成时间**、生成人、`immutable: true`、SHA-256；
- 观测数据：≤3 天范围为 10 分钟粒度，更长范围（月度）为 1 小时粒度；
- 告警列表（info / warning / critical）；
- 环境摘要（气温、体感、风、雪深、气压、能见度、降雪、电量）；
- 数据质量：完整率、质量评分、ESTIMATED/MISSING 标记；
- **数据缺失情况**：逐段记录缺失原因（计划维护、卫星链路中断、传感器故障、低功耗停机）、起止时间和缺失采样点数。

### API

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/api/archives` | 已生成归档的元数据列表 |
| POST | `/api/archives` | 按 `{ start, end, rangeLabel, createdBy }`（ISO 8601）生成归档，上限 370 天 |
| GET | `/api/archives/:id` | 单条归档元数据 |
| GET | `/api/archives/:id/download` | 下载冻结的 JSON（带 `X-Archive-Immutable` 与 SHA-256 响应头） |

归档文件存放在项目根目录 `archives/`（已在 `.gitignore` 忽略，部署时应挂载持久卷）。当前历史数据为确定性合成遥测；接入真实数据时只需替换 `server/observations.ts` 中的 `buildObservationDataset`，归档流程不变。
