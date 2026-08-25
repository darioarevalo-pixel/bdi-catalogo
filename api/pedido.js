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

// ---------------------------------------------------------------------------
// LOS FALTANTES (qué se le cayó del carrito por stock)
//
// El catálogo verifica el stock recién al confirmar. Lo que no alcanza se le
// borra del carrito al cliente y hasta ahora moría ahí: el pedido que llegaba
// no tenía ninguna marca de que había pedido más. Ahora el navegador manda esa
// lista pegada al pedido, y el panel la muestra.
//
// Dos recaudos, porque este POST no pide contraseña (lo hace el navegador del
// cliente): se recorta a lo que se va a mostrar y nada más —campo por campo, sin
// copiar el objeto entero— y se le pone un tope de renglones. Y no se le
// devuelve a quien abre el pedido con el link: es información nuestra, no del
// cliente, y en la página del pedido no pinta nada.
// ---------------------------------------------------------------------------
const MAX_FALTANTES = 100;

function limpiarFaltantes(lista) {
  if (!Array.isArray(lista)) return [];
  const texto = (v, max) => String(v == null ? '' : v).slice(0, max);
  const entero = (v) => {
    const n = Math.round(Number(v));
    return Number.isFinite(n) && n >= 0 ? Math.min(n, 999999) : 0;
  };
  return lista.slice(0, MAX_FALTANTES).map(f => ({
    nombre: texto(f && f.nombre, 200),
    variante: texto(f && f.variante, 120),
    pedido: entero(f && f.pedido),
    disponible: entero(f && f.disponible),
    motivo: texto(f && f.motivo, 40),
  })).filter(f => f.nombre || f.variante);
}

/** El pedido tal como se le puede mostrar al cliente: sin los faltantes. */
function sinFaltantes(pedido) {
  if (!pedido || !pedido.faltantes) return pedido;
  const copia = Object.assign({}, pedido);
  delete copia.faltantes;
  return copia;
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

// ---------------------------------------------------------------------------
// LA FOTO DE UN PRODUCTO QUE SE AGREGÓ DESPUÉS
//
// El link del pedido se puede reusar: se agregan renglones a la venta en Gestión
// Nube y al abrirlo con ?refresh=1 aparecen. Pero salían SIN FOTO, porque la
// única fuente de fotos era el pedido guardado —lo que el cliente había puesto
// en el carrito— y un producto que nunca estuvo en ese carrito no figuraba.
//
// Ahora se busca en tres escalones, del más barato al más caro:
//   1. Por producto + variante, como antes (el mismo renglón de siempre).
//   2. Por producto solo: si le agregaron OTRO color de algo que ya estaba,
//      sirve la misma foto y no cuesta una consulta.
//   3. Recién ahí se le pregunta a Gestión Nube, de a uno.
//
// El escalón 3 tiene freno doble —tope de productos y reloj— porque esta función
// corre con 10 segundos de techo (vercel.json) y Gestión Nube corta si se le va
// muy rápido. Lo que se trae queda GUARDADO en el pedido, así que el costo se
// paga una sola vez por producto: si en un refresco quedan fotos afuera, el
// siguiente las completa sin repetir las que ya tiene.
// ---------------------------------------------------------------------------
const MAX_PAGINAS_CATALOGO = 5;    // el catálogo son 2 páginas; 5 es un tope de seguridad
const PRESUPUESTO_FOTOS_MS = 5000; // reloj: esta función tiene 10 s de techo (vercel.json)

/** La primera foto utilizable de un producto de GN, mire donde mire la API. */
function imagenDeProductoGN(p) {
  if (!p) return '';
  const directa = p.image_url || p.imagen_url || p.imagen || p.image || p.photo || p.foto;
  if (typeof directa === 'string' && directa) return directa;
  for (const lista of [p.images, p.imagenes, p.fotos]) {
    if (!Array.isArray(lista) || !lista.length) continue;
    const f = lista[0];
    const url = typeof f === 'string' ? f : (f && (f.url || f.src || f.path || f.ruta));
    if (url) return String(url);
  }
  return '';
}

/**
 * Las fotos salen de LA MISMA COPIA DEL CATÁLOGO que mira el cliente.
 *
 * La primera versión de esto le preguntaba a Gestión Nube producto por producto
 * (`/productos/ver/<id>`) y no traía ninguna foto. Medido contra producción el
 * 25-ago-2026, la puerta que sí las trae es la del catálogo:
 *
 *     GET /productos/obtener?...&include_images=1
 *       → 263 productos, 218 con `image_url` (83%)
 *       → 2.915 variantes, 1.019 con foto propia por color
 *
 * Y va por nuestro propio `/api/proxy`, no derecho a Gestión Nube, por una razón
 * concreta: esa URL —la misma, carácter por carácter, que pide el catálogo— está
 * guardada en el CDN y la mantiene caliente un robot cada 5 minutos. O sea que
 * buscar fotos sale GRATIS de cupo, que es el recurso escaso acá (60 consultas
 * por minuto para toda la cuenta). De paso desaparece el tope de "6 productos
 * por vez": en dos páginas viene el catálogo entero.
 */
async function fotosDelCatalogo(host, pids) {
  const buscados = new Set(pids.map(String));
  const porPid = {}, porVariante = {};
  if (!host || !buscados.size) return { porPid, porVariante };

  const hasta = Date.now() + PRESUPUESTO_FOTOS_MS;
  // Idéntica a la de index.html y a la del robot de warming: si un solo
  // parámetro cambia, es OTRA copia y el CDN no la tiene.
  const qs = 'per_page=200&include_stock=1&include_images=1&include_variants=1';
  let ultima = MAX_PAGINAS_CATALOGO;

  for (let page = 1; page <= Math.min(ultima, MAX_PAGINAS_CATALOGO); page++) {
    if (Date.now() > hasta) break;
    let data;
    try {
      const r = await fetch(`https://${host}/api/proxy?_path=` +
        encodeURIComponent('/productos/obtener') + `&${qs}&page=${page}`);
      if (!r.ok) break;
      data = await r.json();
    } catch (e) { break; }

    const meta = data && data.meta;
    if (page === 1 && meta) {
      const n = parseInt(meta.last_page || meta.total_pages, 10);
      if (n > 0) ultima = n;
    }
    const lista = Array.isArray(data) ? data : ((data && data.data) || []);
    for (const prod of lista) {
      const pid = String(prod.id);
      if (!buscados.has(pid)) continue;
      const foto = imagenDeProductoGN(prod);
      if (foto) porPid[pid] = foto;
      // La foto del color exacto, cuando la hay: es mejor que la del producto.
      for (const v of (prod.variantes || [])) {
        if (v && v.image_url) porVariante[pid + '|' + v.size_id] = v.image_url;
      }
    }
    // Si ya se encontraron todos, no se bajan las páginas que faltan.
    if (buscados.size === Object.keys(porPid).length) break;
  }
  return { porPid, porVariante };
}

// Relee la venta desde GN y devuelve el pedido actualizado (o null si no se pudo).
// Conserva los datos del cliente del snapshot (GN no los guarda igual) y reusa
// la foto de cada ítem por (nombre|variante). El N° del pedido = number de GN;
// el endpoint /ventas/<id> usa el id INTERNO, así que primero lo buscamos por número.
async function refrescarDesdeGN(numero, snap, host) {
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

  // Fotos que ya teníamos, indexadas de tres formas: por id de producto (lo más
  // confiable, pero los pedidos viejos no lo guardan), por producto+variante y
  // por producto solo.
  const imgPorPid = {}, imgPrev = {}, imgPorNombre = {};
  ((snap && snap.items) || []).forEach(i => {
    if (!i.img) return;
    if (i.pid) imgPorPid[i.pid] = i.img;
    imgPrev[(i.nombre || '') + '|' + (i.variante || '')] = i.img;
    if (!imgPorNombre[i.nombre || '']) imgPorNombre[i.nombre || ''] = i.img;
  });

  const items = venta.items.map(it => {
    const nombre = it.product_name || (it.product && it.product.name) || '';
    const variante = it.size || (it.size_info && it.size_info.name) || '';
    const pid = it.product_id || (it.product && it.product.id) || null;
    return {
      nombre,
      variante,
      sizeId: it.size_id || (it.size_info && it.size_info.id) || null,
      cantidad: it.quantity || 0,
      precio: it.unit_price || 0,
      // `pid` se guarda para que el próximo refresco cruce por id y no por
      // nombre: si en GN le corrigen el nombre al producto, por nombre se
      // perdía la foto y había que ir a buscarla de nuevo.
      pid,
      img: (pid && imgPorPid[pid]) || imgPrev[nombre + '|' + variante] || imgPorNombre[nombre] || '',
    };
  });

  // Los que quedaron sin foto: se le pregunta a GN, con freno. Se piden una sola
  // vez por producto aunque tenga varios renglones (dos colores del mismo modelo).
  const sinFoto = [...new Set(items.filter(i => !i.img && i.pid).map(i => i.pid))];
  if (sinFoto.length) {
    try {
      const { porPid, porVariante } = await fotosDelCatalogo(host, sinFoto);
      items.forEach(i => {
        if (i.img) return;
        i.img = porVariante[i.pid + '|' + i.sizeId] || porPid[String(i.pid)] || '';
      });
    } catch (e) { /* sin fotos nuevas, pero el pedido se actualiza igual */ }
  }
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
            // Solo el número: alcanza para el aviso del listado. El detalle se
            // pide con ?id= cuando el admin despliega ese pedido.
            nFaltantes: Array.isArray(p.faltantes) ? p.faltantes.length : 0,
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
          const fresco = await refrescarDesdeGN(id, pedido, req.headers['x-forwarded-host'] || req.headers.host);
          if (fresco) {
            await kvCmd(['SET', clave(id), JSON.stringify(fresco), 'EX', String(TTL_SECONDS)]);
            // Marca de "sincronizado ahora" SOLO en la respuesta (no se guarda),
            // para que la página muestre "Actualizado" únicamente si releyó de GN.
            fresco.sincronizado = true;
            return res.json(esAdmin(req) ? fresco : sinFaltantes(fresco));
          }
        } catch (e) { /* cae al snapshot */ }
      }
      return res.json(esAdmin(req) ? pedido : sinFaltantes(pedido));
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
      // Lo manda el navegador sin contraseña: se guarda recortado o no se guarda.
      if (pedido.faltantes) {
        const f = limpiarFaltantes(pedido.faltantes);
        if (f.length) pedido.faltantes = f; else delete pedido.faltantes;
      }
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
