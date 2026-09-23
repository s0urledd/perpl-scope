// API client: JSON GETs with a short in-memory cache and request coalescing,
// plus the server-sent event stream shared by all views.
const cache = new Map(); // url -> { at, data, pending }

export async function get(path, { maxAge = 1500, signal } = {}) {
  const hit = cache.get(path);
  if (hit?.data && Date.now() - hit.at < maxAge) return hit.data;
  if (hit?.pending) return hit.pending;
  const pending = fetch(`/api/v1/${path}`, { signal, headers: { accept: 'application/json' } }).then(async res => {
    const body = await res.json().catch(() => ({}));
    if (!res.ok) throw Object.assign(new Error(body.error || `HTTP_${res.status}`), { status: res.status });
    cache.set(path, { at: Date.now(), data: body });
    return body;
  }).finally(() => { const cur = cache.get(path); if (cur) cur.pending = null; });
  cache.set(path, { ...(hit ?? {}), pending });
  if (cache.size > 200) cache.delete(cache.keys().next().value);
  return pending;
}
export const invalidate = prefix => { for (const k of cache.keys()) if (k.startsWith(prefix)) cache.delete(k); };

// One EventSource for the page; views subscribe to named events.
const handlers = new Map();
let source = null;
export const stream = {
  status: 'connecting',
  on(event, fn) { if (!handlers.has(event)) handlers.set(event, new Set()); handlers.get(event).add(fn); return () => handlers.get(event)?.delete(fn); },
  emit(event, data) { for (const fn of handlers.get(event) ?? []) { try { fn(data); } catch (error) { console.error(error); } } },
  connect() {
    if (source) return;
    source = new EventSource('/api/v1/stream');
    source.onopen = () => { this.status = 'open'; this.emit('status', 'open'); };
    source.onerror = () => { this.status = 'reconnecting'; this.emit('status', 'reconnecting'); };
    for (const name of ['block', 'trades', 'liquidations', 'protocol', 'backfill', 'proposed']) source.addEventListener(name, e => { let data; try { data = JSON.parse(e.data); } catch { return; } this.emit(name, data); });
  }
};
