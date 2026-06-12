// Dispara el sync rápido de inventario (GitHub Actions) desde el monitor.
// POST {store: 'bdi'|'zattia'} → ejecuta el workflow sync-inventario.yml con ese input.
// Usa GH_SYNC_TOKEN (token clásico con scope repo+workflow) guardado en el entorno.
const REPO = 'darioarevalo-pixel/monitor-areben';
const WORKFLOW = 'sync-inventario.yml';
const TOKEN = process.env.GH_SYNC_TOKEN;
const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

module.exports = async (req, res) => {
  Object.entries(CORS).forEach(([k, v]) => res.setHeader(k, v));
  res.setHeader('Cache-Control', 'no-store');
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'método no permitido' });
  if (!TOKEN) return res.status(500).json({ error: 'Falta GH_SYNC_TOKEN en el entorno' });

  const store = ((req.body && req.body.store) || 'bdi').toLowerCase() === 'zattia' ? 'zattia' : 'bdi';
  try {
    const r = await fetch(`https://api.github.com/repos/${REPO}/actions/workflows/${WORKFLOW}/dispatches`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${TOKEN}`,
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
        'User-Agent': 'Monitor Areben',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ ref: 'main', inputs: { store } }),
    });
    if (r.status === 204) return res.status(200).json({ ok: true, store });
    const txt = await r.text();
    return res.status(r.status).json({ error: 'GitHub respondió ' + r.status, detalle: txt.slice(0, 200) });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
};
