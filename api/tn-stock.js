// Escritura de stock por variante en Tienda Nube (sync GN→TN de Stunned).
// POST { store, updates: [{ product_id, variant_id, stock }] }  → setea el stock ABSOLUTO de cada
//   variante (PUT a la variante). Devuelve cuántas aplicó y el detalle de errores.
//
// Es el brazo de ESCRITURA del sync: GN es la fuente de verdad y acá se pisa el stock de TN con el
// valor absoluto que manda el monitor. Idempotente por naturaleza (setear el mismo número no cambia
// nada). El monitor decide qué escribir (dry-run + validación del mapeo); este endpoint solo aplica.
//
// Sin auth propia, igual que el resto de los endpoints de escritura de bdi-catalogo (tn-categorias).

const STORES = {
  bdi:     { storeId: process.env.TIENDANUBE_STORE_ID,          token: process.env.TIENDANUBE_TOKEN },
  zattia:  { storeId: process.env.TIENDANUBE_STORE_ID_ZATTIA,   token: process.env.TIENDANUBE_TOKEN_ZATTIA },
  stunned: { storeId: process.env.TIENDANUBE_STORE_ID_STUNNED || '7516263', token: process.env.TIENDANUBE_TOKEN_STUNNED },
};

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

function tnHeaders(token) {
  return {
    'Authentication': `bearer ${token}`,
    'User-Agent': 'Monitor Areben (brunoarevalo@arebensrl.com)',
    'Content-Type': 'application/json',
  };
}

module.exports = async (req, res) => {
  Object.entries(CORS).forEach(([k, v]) => res.setHeader(k, v));
  res.setHeader('Cache-Control', 'no-store');
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Usá POST.' });

  const storeKey = String((req.body && req.body.store) || '').toLowerCase();
  const cfg = STORES[storeKey];
  if (!cfg || !cfg.storeId || !cfg.token) return res.status(500).json({ error: `TiendaNube no configurado para ${storeKey}` });

  const updates = Array.isArray(req.body && req.body.updates) ? req.body.updates : [];
  if (!updates.length) return res.status(400).json({ error: 'Faltan updates [{product_id, variant_id, stock}].' });
  if (updates.length > 500) return res.status(400).json({ error: 'Demasiados updates en una sola llamada (máx 500).' });

  let aplicados = 0;
  const errores = [];
  for (const u of updates) {
    const pid = u && u.product_id;
    const vid = u && u.variant_id;
    const stock = u && u.stock;
    if (pid == null || vid == null || stock == null || !Number.isFinite(Number(stock))) {
      errores.push({ product_id: pid, variant_id: vid, error: 'update inválido (falta product_id/variant_id/stock)' });
      continue;
    }
    try {
      const r = await fetch(`https://api.tiendanube.com/v1/${cfg.storeId}/products/${pid}/variants/${vid}`, {
        method: 'PUT',
        headers: tnHeaders(cfg.token),
        body: JSON.stringify({ stock: Math.trunc(Number(stock)) }),
      });
      if (r.ok) aplicados++;
      else {
        const t = await r.text();
        errores.push({ product_id: pid, variant_id: vid, status: r.status, msg: t.slice(0, 150) });
      }
    } catch (e) {
      errores.push({ product_id: pid, variant_id: vid, error: e.message });
    }
  }

  return res.status(200).json({ ok: true, store: storeKey, total: updates.length, aplicados, errores });
};
