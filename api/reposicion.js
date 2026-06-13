// Config de reposición (mínimos por categoría + productos apagados) — compartida en KV, por marca.
// La edita Administración o admins → se valida que sea un USUARIO válido (no solo admin).
// GET  ?store=bdi|zattia                  → { ok, config: {mins, apagados, defaultMin} }
// POST {store, config, user, pass}        → guarda (cualquier usuario válido)
const KV_URL   = process.env.KV_REST_API_URL   || process.env.STORAGE_KV_REST_API_URL;
const KV_TOKEN = process.env.KV_REST_API_TOKEN || process.env.STORAGE_KV_REST_API_TOKEN;
const BOOTSTRAP = { 'Bruno Arevalo': 'BDI123456', 'Dario Arevalo': 'BDI123456' };
const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};
async function kvCmd(cmd) {
  const r = await fetch(KV_URL, { method: 'POST', headers: { Authorization: `Bearer ${KV_TOKEN}`, 'Content-Type': 'application/json' }, body: JSON.stringify(cmd) });
  const d = await r.json();
  return d.result;
}
const keyFor = b => `reposicion:${b === 'zattia' ? 'zattia' : 'bdi'}`;
function usuarioValido(cfg, user, pass) {
  if (cfg && Array.isArray(cfg.users)) return cfg.users.some(u => u.name === user && u.pass === pass);
  return BOOTSTRAP[user] && BOOTSTRAP[user] === pass;
}

module.exports = async (req, res) => {
  Object.entries(CORS).forEach(([k, v]) => res.setHeader(k, v));
  res.setHeader('Cache-Control', 'no-store');
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (!KV_URL || !KV_TOKEN) return res.status(500).json({ error: 'KV no configurado' });

  try {
    const store = (req.query?.store || 'bdi').toLowerCase();
    if (req.method === 'GET') {
      const raw = await kvCmd(['GET', keyFor(store)]);
      return res.status(200).json({ ok: true, config: raw ? JSON.parse(raw) : { mins: {}, apagados: [], defaultMin: 4 } });
    }
    if (req.method === 'POST') {
      const { config, user, pass } = req.body || {};
      if (!config || typeof config !== 'object') return res.status(400).json({ error: 'config inválida' });
      const cfgU = JSON.parse((await kvCmd(['GET', 'cfg:usuarios'])) || 'null');
      if (!usuarioValido(cfgU, user, pass)) return res.status(403).json({ error: 'Necesitás estar logueado para guardar.' });
      await kvCmd(['SET', keyFor(store), JSON.stringify(config)]);
      return res.status(200).json({ ok: true });
    }
    return res.status(405).json({ error: 'método no permitido' });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
};
