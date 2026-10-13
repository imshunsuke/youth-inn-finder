const count = (value) => Number.isSafeInteger(value) && value >= 0 ? value : 0;

export function intervalFeedback(meta = {}) {
  meta ||= {};
  const coverage = meta.snapshotCoverage || {};
  const total = count(coverage.totalStations);
  const fresh = Math.min(total, count(coverage.freshStations));
  const progress = total ? `已更新 ${fresh}/${total} 个驿站` : "区间结果尚未准备好";
  const collection = meta.collection || {};
  const requested = count(collection.requested), accepted = Math.min(requested, count(collection.accepted));
  if (collection.capacityLimited || collection.status === "capacity-limited") {
    const waiting = Math.max(0, requested - accepted);
    return {
      title: accepted ? "部分查询尚未入队" : "查询队列已满",
      description: `${progress}。${accepted ? `${accepted}/${requested} 个待更新驿站已排队，其余暂未入队。` : "待更新的驿站暂未入队。"}页面会自动重试，也可以先缩小查询区域。`,
      summary: `${progress} · ${waiting} 个待更新驿站尚未入队`,
    };
  }
  if (count(coverage.lastFailedStations)) return {
    title: "部分驿站暂时查不到数据",
    description: `${progress}。部分驿站上次查询失败，后台会稍后重试，页面会自动更新。`,
    summary: `${progress} · 部分驿站查询失败，稍后重试`,
  };
  const queued = collection.status === "queued" && accepted > 0;
  return {
    title: queued ? fresh ? "已更新部分驿站" : "等待首批查询结果" : "区间结果尚未准备好",
    description: `${progress}。${queued ? "待更新的驿站已排队，结果会陆续显示。" : "稍后会自动重新查询。"}无需反复点击重试。`,
    summary: `${progress}${queued ? fresh ? " · 其余驿站待更新" : " · 等待首批结果" : ""}`,
  };
}

export function intervalRetry({ status = 200, retryAfter, refreshAfterMs = 60_000 } = {}, now = Date.now()) {
  const seconds = typeof retryAfter === "string" && /^\d+$/.test(retryAfter.trim()) ? Number(retryAfter) * 1000 : NaN;
  const dateDelay = typeof retryAfter === "string" ? Date.parse(retryAfter) - now : NaN;
  const delay = Number.isFinite(seconds) ? seconds : Number.isFinite(dateDelay) ? dateDelay : 0;
  return {
    retryable: !(status >= 400 && status < 500 && ![408, 429].includes(status)),
    retryAt: now + Math.max(60_000, Number.isFinite(refreshAfterMs) ? refreshAfterMs : 0, delay),
  };
}
