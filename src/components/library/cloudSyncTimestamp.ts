export function formatLastSynced(timestamp: number | null, now = Date.now()): string {
  if (timestamp === null || !Number.isFinite(timestamp)) return 'Never';
  const date = new Date(timestamp);
  if (!Number.isFinite(date.getTime())) return 'Never';
  const exact = date.toLocaleString(undefined, {
    year: 'numeric', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit',
  });
  const elapsedSec = Math.floor((now - timestamp) / 1000);
  if (elapsedSec < 0) return exact;
  if (elapsedSec < 30) return `Just now · ${exact}`;
  if (elapsedSec < 60) return `${elapsedSec} seconds ago · ${exact}`;
  const elapsedMin = Math.floor(elapsedSec / 60);
  if (elapsedMin < 60) return `${elapsedMin} minute${elapsedMin > 1 ? 's' : ''} ago · ${exact}`;
  return exact;
}
