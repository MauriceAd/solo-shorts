/**
 * Minimal Cloudflare D1 client over the REST query API.
 *
 * POST https://api.cloudflare.com/client/v4/accounts/{accountId}
 *        /d1/database/{databaseId}/query
 *   Authorization: Bearer {apiToken}
 *   Body: { sql, params }
 *
 * Returns { rows, meta } where meta includes last_row_id / changes for writes.
 * One statement per call.
 */
'use strict';

const API_BASE = 'https://api.cloudflare.com/client/v4';

function createD1Client({ accountId, databaseId, apiToken }) {
  const url = `${API_BASE}/accounts/${accountId}/d1/database/${databaseId}/query`;

  async function query(sql, params = []) {
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ sql, params }),
    });
    let body;
    try {
      body = await res.json();
    } catch (e) {
      throw new Error(`D1 request failed: HTTP ${res.status} (unparsable response)`);
    }
    if (!res.ok || !body.success) {
      const detail = (body.errors || []).map((e) => e.message).join('; ') || `HTTP ${res.status}`;
      throw new Error(`D1 query failed: ${detail}`);
    }
    const first = (body.result || [])[0] || {};
    return { rows: first.results || [], meta: first.meta || {} };
  }

  return { query };
}

module.exports = { createD1Client };
