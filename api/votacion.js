// Votación online de diseños (usa el KV existente). Sin login: cualquiera con el link vota.
// POST {action:'crear', title, designs:[{id,name}]}      → crea la ronda, devuelve {id}
// POST {action:'img', id, designId, image(dataURL)}        → guarda una imagen (de a una, evita límite de body)
// POST {action:'votar', id, voterId, name, votes:{did:'up'|'down'}} → guarda el voto de una persona
// GET  ?id=...            → meta + ballots (resultados, sin imágenes) — para el monitor
// GET  ?id=...&full=1     → además las imágenes — para la página de votación
const KV_URL   = process.env.KV_REST_API_URL   || process.env.STORAGE_KV_REST_API_URL;
const KV_TOKEN = process.env.KV_REST_API_TOKEN || process.env.STORAGE_KV_REST_API_TOKEN;
const TTL = 60 * 60 * 24 * 90; // 90 días

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

async function kvCmd(cmd) {
  const r = await fetch(KV_URL, {
    method: 'POST',
    headers: { Authorization: `Bearer ${KV_TOKEN}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(cmd),
  });
  const d = await r.json();
  return d.result;
}
const kvGet = (key) => kvCmd(['GET', key]);
const kvSet = (key, val) => kvCmd(['SET', key, val, 'EX', TTL]);

function nuevoId() {
  const s = 'abcdefghijkmnpqrstuvwxyz23456789';
  let out = '';
  for (let i = 0; i < 7; i++) out += s[Math.floor(Math.random() * s.length)];
  return out;
}

module.exports = async (req, res) => {
  Object.entries(CORS).forEach(([k, v]) => res.setHeader(k, v));
  res.setHeader('Cache-Control', 'no-store');
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (!KV_URL || !KV_TOKEN) return res.status(500).json({ error: 'KV no configurado' });

  try {
    if (req.method === 'POST') {
      const body = req.body || {};
      const action = body.action;

      if (action === 'crear') {
        const id = nuevoId();
        const designs = (body.designs || []).map(d => ({ id: String(d.id), name: d.name || '' }));
        await kvSet(`vot:${id}:meta`, JSON.stringify({ id, title: body.title || '', createdAt: Date.now(), designs }));
        return res.status(200).json({ ok: true, id });
      }

      if (action === 'img') {
        const { id, designId, image } = body;
        if (!id || !designId || !image) return res.status(400).json({ error: 'faltan datos' });
        await kvSet(`vot:${id}:img:${designId}`, String(image));
        return res.status(200).json({ ok: true });
      }

      if (action === 'votar') {
        const { id, voterId, name, votes } = body;
        if (!id || !voterId) return res.status(400).json({ error: 'faltan id o voterId' });
        const meta = await kvGet(`vot:${id}:meta`);
        if (!meta) return res.status(404).json({ error: 'ronda no encontrada' });
        await kvSet(`vot:${id}:ballot:${voterId}`, JSON.stringify({ voterId: String(voterId), name: name || 'Anónimo', ts: Date.now(), votes: votes || {} }));
        await kvCmd(['SADD', `vot:${id}:voters`, String(voterId)]);
        await kvCmd(['EXPIRE', `vot:${id}:voters`, TTL]);
        return res.status(200).json({ ok: true });
      }

      return res.status(400).json({ error: 'acción desconocida' });
    }

    if (req.method === 'GET') {
      const id = req.query?.id;
      if (!id) return res.status(400).json({ error: 'falta id' });
      const meta = await kvGet(`vot:${id}:meta`);
      if (!meta) return res.status(404).json({ error: 'ronda no encontrada' });
      const metaObj = JSON.parse(meta);

      // Resultados: leer todos los votos
      const voterIds = (await kvCmd(['SMEMBERS', `vot:${id}:voters`])) || [];
      let ballots = [];
      if (voterIds.length) {
        const keys = voterIds.map(v => `vot:${id}:ballot:${v}`);
        const vals = await kvCmd(['MGET', ...keys]);
        ballots = (vals || []).filter(Boolean).map(v => { try { return JSON.parse(v); } catch { return null; } }).filter(Boolean);
      }

      let images = null;
      if (req.query.full === '1') {
        images = {};
        await Promise.all(metaObj.designs.map(async d => {
          const img = await kvGet(`vot:${id}:img:${d.id}`);
          if (img) images[d.id] = img;
        }));
      }
      return res.status(200).json({ ok: true, meta: metaObj, ballots, images });
    }

    return res.status(405).json({ error: 'método no permitido' });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
};
