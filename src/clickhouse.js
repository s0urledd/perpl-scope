// Minimal ClickHouse HTTP client (no dependencies). Queries use ClickHouse's
// own typed parameters ({name:Type} placeholders sent as param_name), so no
// value is ever spliced into SQL text. 64-bit integers come back as strings;
// callers convert with BigInt or Number where the magnitude is known.

const DEFAULT_SETTINGS = { output_format_json_quote_64bit_integers: '1', date_time_output_format: 'unix_timestamp' };

export class ClickHouseError extends Error {
  constructor(message, { status = null, code = null } = {}) { super(message); this.name = 'ClickHouseError'; this.status = status; this.code = code; }
}

// Encodes a JS value as a ClickHouse query-parameter literal.
export function paramValue(value) {
  if (value === null || value === undefined) return '\\N';
  if (Array.isArray(value)) return `[${value.map(v => typeof v === 'string' ? `'${v.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'` : String(v)).join(',')}]`;
  if (typeof value === 'boolean') return value ? '1' : '0';
  return String(value);
}

export function createClickHouse({ url = 'http://127.0.0.1:8123', user = 'default', password = '', database = 'perpl', fetcher = fetch, timeoutMs = 60000, log = () => {} } = {}) {
  const base = new URL(url);
  if (!['http:', 'https:'].includes(base.protocol)) throw new Error('INVALID_CLICKHOUSE_URL');
  const stats = { queries: 0, inserts: 0, rowsInserted: 0, errors: 0, ms: 0 };

  async function request(sql, { params = {}, body = null, settings = {}, db = database, timeout = timeoutMs } = {}) {
    const target = new URL(base);
    if (db) target.searchParams.set('database', db);
    for (const [k, v] of Object.entries({ ...DEFAULT_SETTINGS, ...settings })) target.searchParams.set(k, String(v));
    for (const [k, v] of Object.entries(params)) target.searchParams.set(`param_${k}`, paramValue(v));
    let payload = sql;
    if (body !== null) { target.searchParams.set('query', sql); payload = body; }
    const started = performance.now();
    stats.queries++;
    let response;
    try {
      response = await fetcher(target, { method: 'POST', headers: { 'x-clickhouse-user': user, 'x-clickhouse-key': password, 'content-type': 'text/plain; charset=utf-8' }, body: payload, signal: AbortSignal.timeout(timeout) });
    } catch (error) {
      stats.errors++;
      throw new ClickHouseError(`CLICKHOUSE_UNREACHABLE: ${error.name === 'TimeoutError' ? 'timeout' : error.code ?? error.name}`);
    }
    const text = await response.text();
    stats.ms += performance.now() - started;
    if (!response.ok) {
      stats.errors++;
      const code = /Code: (\d+)/.exec(text)?.[1] ?? null;
      throw new ClickHouseError(`CLICKHOUSE_${response.status}: ${text.slice(0, 600).trim()}`, { status: response.status, code: code === null ? null : Number(code) });
    }
    return text;
  }

  // Rows as objects (JSONEachRow).
  async function query(sql, params = {}, settings = {}) {
    const text = await request(`${sql}\nFORMAT JSONEachRow`, { params, settings });
    const rows = [];
    let start = 0;
    while (start < text.length) {
      let end = text.indexOf('\n', start);
      if (end === -1) end = text.length;
      if (end > start) rows.push(JSON.parse(text.slice(start, end)));
      start = end + 1;
    }
    return rows;
  }

  async function first(sql, params = {}, settings = {}) { return (await query(sql, params, settings))[0] ?? null; }

  // Rows as arrays (JSONCompactEachRow): much cheaper to parse for large results.
  async function queryCompact(sql, params = {}, settings = {}) {
    const text = await request(`${sql}\nFORMAT JSONCompactEachRow`, { params, settings });
    return text ? JSON.parse(`[${text.trim().split('\n').join(',')}]`) : [];
  }

  // Statements without a result set (DDL, INSERT ... SELECT, DELETE).
  async function exec(sql, params = {}, settings = {}, { db = database } = {}) { await request(sql, { params, settings, db }); }

  // Rows as JSONEachRow. BigInt values are sent as quoted integers, which
  // ClickHouse parses into the column's integer type without precision loss.
  async function insert(table, rows, { token = null, settings = {} } = {}) {
    if (!rows.length) return 0;
    let body = '';
    for (const row of rows) body += JSON.stringify(row, (_, v) => typeof v === 'bigint' ? v.toString() : v) + '\n';
    const extra = { ...settings };
    if (token) extra.insert_deduplication_token = token;
    await request(`INSERT INTO ${table} FORMAT JSONEachRow`, { body, settings: extra });
    stats.inserts++; stats.rowsInserted += rows.length;
    return rows.length;
  }

  async function ping() { try { await request('SELECT 1', { db: null, timeout: 5000 }); return true; } catch (error) { log('warn', `clickhouse ping failed: ${error.message}`); return false; } }

  return { query, queryCompact, first, exec, insert, ping, request, stats, database };
}

// Tagged helper for readable numeric conversion of quoted 64-bit results.
export const big = v => v === null || v === undefined ? 0n : BigInt(v);
export const int = v => v === null || v === undefined ? 0 : Number(v);
