import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  archiveDownloadUrl,
  createArchiveApi,
  fetchArchives,
  type ArchiveMeta,
} from '../api/archives';

type PresetKey = 'last7d' | 'thisMonth' | 'lastMonth' | 'custom';

const PRESETS: { key: PresetKey; label: string }[] = [
  { key: 'last7d', label: '最近 7 天' },
  { key: 'thisMonth', label: '本月（月度巡护）' },
  { key: 'lastMonth', label: '上一个月' },
  { key: 'custom', label: '自定义日期' },
];

function utcDayStart(d: Date): string {
  return d.toISOString().slice(0, 10) + 'T00:00:00Z';
}

function presetRange(key: Exclude<PresetKey, 'custom'>): { start: string; end: string; label: string } {
  const now = new Date();
  if (key === 'last7d') {
    const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() - 6));
    return { start: utcDayStart(start), end: utcDayStart(now), label: `近7天巡护片段_${utcDayStart(start).slice(0, 10)}` };
  }
  if (key === 'thisMonth') {
    const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
    return { start: utcDayStart(start), end: utcDayStart(now), label: `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, '0')}月度巡护` };
  }
  const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 1));
  const end = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  return { start: utcDayStart(start), end: utcDayStart(end), label: `${start.getUTCFullYear()}-${String(start.getUTCMonth() + 1).padStart(2, '0')}月度巡护` };
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(2)} MB`;
}

function formatTime(iso: string): string {
  return iso.replace('T', ' ').replace(/\.\d+Z$/, ' UTC');
}

export default function ArchiveSection() {
  const [preset, setPreset] = useState<PresetKey>('thisMonth');
  const [customStart, setCustomStart] = useState('2026-09-01');
  const [customEnd, setCustomEnd] = useState('2026-09-26');
  const [creator, setCreator] = useState('外部分析人员');
  const [archives, setArchives] = useState<ArchiveMeta[]>([]);
  const [loading, setLoading] = useState(true);
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState('');
  const [hint, setHint] = useState('');
  const [downloadingId, setDownloadingId] = useState('');

  const load = useCallback(async () => {
    setLoading(true);
    try {
      setArchives(await fetchArchives());
      setError('');
    } catch (e) {
      setError(e instanceof Error ? e.message : '归档列表加载失败');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const selection = useMemo(() => {
    if (preset === 'custom') {
      return {
        start: `${customStart}T00:00:00Z`,
        end: `${customEnd}T00:00:00Z`,
        label: `自定义_${customStart}_${customEnd}`,
      };
    }
    return presetRange(preset);
  }, [preset, customStart, customEnd]);

  const invalidCustom =
    preset === 'custom' && (!customStart || !customEnd || customStart > customEnd);

  const handleCreate = async () => {
    if (invalidCustom || creating) return;
    setCreating(true);
    setError('');
    setHint('');
    try {
      const meta = await createArchiveApi({
        start: selection.start,
        end: selection.end,
        rangeLabel: selection.label,
        createdBy: creator || '外部分析人员',
      });
      setHint(`归档 ${meta.id} 已生成并冻结，可下载`);
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : '归档生成失败');
    } finally {
      setCreating(false);
    }
  };

  const handleDownload = (a: ArchiveMeta) => {
    setDownloadingId(a.id);
    setHint(`开始下载 ${a.displayName}`);
    window.setTimeout(() => setDownloadingId(cur => (cur === a.id ? '' : cur)), 1500);
  };

  return (
    <section className="archive-section">
      <div className="section-title">
        <div>
          <span className="eyebrow">OBSERVATION ARCHIVE / 月度巡护</span>
          <h3>观测归档包</h3>
        </div>
        <span className="archive-frozen-tag">🔒 生成后冻结 · 不随实时数据变化</span>
      </div>

      <div className="archive-panel">
        <div className="archive-form">
          <div className="archive-field">
            <label>时间范围</label>
            <div className="range-switch">
              {PRESETS.map(p => (
                <button
                  key={p.key}
                  className={preset === p.key ? 'active' : ''}
                  onClick={() => setPreset(p.key)}
                >
                  {p.label}
                </button>
              ))}
            </div>
          </div>

          {preset === 'custom' && (
            <div className="archive-field custom-range">
              <label>自定义起止日期（UTC）</label>
              <div>
                <input type="date" value={customStart} onChange={e => setCustomStart(e.target.value)} />
                <span>至</span>
                <input type="date" value={customEnd} onChange={e => setCustomEnd(e.target.value)} />
              </div>
            </div>
          )}

          <div className="archive-field">
            <label>归档区间</label>
            <code className="archive-range-preview">
              {formatTime(selection.start)} → {formatTime(selection.end)}
            </code>
          </div>

          <div className="archive-field creator-field">
            <label htmlFor="archive-creator">生成人 / 用途</label>
            <input
              id="archive-creator"
              type="text"
              value={creator}
              maxLength={40}
              onChange={e => setCreator(e.target.value)}
              placeholder="如：外部分析人员"
            />
          </div>

          <div className="archive-actions">
            <button className="create-archive-btn" disabled={creating || invalidCustom} onClick={handleCreate}>
              {creating ? '正在汇总并冻结数据…' : '生成观测归档包'}
            </button>
            <button className="refresh-archive-btn" onClick={() => void load()} disabled={loading}>
              ↻ 刷新列表
            </button>
          </div>

          <p className="archive-note">
            归档为机器可读 JSON，包含观测数据、告警、环境摘要、数据质量与缺失明细，
            并记录生成时间、时间范围与 SHA-256 校验值；月度粒度为 1 小时/点。
          </p>
          {invalidCustom && <p className="archive-error">请选择有效的起止日期（开始不能晚于结束）。</p>}
          {error && <p className="archive-error">{error}</p>}
          {hint && <p className="archive-hint">{hint}</p>}
        </div>

        <div className="archive-list-wrap">
          <div className="archive-list-head">
            <span>已生成归档（{archives.length}）</span>
            <span className="archive-list-sub">按生成时间倒序 · 文件只读</span>
          </div>
          {loading ? (
            <div className="archive-empty">正在加载归档记录…</div>
          ) : archives.length === 0 ? (
            <div className="archive-empty">
              暂无归档。选择时间范围后点击「生成观测归档包」。
            </div>
          ) : (
            <div className="archive-list">
              {archives.map(a => (
                <div className="archive-row" key={a.id}>
                  <div className="archive-row-main">
                    <b>{a.rangeLabel || '未命名区间'}</b>
                    <code className="archive-row-id">{a.id}</code>
                    <span className="archive-row-range">
                      {a.start.slice(0, 10)} → {a.end.slice(0, 10)}
                    </span>
                  </div>
                  <div className="archive-row-meta">
                    <span title="生成时间">🕓 {formatTime(a.generatedAt)}</span>
                    <span title="观测时槽">{a.observationSlots} 时槽</span>
                    <span title="告警条数">告警 {a.alertCount}</span>
                    <span
                      className={a.completenessPct < 95 ? 'q-bad' : a.completenessPct < 99 ? 'q-warn' : 'q-good'}
                      title={`缺失 ${a.missingSamples} 个采样点 · ${a.gapCount} 个缺失区间`}
                    >
                      完整率 {a.completenessPct}%
                    </span>
                    <span className={a.missingSamples > 0 ? 'gap-badge' : 'gap-badge none'} title="数据缺失情况">
                      缺失 {a.missingSamples} · {a.gapCount} 段
                    </span>
                    <span>{formatBytes(a.fileSizeBytes)}</span>
                  </div>
                  <a
                    className={`download-btn${downloadingId === a.id ? ' busy' : ''}`}
                    href={archiveDownloadUrl(a.id)}
                    onClick={() => handleDownload(a)}
                  >
                    下载 JSON
                  </a>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </section>
  );
}
