// Dispara syncs en GitHub Actions desde el monitor.
// POST {store:'bdi'|'zattia', kind?:'inventario'|'ventas'} → ejecuta el workflow con ese input.
//   kind ausente o 'inventario' → sync-inventario.yml (inventario + productos).
//   kind 'ventas'               → sync-ventas-hoy.yml (ventas recientes).
// GET ?kind=ventas → estado del último run de ese workflow.
// Usa GH_SYNC_TOKEN (token clásico con scope repo+workflow) guardado en el entorno.
const REPO = 'darioarevalo-pixel/monitor-areben';
const WORKFLOWS = { inventario: 'sync-inventario.yml', ventas: 'sync-ventas-hoy.yml' };
const resolverWorkflow = kind => WORKFLOWS[(kind || '').toLowerCase()] || WORKFLOWS.inventario;
const TOKEN = process.env.GH_SYNC_TOKEN;
const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};
const ghHeaders = () => ({
  Authorization: `Bearer ${TOKEN}`,
  Accept: 'application/vnd.github+json',
  'X-GitHub-Api-Version': '2022-11-28',
  'User-Agent': 'Monitor Areben',
  'Content-Type': 'application/json',
});

module.exports = async (req, res) => {
  Object.entries(CORS).forEach(([k, v]) => res.setHeader(k, v));
  res.setHeader('Cache-Control', 'no-store');
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (!TOKEN) return res.status(500).json({ error: 'Falta GH_SYNC_TOKEN en el entorno' });

  // GET → estado del último run del workflow (para que el monitor sepa cuándo terminó).
  if (req.method === 'GET') {
    try {
      const WORKFLOW = resolverWorkflow(req.query && req.query.kind);
      const r = await fetch(`https://api.github.com/repos/${REPO}/actions/workflows/${WORKFLOW}/runs?per_page=1`, { headers: ghHeaders() });
      const d = await r.json();
      const run = (d.workflow_runs && d.workflow_runs[0]) || null;
      return res.status(200).json({ ok: true, run: run ? { id: run.id, status: run.status, conclusion: run.conclusion, created_at: run.created_at } : null });
    } catch (e) { return res.status(500).json({ error: e.message }); }
  }

  if (req.method !== 'POST') return res.status(405).json({ error: 'método no permitido' });

  const store = ((req.body && req.body.store) || 'bdi').toLowerCase() === 'zattia' ? 'zattia' : 'bdi';
  const WORKFLOW = resolverWorkflow(req.body && req.body.kind);
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
