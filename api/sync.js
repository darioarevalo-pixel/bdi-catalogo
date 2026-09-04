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
const { exigirUsuario } = require('./_auth');

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  // `x-monitor-auth` es el sobre con la credencial del Monitor. Sin declararlo acá, el preflight
  // del navegador lo rechaza y la llamada no llega nunca (son pedidos cross-origin).
  'Access-Control-Allow-Headers': 'Content-Type, x-monitor-auth',
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

  // Portero: este endpoint dispara workflows de GitHub con un token de la empresa. No rompe
  // datos, pero abierto se lo puede pedir a repetición hasta saturar.
  if (!(await exigirUsuario(req, res, 'sync'))) return;

  // GET → estado del último run del workflow PARA ESA MARCA (para que el monitor sepa cuándo terminó).
  //
  // 🔑 **`store` no se puede ignorar acá.** Esto pedía `per_page=1` y devolvía el último run del
  // workflow fuera de la marca que fuera, mientras el POST sí despachaba con la marca. Los dos
  // syncs corren el MISMO workflow con distinto input, así que un sync de Zattia le contestaba
  // «terminó» a quien estaba esperando BDI, y el monitor daba por bueno un stock que nadie trajo.
  //
  // 🔑 **La marca se lee del título del run, porque la API no devuelve los `inputs`.** Por eso los
  // workflows llevan `run-name: … — ${{ inputs.store }}`. Se piden 20 runs porque los dos stores se
  // intercalan y el candado `gestion-nube` los encola: el último de BDI puede estar varios atrás.
  //
  // 📌 Si ninguno trae marca en el título, se cae al más reciente — son los runs viejos, de antes
  // del `run-name`. Es el comportamiento de siempre y se apaga solo a medida que corren los nuevos.
  if (req.method === 'GET') {
    try {
      const WORKFLOW = resolverWorkflow(req.query && req.query.kind);
      const store = ((req.query && req.query.store) || 'bdi').toLowerCase() === 'zattia' ? 'zattia' : 'bdi';
      const r = await fetch(`https://api.github.com/repos/${REPO}/actions/workflows/${WORKFLOW}/runs?per_page=20`, { headers: ghHeaders() });
      const d = await r.json();
      const runs = d.workflow_runs || [];
      const marcaDe = run => {
        const m = /—\s*(bdi|zattia)\s*$/i.exec(String(run.display_title || run.name || ''));
        return m ? m[1].toLowerCase() : null;
      };
      const conMarca = runs.filter(run => marcaDe(run) !== null);
      const run = (conMarca.length ? conMarca.find(x => marcaDe(x) === store) : runs[0]) || null;
      return res.status(200).json({ ok: true, store, run: run ? { id: run.id, status: run.status, conclusion: run.conclusion, created_at: run.created_at } : null });
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
