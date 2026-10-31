const { db } = require('./db');
const { createHash } = require('crypto');

const OPERATION = 'POST:/incidents';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    return `{${Object.keys(value).sort().map(key =>
      `${JSON.stringify(key)}:${canonicalJson(value[key])}`
    ).join(',')}}`;
  }
  return JSON.stringify(value);
}

function hashRequest(body) {
  return createHash('sha256').update(canonicalJson(body)).digest('hex');
}

async function createIncident(req, res) {
  const key = req.get('Idempotency-Key');
  if (!key || !key.trim() || key.length > 255) {
    return res.status(400).json({ error: 'invalid_idempotency_key' });
  }

  const body = req.body;
  if (!body || Array.isArray(body) || typeof body.title !== 'string' ||
      !body.title.trim() || !['P1', 'P2', 'P3', 'P4'].includes(body.severity) ||
      typeof body.serviceId !== 'string' || !UUID.test(body.serviceId)) {
    return res.status(400).json({ error: 'invalid_incident' });
  }

  const tenantId = req.user.tenantId;
  const requestHash = hashRequest(body);
  const scope = [tenantId, OPERATION, key];
  const result = await db.tx(async transaction => {
    // A conflicting insert waits for the owner to commit before checking expiry.
    const claimed = await transaction.oneOrNone(
      `INSERT INTO idempotency_keys
         (tenant_id, operation, key, request_hash, state, expires_at)
       VALUES ($1, $2, $3, $4, 'processing', now() + interval '24 hours')
       ON CONFLICT (tenant_id, operation, key) DO UPDATE
         SET request_hash = EXCLUDED.request_hash, state = 'processing',
             status_code = NULL, response_body = NULL,
             created_at = now(), expires_at = EXCLUDED.expires_at
         WHERE idempotency_keys.expires_at <= now()
       RETURNING key`,
      [...scope, requestHash]
    );

    if (!claimed) {
      const existing = await transaction.one(
        `SELECT request_hash, state, status_code, response_body
         FROM idempotency_keys WHERE tenant_id = $1 AND operation = $2 AND key = $3`,
        scope
      );
      if (existing.request_hash !== requestHash) {
        return { status: 409, body: { error: 'idempotency_key_conflict' } };
      }
      if (existing.state === 'processing') {
        return { status: 409, body: { error: 'operation_in_progress' } };
      }
      if (existing.state === 'failed') {
        return { status: 409, body: { error: 'prior_operation_failed' } };
      }
      return { status: existing.status_code, body: existing.response_body, replayed: true };
    }

    const incident = await transaction.one(
      `INSERT INTO incidents (tenant_id, service_id, title, severity)
       VALUES ($1, $2, $3, $4) RETURNING *`,
      [tenantId, body.serviceId, body.title, body.severity]
    );
    await transaction.none(
      `INSERT INTO paging_jobs (tenant_id, incident_id, payload)
       VALUES ($1, $2, $3::jsonb)`,
      [tenantId, incident.id, JSON.stringify({ incidentId: incident.id, severity: incident.severity })]
    );

    // Store the same JSON representation that the first client receives.
    const responseBody = JSON.parse(JSON.stringify(incident));
    await transaction.none(
      `UPDATE idempotency_keys
       SET state = 'completed', status_code = 201, response_body = $4::jsonb
       WHERE tenant_id = $1 AND operation = $2 AND key = $3`,
      [...scope, JSON.stringify(responseBody)]
    );
    return { status: 201, body: responseBody };
  });

  if (result.replayed) res.set('Idempotent-Replayed', 'true');
  return res.status(result.status).json(result.body);
}

module.exports = { createIncident, hashRequest };
