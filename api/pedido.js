const KV_URL = process.env.KV_REST_API_URL || process.env.STORAGE_KV_REST_API_URL;
const KV_TOKEN = process.env.KV_REST_API_TOKEN || process.env.STORAGE_KV_REST_API_TOKEN;
const GN_BASE = 'https://www.gestionnube.com/api/v1';

const TTL_SECONDS = 90 * 24 * 60 * 60; // 90 días: pasado ese plazo el link se borra solo.

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

// Normaliza el id para que la clave en KV sea siempre segura.
function clave(id) {
  return 'pedido:' + String(id).replace(/[^a-zA-Z0-9_-]/g, '');
}

async function kvCmd(cmd) {
  const r = await fetch(KV_URL, {
    method: 'POST',
    headers: { Authorization: `Bearer ${KV_TOKEN}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(cmd),
  });
  return r.json();
}

// Lee de Gestión Nube (mismo token que api/proxy). Devuelve null si falla.
async function gnGet(path) {
  const token = process.env.GESTIONNUBE_TOKEN;
  if (!token) return null;
  try {
    const r = await fetch(GN_BASE + path, {
      headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' },
    });
    if (!r.ok) return null;
    return await r.json();
  } catch (e) { return null; }
}

// Relee la venta desde GN y devuelve el pedido actualizado (o null si no se pudo).
// Conserva los datos del cliente del snapshot (GN no los guarda igual) y reusa
// la foto de cada ítem por (nombre|variante). El N° del pedido = number de GN;
// el endpoint /ventas/<id> usa el id INTERNO, así que primero lo buscamos por número.
async function refrescarDesdeGN(numero, snap) {
  let gnId = snap && snap.gnId;
  if (!gnId) {
    const busq = await gnGet('/ventas?q=' + encodeURIComponent(numero));
    const lista = (busq && busq.data) || [];
    const match = lista.find(v => String(v.number) === String(numero));
    if (!match) return null;
    gnId = match.id;
  }
  const venta = await gnGet('/ventas/' + gnId);
  if (!venta || !Array.isArray(venta.items)) return null;

  // Foto previa por (nombre|variante) para no perder las miniaturas.
  const imgPrev = {};
  ((snap && snap.items) || []).forEach(i => { imgPrev[(i.nombre || '') + '|' + (i.variante || '')] = i.img || ''; });

  const items = venta.items.map(it => {
    const nombre = it.product_name || (it.product && it.product.name) || '';
    const variante = it.size || (it.size_info && it.size_info.name) || '';
    return {
      nombre,
      variante,
      cantidad: it.quantity || 0,
      precio: it.unit_price || 0,
      img: imgPrev[nombre + '|' + variante] || '',
    };
  });
  const total = items.reduce((s, i) => s + (i.precio || 0) * (i.cantidad || 0), 0);

  // Merge: mantiene cliente/telefono/pago/entrega/obs/cupon del snapshot; refresca items y total.
  const cupon = snap && snap.cupon ? snap.cupon : null;
  return Object.assign({}, snap, {
    gnId,
    items,
    total,
    subtotal: cupon ? (snap.subtotal != null ? snap.subtotal : total) : total,
    actualizado: new Date().toISOString(),
  });
}

module.exports = async (req, res) => {
  Object.entries(CORS).forEach(([k, v]) => res.setHeader(k, v));
  if (req.method === 'OPTIONS') return res.status(204).end();

  if (!KV_URL || !KV_TOKEN) return res.status(500).json({ error: 'Almacenamiento no configurado' });

  try {
    // Leer un pedido para mostrarlo en la página /pedido/<id>
    if (req.method === 'GET') {
      const id = req.query.id;
      if (!id) return res.status(400).json({ error: 'Falta el número de pedido' });
      const d = await kvCmd(['GET', clave(id)]);
      if (!d || !d.result) return res.status(404).json({ error: 'Pedido no encontrado o vencido' });
      const pedido = JSON.parse(d.result);

      // ?refresh=1 → relee los renglones actuales desde Gestión Nube y actualiza
      // la foto guardada. Si GN falla, devuelve el snapshot tal cual (no rompe).
      if (req.query.refresh) {
        try {
          const fresco = await refrescarDesdeGN(id, pedido);
          if (fresco) {
            await kvCmd(['SET', clave(id), JSON.stringify(fresco), 'EX', String(TTL_SECONDS)]);
            return res.json(fresco);
          }
        } catch (e) { /* cae al snapshot */ }
      }
      return res.json(pedido);
    }

    // Guardar un pedido cuando el cliente confirma
    if (req.method === 'POST') {
      const pedido = req.body || {};
      if (!pedido.id) return res.status(400).json({ error: 'Falta el número de pedido' });
      await kvCmd(['SET', clave(pedido.id), JSON.stringify(pedido), 'EX', String(TTL_SECONDS)]);
      return res.json({ ok: true });
    }

    return res.status(405).end();
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
};
