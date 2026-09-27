// 观测归档包 API 客户端
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

export type CreateArchiveBody = {
  start: string;
  end: string;
  rangeLabel: string;
  createdBy?: string;
};

async function parseJsonOrThrow(res: Response): Promise<any> {
  const text = await res.text();
  let data: any = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    throw new Error(`服务返回异常（${res.status}）`);
  }
  if (!res.ok) throw new Error(data?.error ?? `请求失败（${res.status}）`);
  return data;
}

export async function fetchArchives(): Promise<ArchiveMeta[]> {
  const res = await fetch('/api/archives');
  const data = await parseJsonOrThrow(res);
  return data.archives as ArchiveMeta[];
}

export async function createArchiveApi(body: CreateArchiveBody): Promise<ArchiveMeta> {
  const res = await fetch('/api/archives', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const data = await parseJsonOrThrow(res);
  return data.archive as ArchiveMeta;
}

// 浏览器直接走下载链接，浏览器会依据 Content-Disposition 保存为 JSON 文件
export function archiveDownloadUrl(id: string): string {
  return `/api/archives/${encodeURIComponent(id)}/download`;
}
