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
  // Sin venta, sin renglones, o venta vacía → NO actualizamos (evita pisar la
  // foto buena con un pedido en blanco si la venta se borró o quedó sin ítems).
  if (!venta || !Array.isArray(venta.items) || venta.items.length === 0) return null;

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
  const subtotal = items.reduce((s, i) => s + (i.precio || 0) * (i.cantidad || 0), 0);
  // Total REAL de GN: respeta descuentos/ajustes cargados a nivel venta (el campo
  // `discount` de GN no baja los renglones, así que sumarlos ignoraría el descuento).
  // Fallback a la suma de renglones si GN no trae total_price.
  const total = (typeof venta.total_price === 'number' && venta.total_price > 0)
    ? Math.round(venta.total_price) : subtotal;

  // Merge: mantiene datos del cliente del snapshot; refresca ítems, subtotal y total.
  // El descuento/ajuste de GN se muestra por la diferencia subtotal - total (cupon: null).
  return Object.assign({}, snap, {
    gnId,
    items,
    subtotal,
    total,
    cupon: null,
    actualizado: new Date().toISOString(),
  });
}

module.exports = async (req, res) => {
  Object.entries(CORS).forEach(([k, v]) => res.setHeader(k, v));
  if (req.method === 'OPTIONS') return res.status(204).end();

  if (!KV_URL || !KV_TOKEN) return res.status(500).json({ error: 'Almacenamiento no configurado' });

  try {
    // Listado para el panel del admin: GET /api/pedido?list=1
    // Devuelve un resumen liviano por pedido (sin los items completos); el detalle
    // se obtiene con GET ?id=<id> o navegando a /pedido/<id>.
    if (req.method === 'GET' && req.query.list) {
      // 1) Juntar las claves pedido:* con SCAN (no bloqueante, a diferencia de KEYS).
      //    Iterar hasta cursor '0'; tope de 20 vueltas por seguridad.
      const keys = [];
      let cursor = '0';
      for (let i = 0; i < 20; i++) {
        const s = await kvCmd(['SCAN', cursor, 'MATCH', 'pedido:*', 'COUNT', '200']);
        const r = s && s.result;
        if (!Array.isArray(r)) break;
        cursor = String(r[0]);
        if (Array.isArray(r[1])) keys.push(...r[1]);
        if (cursor === '0') break;
      }
      if (!keys.length) return res.json({ pedidos: [] });

      // 2) Traer los snapshots en bloque (chunks de 100 para no armar un body enorme).
      const pedidos = [];
      for (let i = 0; i < keys.length; i += 100) {
        const chunk = keys.slice(i, i + 100);
        const m = await kvCmd(['MGET', ...chunk]);
        const vals = (m && m.result) || [];
        vals.forEach((v, j) => {
          if (!v) return; // vencido por TTL entre el SCAN y el MGET
          let p;
          try { p = JSON.parse(v); } catch (e) { return; }
          pedidos.push({
            id: p.id != null ? p.id : chunk[j].replace(/^pedido:/, ''),
            fecha: p.fecha || null,
            cliente: p.cliente || '',
            telefono: p.telefono || '',
            pago: p.pago || '',
            entrega: p.entrega || '',
            total: p.total || 0,
            subtotal: p.subtotal || 0,
            nItems: Array.isArray(p.items) ? p.items.length : 0,
          });
        });
      }

      // 3) Más nuevos primero (fecha ISO → orden lexicográfico sirve).
      pedidos.sort((a, b) => String(b.fecha || '').localeCompare(String(a.fecha || '')));
      return res.json({ pedidos });
    }

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
            // Marca de "sincronizado ahora" SOLO en la respuesta (no se guarda),
            // para que la página muestre "Actualizado" únicamente si releyó de GN.
            fresco.sincronizado = true;
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
