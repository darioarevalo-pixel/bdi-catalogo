const crypto = require('crypto');

const KV_URL = process.env.KV_REST_API_URL || process.env.STORAGE_KV_REST_API_URL;
const KV_TOKEN = process.env.KV_REST_API_TOKEN || process.env.STORAGE_KV_REST_API_TOKEN;
const GN_BASE = 'https://www.gestionnube.com/api/v1';

const TTL_SECONDS = 90 * 24 * 60 * 60; // 90 días: pasado ese plazo el link se borra solo.

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, x-admin-password',
};

// ---------------------------------------------------------------------------
// QUIÉN PUEDE VER UN PEDIDO
//
// Este archivo guarda el detalle de cada pedido mayorista: nombre, teléfono, qué
// compró y cuánto pagó. Hasta el 1-8-2026 no pedía NADA para leerlo, y el
// listado completo se bajaba con una sola consulta: comprobado contra producción,
// `GET /api/pedido?list=1` devolvía 104 pedidos con 94 teléfonos de clientes.
// Y como el número de pedido es el de Gestión Nube (29561, 29580, 29588…), ir de
// uno en uno tampoco costaba nada.
//
// Ahora hay tres puertas distintas, una por uso:
//   · El listado          → contraseña del panel (lo usa solo admin.html).
//   · Un pedido suelto    → la clave que viaja en el link (abajo).
//   · Guardar un pedido   → se puede escribir UNA vez por número; pisarlo pide
//                           la contraseña del panel.
//
// La clave del link se CALCULA a partir del número de pedido y un secreto del
// servidor; no se guarda en ningún lado. Eso tiene dos ventajas: vale igual para
// los pedidos viejos que ya están guardados (no hay que migrar nada), y si el
// almacenamiento se vacía las claves siguen siendo las mismas.
// ---------------------------------------------------------------------------
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || '';

// Cae a ADMIN_PASSWORD para no depender de cargar una variable nueva en Vercel.
// OJO: si algún día se cambia la contraseña del panel, cambian todas las claves
// y los links ya enviados dejan de abrir. Para evitarlo, cargar PEDIDO_SECRET
// (cualquier texto largo al azar) y no tocarla más.
const SECRETO_LINK = process.env.PEDIDO_SECRET || ADMIN_PASSWORD;

// ── La transición, para no romperle el link a nadie ─────────────────────────
//
// Los clientes que ya compraron tienen guardado (y reenviado por WhatsApp) un link
// SIN clave. Si de golpe dejaran de abrir, el lunes serían 96 personas escribiendo
// para preguntar qué pasó con su pedido.
//
// Cómo se distingue un pedido "de antes": los que se guardan A PARTIR de este
// cambio quedan marcados con `conClave`. El que no tiene la marca es de antes, y
// se le permite abrir sin clave. Se hace con una marca y NO comparando fechas
// porque por fecha siempre queda un borde mal: había un pedido hecho el mismo día
// del cambio que se habría roto al instante.
//
// Hasta cuándo dura: los pedidos se borran solos a los 90 días. El más nuevo de
// los "de antes" vence el 30-10-2026, así que el 31 ya no queda ninguno vivo. Por
// eso la puerta se cierra ese día: para entonces no rompe NINGÚN link, porque no
// queda ninguno que abrir. Se cierra sola, no hay que acordarse de apagar nada.
const FIN_TRANSICION = Date.parse('2026-10-31T00:00:00Z');

function esAdmin(req) {
  return !!ADMIN_PASSWORD && req.headers['x-admin-password'] === ADMIN_PASSWORD;
}

/** La clave del link de un pedido, o null si el servidor no tiene secreto cargado. */
function claveDe(id) {
  if (!SECRETO_LINK) return null;
  return crypto.createHmac('sha256', SECRETO_LINK).update('pedido:' + String(id)).digest('hex').slice(0, 12);
}

/** Comparación en tiempo constante: no le cuenta al de afuera cuántos caracteres acertó. */
function claveOk(id, k) {
  const esperada = claveDe(id);
  if (!esperada || !k) return false;
  const a = Buffer.from(String(k)), b = Buffer.from(esperada);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

/** ¿Es un pedido de los de antes del cambio (sin la marca), y la ventana sigue abierta? */
function esLinkViejoTolerado(pedido) {
  if (Date.now() >= FIN_TRANSICION) return false;
  return !(pedido && pedido.conClave);
}

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
      // Esta es la consulta que entregaba la nómina entera de clientes. Solo el panel.
      if (!esAdmin(req)) return res.status(401).json({ error: 'Necesitás la contraseña del panel.' });
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
          const idPedido = p.id != null ? p.id : chunk[j].replace(/^pedido:/, '');
          pedidos.push({
            id: idPedido,
            // La clave del link, para que el botón "Ver" del panel abra y para poder
            // reenviarle el link a un cliente que lo perdió.
            k: claveDe(idPedido),
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

      // La clave del link. Se contesta 404 —y no 401— a propósito: sin clave, el
      // de afuera no puede distinguir "existe pero no tenés la clave" de "no
      // existe", así que barrer números no le dice nada.
      if (!esAdmin(req) && !claveOk(id, req.query.k) && !esLinkViejoTolerado(pedido)) {
        return res.status(404).json({ error: 'Pedido no encontrado o vencido' });
      }

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

    // Guardar un pedido cuando el cliente confirma.
    //
    // Lo llama el navegador del cliente justo después de crear la venta, así que no
    // puede pedir contraseña. Los frenos son otros: se escribe UNA sola vez por
    // número (pisar uno ya guardado pide la contraseña del panel) y el detalle tiene
    // un tamaño máximo. Sin esto, cualquiera podía reescribir el pedido de otro o
    // llenar el almacenamiento con basura.
    if (req.method === 'POST') {
      const pedido = req.body || {};
      if (!pedido.id) return res.status(400).json({ error: 'Falta el número de pedido' });
      if (Array.isArray(pedido.items) && pedido.items.length > 500) {
        return res.status(400).json({ error: 'El pedido tiene demasiados renglones' });
      }
      // La marca que separa "de antes" de "de ahora". El link que se le entrega a
      // este cliente YA lleva la clave, así que a este pedido sí se le puede exigir.
      pedido.conClave = true;
      const cuerpo = JSON.stringify(pedido);
      if (cuerpo.length > 400_000) return res.status(400).json({ error: 'El detalle del pedido es demasiado grande' });

      // NX = "solo si todavía no existe". El panel sí puede pisar: cuando carga un
      // pedido a mano, a veces lo vuelve a guardar corregido.
      // El orden NX antes de EX es el que ya usa el turno del proxy contra este
      // mismo almacenamiento, así que se sabe que lo acepta.
      const cmd = esAdmin(req)
        ? ['SET', clave(pedido.id), cuerpo, 'EX', String(TTL_SECONDS)]
        : ['SET', clave(pedido.id), cuerpo, 'NX', 'EX', String(TTL_SECONDS)];
      const r = await kvCmd(cmd);
      if (!esAdmin(req) && r && r.result === null) {
        return res.status(409).json({ error: 'Ese número de pedido ya estaba guardado' });
      }
      // La clave viaja de vuelta para que quien confirmó pueda armar el link.
      return res.json({ ok: true, k: claveDe(pedido.id) });
    }

    return res.status(405).end();
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
};
