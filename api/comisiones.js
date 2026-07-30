// Configuración de comisiones/márgenes (impuestos + matriz por canal/forma) — compartida en KV, por marca.
// GET  ?store=bdi|zattia            → { ok, config }  (null si nunca se guardó)
// POST {store, config, adminUser, adminPass | adminToken} → guarda (solo administradores)
const { esAdmin } = require('./_admin');
const KV_URL   = process.env.KV_REST_API_URL   || process.env.STORAGE_KV_REST_API_URL;
const KV_TOKEN = process.env.KV_REST_API_TOKEN || process.env.STORAGE_KV_REST_API_TOKEN;
// Igual que en tiendanube-audit: el Monitor llama acá con `apiFetch`, que agrega
// `x-monitor-auth`, y sin declararlo el navegador frena el preflight y la llamada nunca sale.
const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, x-monitor-auth',
};
async function kvCmd(cmd) {
  const r = await fetch(KV_URL, { method: 'POST', headers: { Authorization: `Bearer ${KV_TOKEN}`, 'Content-Type': 'application/json' }, body: JSON.stringify(cmd) });
  const d = await r.json();
  return d.result;
}
const keyFor = b => `comisiones:${b === 'zattia' ? 'zattia' : 'bdi'}`;

module.exports = async (req, res) => {
  Object.entries(CORS).forEach(([k, v]) => res.setHeader(k, v));
  res.setHeader('Cache-Control', 'no-store');
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (!KV_URL || !KV_TOKEN) return res.status(500).json({ error: 'KV no configurado' });

  try {
    const store = (req.query?.store || req.body?.store || 'bdi').toLowerCase(); // POST manda store en el body
    if (req.method === 'GET') {
      const raw = await kvCmd(['GET', keyFor(store)]);
      return res.status(200).json({ ok: true, config: raw ? JSON.parse(raw) : null });
    }
    if (req.method === 'POST') {
      const { config } = req.body || {};
      if (!config || typeof config !== 'object') return res.status(400).json({ error: 'config inválida' });
      if (!(await esAdmin(req.body))) return res.status(403).json({ error: 'Necesitás ser administrador para editar comisiones.' });
      await kvCmd(['SET', keyFor(store), JSON.stringify(config)]);
      return res.status(200).json({ ok: true });
    }
    return res.status(405).json({ error: 'método no permitido' });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
};
