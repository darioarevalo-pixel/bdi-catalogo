const { exigirUsuario } = require('./_auth');

const KV_URL   = process.env.KV_REST_API_URL   || process.env.STORAGE_KV_REST_API_URL;
const KV_TOKEN = process.env.KV_REST_API_TOKEN || process.env.STORAGE_KV_REST_API_TOKEN;
const CACHE_TTL = 3600; // 1 hora en segundos

// Configuración por store. Permite usar ?store=zattia o ?store=bdi (default).
const STORES = {
  bdi: {
    storeId: process.env.TIENDANUBE_STORE_ID,
    token:   process.env.TIENDANUBE_TOKEN,
    gnToken: process.env.GESTIONNUBE_TOKEN || process.env.GN_TOKEN,          // GN BDI (acepta ambos nombres)
    cacheKey:'tiendanube-audit',
  },
  zattia: {
    storeId: process.env.TIENDANUBE_STORE_ID_ZATTIA,
    token:   process.env.TIENDANUBE_TOKEN_ZATTIA,
    gnToken: process.env.GESTIONNUBE_TOKEN_ZATTIA || process.env.GN_TOKEN_ZATTIA,   // GN Zattia (acepta ambos nombres)
    cacheKey:'tiendanube-audit-zattia',
  },
  // STUNNED: tienda TN propia (app 30031, store 7516263). Comparte el GN de ZATTIA. Store ID fijo con fallback a env.
  stunned: {
    storeId: process.env.TIENDANUBE_STORE_ID_STUNNED || '7516263',
    token:   process.env.TIENDANUBE_TOKEN_STUNNED,
    gnToken: process.env.GESTIONNUBE_TOKEN_ZATTIA || process.env.GN_TOKEN_ZATTIA,   // STUNNED vive en el GN de ZATTIA
    cacheKey:'tiendanube-audit-stunned',
  },
};

// `x-monitor-auth` es el header con la credencial de quien está usando el Monitor. Este
// endpoint no la exige —es de lectura—, pero el Monitor la manda igual en TODAS sus llamadas
// (lib/api-fetch.ts), y si no está declarada acá el navegador frena el preflight y la llamada
// nunca sale: "Failed to fetch". Faltaba, y como del lado del Monitor cada consumidor cae a
// una lista vacía, se veía como "no hay nada que revisar" en vez de como un error — nueve
// lugares leyendo de acá (Márgenes, Comisiones, Reposición, Productos, Gerencial, las cards de
// Tienda Nube, Etiquetas, Canjes, Verificación de ventas) mostrando datos incompletos en
// silencio. Los demás endpoints que el Monitor consume ya lo declaraban.
const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, x-monitor-auth',
};

async function kvGet(key) {
  if (!KV_URL || !KV_TOKEN) return null;
  try {
    const r = await fetch(`${KV_URL}/get/${key}`, {
      headers: { Authorization: `Bearer ${KV_TOKEN}` }
    });
    const d = await r.json();
    return d.result ? JSON.parse(d.result) : null;
  } catch { return null; }
}

async function kvSet(key, value) {
  if (!KV_URL || !KV_TOKEN) return;
  try {
    await fetch(KV_URL, {
      method: 'POST',
      headers: { Authorization: `Bearer ${KV_TOKEN}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(['SET', key, JSON.stringify(value), 'EX', CACHE_TTL])
    });
  } catch { /* ignorar error de caché */ }
}

async function kvDel(key) {
  if (!KV_URL || !KV_TOKEN) return;
  try {
    await fetch(KV_URL, {
      method: 'POST',
      headers: { Authorization: `Bearer ${KV_TOKEN}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(['DEL', key])
    });
  } catch { /* ignorar error de caché */ }
}

function tnHeaders(token) {
  return {
    'Authentication': `bearer ${token}`,
    'User-Agent': 'Monitor Areben (brunoarevalo@arebensrl.com)',
  };
}

async function fetchPage(storeId, token, page) {
  const r = await fetch(
    `https://api.tiendanube.com/v1/${storeId}/products?per_page=200&page=${page}&fields=id,name,handle,description,images,variants,published,categories,created_at`,
    { headers: tnHeaders(token) }
  );
  if (!r.ok) return { data: [], total: 0 };
  const total = parseInt(r.headers.get('X-Total-Count') || '0', 10);
  const data  = await r.json();
  return { data: Array.isArray(data) ? data : [], total };
}

// Trae todas las categorías de la tienda paginando, devuelve map id -> nombre
async function fetchAllCategories(storeId, token) {
  const map = {};
  let page = 1;
  while (page <= 20) { // safeguard
    const r = await fetch(
      `https://api.tiendanube.com/v1/${storeId}/categories?per_page=200&page=${page}&fields=id,name,parent`,
      { headers: tnHeaders(token) }
    );
    if (!r.ok) break;
    const data = await r.json();
    if (!Array.isArray(data) || data.length === 0) break;
    for (const c of data) {
      const n = c.name?.es || c.name?.pt || Object.values(c.name || {})[0] || `cat ${c.id}`;
      map[c.id] = n;
    }
    if (data.length < 200) break;
    page++;
  }
  return map;
}

// Color de una variante = value que NO es modelo de iPhone NI talle (misma regla que tn-subir-imagen.js).
const _TALLES = new Set(['s', 'm', 'l', 'xl', 'xxl', 'xs', 'xxs', 'xxxl', 'xxxxl', 'u', 'unico', 'único']);
const _esTalle = t => { const x = String(t || '').toLowerCase().trim(); return _TALLES.has(x) || /^\d{1,3}$/.test(x) || x.startsWith('talle'); };
const _valEs = v => v?.es || v?.pt || (v && Object.values(v)[0]) || '';
const _colorDeVariante = v => ((v.values || []).map(_valEs).filter(t => t && !/iphone/i.test(t) && !_esTalle(t))[0]) || '';

function mapProduct(p, catMap, incluirVariantes) {
  const name    = p.name?.es    || p.name?.pt    || Object.values(p.name    || {})[0] || '(sin nombre)';
  const handle  = p.handle?.es  || p.handle?.pt  || Object.values(p.handle  || {})[0] || null;
  const rawDesc = p.description?.es || p.description?.pt || Object.values(p.description || {})[0] || '';
  const desc    = rawDesc.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
  const images  = (p.images   || []).map(i => i.src).filter(Boolean);
  const variantsRaw = p.variants || [];
  const sku     = variantsRaw[0]?.sku || null;

  // Precio normal y promocional (de las variantes). El precio real de venta en TN
  // es el promocional cuando está cargado; si no, el normal.
  const _promoNums = variantsRaw.map(v => parseFloat(v.promotional_price)).filter(n => n > 0);
  const _priceNums = variantsRaw.map(v => parseFloat(v.price)).filter(n => n > 0);
  const promo_price = _promoNums.length ? Math.min(..._promoNums) : null;
  const price       = _priceNums.length ? Math.min(..._priceNums) : null;
  const categoryIds = (p.categories || []).map(c => typeof c === 'object' ? c.id : c).filter(Boolean);
  const categories  = categoryIds.map(id => catMap[id]).filter(Boolean);

  // Análisis variante ↔ foto: image_id null = la variante NO tiene foto propia vinculada
  // (usa la principal de forma automática). Solo aplica si el producto tiene fotos.
  const labelVar = v => {
    const vals = (v.values || []).map(val => val?.es || val?.pt || (val && Object.values(val)[0])).filter(Boolean);
    return vals.join(' / ') || v.sku || ('var ' + v.id);
  };
  const variantes_sin_foto = images.length > 0 ? variantsRaw.filter(v => v.image_id == null).map(labelVar) : [];

  const out = {
    id: p.id, name, handle, sku,
    price, promo_price,   // precio normal y promocional en TN
    published:   p.published ?? true,
    image_count: images.length,
    images,
    has_desc:    desc.length > 10,
    desc_length: desc.length,
    desc,
    raw_desc: rawDesc || '',
    categories,           // nombres de categorías en TN
    category_ids: categoryIds,
    created_at: p.created_at || null,
    variantes_total:     variantsRaw.length,
    variantes_con_foto:  images.length > 0 ? variantsRaw.filter(v => v.image_id != null).length : 0,
    variantes_sin_foto,  // etiquetas de las variantes sin foto propia
  };
  // Detalle por variante (solo si se pide con ?variantes=1): color + foto propia + sku, alineados.
  if (incluirVariantes) {
    const imgById = {};
    (p.images || []).forEach(i => { if (i.id != null) imgById[i.id] = i.src; });
    out.imagenes = (p.images || []).map(i => ({ id: i.id, src: i.src })).filter(x => x.id != null && x.src); // fotos del producto (id+src) para vincular
    out.variantes = variantsRaw.map(v => {
      const vals = (v.values || []).map(val => val?.es || val?.pt || (val && Object.values(val)[0])).filter(Boolean);
      const pr = parseFloat(v.promotional_price) > 0 ? parseFloat(v.promotional_price) : (parseFloat(v.price) || null);
      return {
        id: v.id != null ? String(v.id) : null,                         // id de variante en TN (para el mapeo SKU y escribir stock)
        sku: v.sku || null,
        barcode: v.barcode || null,
        valores: vals,                                                  // ej. ["iPhone 16 - Azul"] o ["Azul"]
        color: _colorDeVariante(v),                                     // color para agrupar/vincular
        image_url: v.image_id != null ? (imgById[v.image_id] || null) : null,  // foto PROPIA de la variante
        price: pr,
        stock: v.stock != null ? v.stock : null,                        // stock en TN (null = infinito/no gestionado)
      };
    });
  }
  return out;
}

// ── Verificación de ventas: pedidos cancelados en TN vs ventas activas en GN ──
const GN_BASE = 'https://www.gestionnube.com/api/v1';
async function tnFetchCanceladas(cfg, from, to) {
  const out = [];
  const base = `https://api.tiendanube.com/v1/${cfg.storeId}/orders`;
  const qs = `status=cancelled&created_at_min=${from}T00:00:00-03:00&created_at_max=${to}T23:59:59-03:00&per_page=200&fields=id,number,status,cancelled_at,total,contact_name,created_at`;
  const debug = { status: null, error: null };
  for (let page = 1; page <= 30; page++) {
    const r = await fetch(`${base}?${qs}&page=${page}`, { headers: tnHeaders(cfg.token) });
    if (page === 1) debug.status = r.status;
    if (!r.ok) { debug.error = (await r.text()).slice(0, 300); break; }
    const data = await r.json();
    if (!Array.isArray(data) || !data.length) break;
    out.push(...data);
    if (data.length < 200) break;
  }
  return { out, debug };
}
// ── Leer una orden de TN por número, con sus líneas (para Cambios/Devoluciones del Monitor) ──
// Reusa el mismo token/scope que ya lee órdenes (View Orders). Devuelve la orden con products[].
async function tnFetchOrden(cfg, numero, perPage) {
  const base = `https://api.tiendanube.com/v1/${cfg.storeId}/orders`;
  const target = String(numero);
  const objetivo = Number(numero);
  // TN es LENTO con per_page grande (~70ms por orden). Se pagina liviano (id,number, descendente) para hallar
  // el id interno, con corte temprano cuando la página baja del número. Las órdenes recientes están en pág 1.
  const pp = Math.min(Math.max(Number(perPage) || 50, 10), 200);
  let orderId = null;
  for (let page = 1; page <= 30; page++) {
    const r = await fetch(`${base}?per_page=${pp}&page=${page}&fields=id,number`, { headers: tnHeaders(cfg.token) });
    if (r.status === 404) break; // no hay más páginas
    if (!r.ok) return { error: `TN ${r.status}: ${(await r.text()).slice(0, 200)}` };
    const arr = await r.json();
    if (!Array.isArray(arr) || !arr.length) break;
    const o = arr.find(x => String(x.number) === target);
    if (o) { orderId = o.id; break; }
    const nums = arr.map(x => Number(x.number)).filter(n => !isNaN(n));
    if (nums.length && Math.min(...nums) < objetivo) break; // ya pasamos el número buscado (orden descendente)
    if (arr.length < pp) break;
  }
  if (!orderId) return { orden: null };
  // La orden completa por id (acá sí vienen los products). Sin ?fields (con fields el GET por id da 404).
  const rd = await fetch(`${base}/${orderId}`, { headers: tnHeaders(cfg.token) });
  if (!rd.ok) return { error: `TN ${rd.status} en GET /orders/${orderId}: ${(await rd.text()).slice(0, 150)}` };
  return { orden: mapOrdenTN(await rd.json()) };
}
// La forma canónica de una orden de TN para el Monitor. Vive aparte porque la leen DOS caminos
// —`?orden=N` (Cambios/Devoluciones) y `?ordenes=1` (el sync de ventas de Stunned)— y si cada uno
// armara su propio objeto, el día que uno cambie el otro se rompe en silencio.
// Todo lo de acá abajo ya viene en la respuesta de TN: esto sólo lo mapea.
//   - `pago_*`: por dónde se le devuelve (si pagó con MercadoPago, el reintegro va por ahí).
//   - los descuentos + `subtotal`: para prorratear. Sin esto, devolver un ítem de una orden
//     con cupón le devuelve de más al cliente — es el hueco que Cambios tiene hoy.
//   - `envio_costo_cliente`: lo que pagó de envío, por si corresponde devolvérselo.
//   - el bloque `envio_*` (13-ago-2026): lo que necesita la pantalla de Envíos del día del Monitor
//     para armar la hoja del cadete. Antes de esto, de todo el envío sólo viajaban la opción y lo
//     que pagó el cliente, y por eso el diagnóstico de la planilla de reparto dio "no se puede
//     medir" en tiempos, estados y zona: el dato no faltaba, no lo estábamos trayendo.
//
// ⚠️ **`conDireccion` está apagado por defecto, y no es una preferencia: es el permiso.**
// La dirección y el teléfono son datos personales de un cliente, y `?orden=N` —el otro camino que
// entra acá— **no exige usuario**: contesta a cualquiera que sepa un número de orden. Prenderlo
// para los dos caminos publicaría el domicilio de cada comprador de las dos tiendas. Sólo lo pide
// `?ordenes=1`, que sí pasa por `exigirUsuario`.
function mapOrdenTN(o, opts) {
  const pago = o.payment_details || {};
  const num = (v) => (v == null || v === '' ? null : Number(v));
  const txt = (v) => (v == null || v === '' ? null : String(v));
  const dir = o.shipping_address || {};
  return {
    id: o.id, number: o.number,
    cliente: o.contact_name || (o.customer && o.customer.name) || null,
    total: o.total, envio: o.shipping_option || null, fecha: o.created_at || null,
    // Forma de pago
    pago_metodo: pago.method || null,          // 'credit_card' | 'bank_transfer' | ...
    pago_gateway: o.gateway || null,           // 'mercadopago' | 'offline' | ...
    pago_cuotas: pago.installments || null,
    // Plata: lo que hace falta para prorratear los descuentos entre los ítems
    subtotal: num(o.subtotal),
    descuento_total: num(o.discount),                       // el total, sea cual sea su origen
    descuento_cupon: num(o.promotional_discount),           // cupón / promoción
    descuento_pago: num(o.discount_gateway),                // el % por medio de pago (ej. transferencia)
    cupon: Array.isArray(o.coupon) ? (o.coupon[0] && o.coupon[0].code) || null : null,
    envio_costo_cliente: num(o.shipping_cost_customer),     // lo que PAGÓ de envío
    // 🔑 Lo que NOS cuesta el envío. Es el único campo que permite saber si el envío se subsidia:
    // hasta hoy sólo se sabía cuánto se cobra. Si TN lo devuelve vacío, se dice, no se estima.
    envio_costo_nuestro: num(o.shipping_cost_owner),
    envio_tipo: txt(o.shipping_pickup_type),                // 'ship' (a domicilio) | 'pickup' (retira)
    envio_sucursal: txt(o.shipping_store_branch_name),      // a qué sucursal retira, si retira
    envio_estado: txt(o.shipping_status),                   // 'unpacked' | 'fulfilled'
    envio_tracking: txt(o.shipping_tracking_number),
    envio_despachado_en: txt(o.shipped_at),                 // el tramo que SÍ controlamos: venta → despacho
    pagado_en: txt(o.paid_at),
    estado_pago: o.payment_status || null,                  // 'paid' | 'refunded' | ...
    estado_orden: o.status || null,                         // 'open' | 'closed' | 'cancelled'
    // Datos personales: sólo con permiso explícito. Ver el aviso de arriba.
    envio_direccion: opts && opts.conDireccion ? {
      nombre: txt(dir.name),
      telefono: txt(dir.phone),
      calle: txt(dir.address),
      numero: txt(dir.number),
      piso: txt(dir.floor),
      entre_calles: txt(dir.between_streets),
      localidad: txt(dir.locality) || txt(dir.city),        // TN usa una u otra según el país
      ciudad: txt(dir.city),
      provincia: txt(dir.province),
      cp: txt(dir.zipcode),
    } : null,
    products: (o.products || []).map(p => ({ product_id: p.product_id, variant_id: p.variant_id, name: p.name, sku: p.sku, quantity: p.quantity, price: p.price })),
  };
}
// ── Leer las órdenes de TN de un RANGO, con sus líneas (sync de ventas Stunned TN→GN) ──
// La lista de TN es rápida pero mezquina; el GET por id trae todo pero cuesta ~200 ms cada uno.
// Por eso hay dos modos y un `probe` que los compara: el default se cambia con la medición en la
// mano, no por corazonada.
const RANGO_LIMITE_DEFAULT = 60;
const TN_PAGINAS_MAX = 30;

function tnRangoQs(from, to) {
  // Mismo formato de fecha que tnFetchCanceladas, que ya está probado en vivo contra TN.
  return `created_at_min=${from}T00:00:00-03:00&created_at_max=${to}T23:59:59-03:00`;
}

// Pagina la lista de órdenes del rango pidiendo `fields`. Devuelve [] si TN corta.
async function tnListaRango(cfg, from, to, fields) {
  const base = `https://api.tiendanube.com/v1/${cfg.storeId}/orders`;
  const qs = `${tnRangoQs(from, to)}&status=any&per_page=200&fields=${fields}`;
  const out = [];
  for (let page = 1; page <= TN_PAGINAS_MAX; page++) {
    const r = await fetch(`${base}?${qs}&page=${page}`, { headers: tnHeaders(cfg.token) });
    if (r.status === 404) break;                       // TN devuelve 404 cuando se pasó de páginas
    if (!r.ok) return { error: `TN ${r.status} en la lista: ${(await r.text()).slice(0, 200)}` };
    const arr = await r.json();
    if (!Array.isArray(arr) || !arr.length) break;
    out.push(...arr);
    if (arr.length < 200) break;
  }
  return { lista: out };
}

// Corre `tareas` (funciones que devuelven promesa) de a `n` a la vez, en orden de entrada.
async function enTandas(tareas, n) {
  const res = new Array(tareas.length);
  let i = 0;
  const worker = async () => { while (i < tareas.length) { const k = i++; res[k] = await tareas[k](); } };
  await Promise.all(Array.from({ length: Math.min(n, tareas.length) }, worker));
  return res;
}

// modo 'detalle' (default): correcto por construcción — un GET por id, sin `fields` (con `fields`
// el GET por id da 404). Es el único camino donde `products` está garantizado.
async function tnOrdenesDetalle(cfg, from, to, limite) {
  const base = `https://api.tiendanube.com/v1/${cfg.storeId}/orders`;
  const r = await tnListaRango(cfg, from, to, 'id,number,status,payment_status,created_at,total,contact_name');
  if (r.error) return r;
  const total = r.lista.length;
  const recorte = r.lista.slice(0, limite);
  const detalles = await enTandas(recorte.map(x => async () => {
    const rd = await fetch(`${base}/${x.id}`, { headers: tnHeaders(cfg.token) });
    if (!rd.ok) return { error: `TN ${rd.status} en GET /orders/${x.id}` };
    return mapOrdenTN(await rd.json(), { conDireccion: true });
  }), 4);
  const fallidas = detalles.filter(d => d && d.error).length;
  return { ordenes: detalles.filter(d => d && !d.error), total_en_rango: total, truncado: total > recorte.length, fallidas };
}

// modo 'lista': dos listas paginadas y join por `id`. Esquiva la maña conocida (pedir `products`
// en los `fields` de la lista hace que TN NO devuelva `number`) sacando el `number` de la otra
// pasada: el join es por `id`, que sí viene siempre. Un mes entero en ~1 s en vez de ~12.
// Los `fields` de la pasada grande del modo `lista`, en un array y no en un string suelto: el
// diagnóstico `?campos=1` bisecta EXACTAMENTE esta lista. Una copia pegada allá se desincroniza,
// y entonces el diagnóstico daría verde sobre campos que el modo real ya no pide.
const CAMPOS_LISTA_TN = [
  'id', 'number', 'status', 'payment_status', 'created_at', 'total', 'contact_name',
  'gateway', 'payment_details', 'subtotal', 'discount', 'promotional_discount',
  'discount_gateway', 'coupon', 'shipping_option', 'shipping_cost_customer',
  'shipping_cost_owner', 'shipping_pickup_type', 'shipping_store_branch_name',
  'shipping_status', 'shipping_tracking_number', 'shipped_at', 'paid_at',
  'shipping_address', 'customer',
];

async function tnOrdenesLista(cfg, from, to, limite) {
  const [a, b] = await Promise.all([
    // El bloque de envío viaja en esta pasada. Si TN volviera a hacer la maña de esconder un campo
    // cuando se le piden otros, lo canta `?probe=1`, que compara esta lista contra el detalle.
    tnListaRango(cfg, from, to, CAMPOS_LISTA_TN.join(',')),
    tnListaRango(cfg, from, to, 'id,products'),
  ]);
  if (a.error) return a;
  if (b.error) return b;
  const porId = new Map(b.lista.map(x => [String(x.id), x.products || []]));
  const total = a.lista.length;
  const ordenes = a.lista.slice(0, limite).map(o => mapOrdenTN({ ...o, products: porId.get(String(o.id)) || [] }, { conDireccion: true }));
  return { ordenes, total_en_rango: total, truncado: total > ordenes.length, fallidas: 0 };
}

// Los campos de envío que la pantalla de Envíos del día necesita, en un solo lugar: los mira el
// probe (¿la lista los trae igual que el detalle?) y el resumen de cobertura (¿TN los llena?).
const CAMPOS_ENVIO = [
  'envio', 'envio_costo_cliente', 'envio_costo_nuestro', 'envio_tipo', 'envio_sucursal',
  'envio_estado', 'envio_tracking', 'envio_despachado_en', 'pagado_en',
];
const CAMPOS_DIRECCION = ['nombre', 'telefono', 'calle', 'numero', 'piso', 'localidad', 'provincia', 'cp'];

// La firma que compara el probe: qué compró, por cuánto, **y cómo se lo mandamos**. Los ítems y el
// total alcanzaban cuando el único consumidor era el sync de ventas. Desde que la lista trae el
// bloque de envío, dejarlos afuera haría que el probe diera verde con los campos nuevos vacíos —
// que es justo la maña que el probe existe para cazar (pedir `products` hacía desaparecer
// `number`). Un ensayo que no mira el campo nuevo no lo está probando.
function firmaOrdenProbe(o) {
  const items = (o.products || []).map(p => `${p.sku || p.variant_id}×${p.quantity}`).sort().join('|');
  const envio = CAMPOS_ENVIO.map(k => `${k}=${o[k] ?? ''}`).join(',');
  const d = o.envio_direccion || {};
  const dir = CAMPOS_DIRECCION.map(k => `${k}=${d[k] ?? ''}`).join(',');
  return `${items}#${o.total}#${envio}#${dir}`;
}

/**
 * Cuántas de las órdenes del rango traen cada campo de envío con algo adentro.
 *
 * Es la sonda que faltaba, y va acá y no en una ruta nueva porque esta rama ya baja las órdenes,
 * ya exige usuario y ya es la que va a alimentar la pantalla de Envíos. Sin este número, decidir
 * qué columnas puede tener la hoja del cadete sería adivinar: el diagnóstico de la planilla dio
 * "no se pudo medir" en media docena de cosas, y la pregunta acá es cuáles de ésas TN sí contesta.
 *
 * `envio_costo_nuestro` es el que más importa: es el único que permite comparar lo que cobramos
 * contra lo que nos cuesta. Si viene en 0%, la respuesta es "TN no lo da", no una estimación.
 */
function coberturaEnvio(ordenes) {
  const lleno = (v) => v != null && v !== '';
  const cuenta = (k) => ordenes.filter(o => lleno(o[k])).length;
  const cuentaDir = (k) => ordenes.filter(o => lleno((o.envio_direccion || {})[k])).length;
  const out = { ordenes: ordenes.length, campos: {}, direccion: {}, opciones_de_envio: {} };
  for (const k of CAMPOS_ENVIO) out.campos[k] = cuenta(k);
  for (const k of CAMPOS_DIRECCION) out.direccion[k] = cuentaDir(k);
  // Qué valores toma `shipping_option`: es lo ÚNICO que distingue "va en moto" de "va por correo",
  // y sin esa lista la pantalla del día no sabe qué filtrar.
  for (const o of ordenes) {
    const k = o.envio == null || o.envio === '' ? '(vacío)' : String(o.envio);
    out.opciones_de_envio[k] = (out.opciones_de_envio[k] || 0) + 1;
  }
  return out;
}

async function tnFetchOrdenesRango(cfg, from, to, opts) {
  const limite = Math.min(Math.max(Number(opts && opts.limite) || RANGO_LIMITE_DEFAULT, 1), 200);
  const modo = (opts && opts.modo) === 'lista' ? 'lista' : 'detalle';
  const [res, canc] = await Promise.all([
    modo === 'lista' ? tnOrdenesLista(cfg, from, to, limite) : tnOrdenesDetalle(cfg, from, to, limite),
    // No se confía en que la lista traiga las canceladas: se pregunta aparte, con la función que ya existe.
    tnFetchCanceladas(cfg, from, to),
  ]);
  if (res.error) return res;
  const cancelados = new Set(canc.out.map(o => String(o.number)));
  res.ordenes.forEach(o => { o.cancelada = cancelados.has(String(o.number)); });
  return { ...res, modo };
}

// ?probe=1 — corre los dos modos sobre el mismo rango y devuelve tiempos + si coinciden.
async function tnProbeModos(cfg, from, to, limite) {
  const medir = async fn => { const t = Date.now(); const r = await fn(); return { ms: Date.now() - t, r }; };
  const [d, l] = await Promise.all([
    medir(() => tnOrdenesDetalle(cfg, from, to, limite)),
    medir(() => tnOrdenesLista(cfg, from, to, limite)),
  ]);
  if (d.r.error || l.r.error) return { error: d.r.error || l.r.error };
  const firmaD = new Map(d.r.ordenes.map(o => [String(o.number), firmaOrdenProbe(o)]));
  const firmaL = new Map(l.r.ordenes.map(o => [String(o.number), firmaOrdenProbe(o)]));
  const faltan_en_lista = [...firmaD.keys()].filter(n => !firmaL.has(n));
  const difieren = [...firmaD.entries()].filter(([n, f]) => firmaL.has(n) && firmaL.get(n) !== f)
    .map(([n, f]) => ({ number: n, detalle: f, lista: firmaL.get(n) }));
  const sin_products = l.r.ordenes.filter(o => !(o.products || []).length).length;
  return {
    tiempos: { detalle_ms: d.ms, lista_ms: l.ms },
    cuentas: { detalle: d.r.ordenes.length, lista: l.r.ordenes.length, lista_sin_products: sin_products },
    iguales: faltan_en_lista.length === 0 && difieren.length === 0 && sin_products === 0,
    faltan_en_lista, difieren: difieren.slice(0, 20),
  };
}

// ── ?campos=1 — QUÉ campo de `fields` hace que TN conteste vacío ──────────────────────────────
//
// El modo `lista` devuelve 0 órdenes donde el `detalle` devuelve 32, y sin error: TN contesta 200
// con la lista vacía. `tnListaRango` no puede decir cuál campo lo provoca porque pide los 25 de una,
// y el token de TN vive sólo en Vercel (`env pull` lo baja vacío) ⇒ la medición tiene que salir de
// acá, del endpoint deployado y logueado, no de un script local.
//
// 🔑 **Mira una sola página, a propósito.** `tnListaRango` pagina hasta 30 veces; con 25 campos ×
// 30 páginas × dos rondas se va del `maxDuration`. Con un rango corto (2-3 días) una página de 200
// ES el rango entero, así que la cuenta de la única página alcanza para comparar.
async function tnUnaPagina(cfg, from, to, campos) {
  const qs = `${tnRangoQs(from, to)}&status=any&per_page=200&page=1&fields=${campos.join(',')}`;
  const r = await fetch(`https://api.tiendanube.com/v1/${cfg.storeId}/orders?${qs}`, { headers: tnHeaders(cfg.token) });
  const txt = await r.text();
  let j = null;
  try { j = JSON.parse(txt); } catch { /* TN contestó algo que no es JSON */ }
  return {
    status: r.status,
    n: Array.isArray(j) ? j.length : null,
    // Lo que TN contesta cuando NO es una lista es la mitad de la respuesta: puede ser un objeto de
    // error con 200 adentro. Sin esto, "no vino nada" y "vino un error disfrazado" se ven igual.
    cuerpo: Array.isArray(j) ? null : txt.slice(0, 300),
  };
}

// Bisecta la lista buscando UN campo culpable. `prueba(sub)` dice si TN contestó bien.
// Si ninguna de las dos mitades falla sola, el problema es una COMBINACIÓN y lo dice: reportar
// "no encontré culpable" sería leerlo como "ya está arreglado".
async function tnBisecarCampos(prueba, campos) {
  let malo = campos.slice();
  const pasos = [];
  while (malo.length > 1) {
    const corte = Math.ceil(malo.length / 2);
    const a = malo.slice(0, corte), b = malo.slice(corte);
    const okA = await prueba(a);
    pasos.push({ probado: a.join(','), ok: okA });
    if (!okA) { malo = a; continue; }
    const okB = await prueba(b);
    pasos.push({ probado: b.join(','), ok: okB });
    if (!okB) { malo = b; continue; }
    return { culpable: null, combinacion: true, entre: malo, pasos };
  }
  return { culpable: malo[0] || null, combinacion: false, pasos };
}

async function tnDiagCampos(cfg, from, to) {
  // El piso: `id` solo. Si esto ya viene vacío, no es un campo — es el rango.
  const piso = await tnUnaPagina(cfg, from, to, ['id']);
  const completo = await tnUnaPagina(cfg, from, to, CAMPOS_LISTA_TN);
  const esperado = piso.n;
  if (!esperado) return { piso, completo, veredicto: 'El rango no tiene órdenes ni pidiendo `id` solo: probar otras fechas.' };
  if (completo.n === esperado) return { piso, completo, veredicto: 'La lista completa trae todo: el defecto no se reproduce en este rango.' };

  // Uno por uno (`id` + el campo): caza los nombres que TN no conoce. Va de a 4 como los detalles.
  const individuales = await enTandas(
    CAMPOS_LISTA_TN.filter(c => c !== 'id').map(c => async () => {
      const r = await tnUnaPagina(cfg, from, to, ['id', c]);
      return { campo: c, status: r.status, n: r.n, cuerpo: r.cuerpo };
    }), 4);
  const solos_que_fallan = individuales.filter(x => x.n !== esperado);

  // Si alguno falla solo, ya está: bisecar de nuevo sería medir lo mismo dos veces.
  if (solos_que_fallan.length) {
    return { piso, completo, esperado, solos_que_fallan, veredicto: 'Hay campos que rompen la lista ellos solos.' };
  }
  const bisect = await tnBisecarCampos(
    async (sub) => (await tnUnaPagina(cfg, from, to, sub.includes('id') ? sub : ['id', ...sub])).n === esperado,
    CAMPOS_LISTA_TN,
  );
  return { piso, completo, esperado, solos_que_fallan: [], bisect, veredicto: bisect.combinacion ? 'Ningún campo rompe solo: es una combinación.' : `Culpable: ${bisect.culpable}` };
}

// `incluirDetalles` agrega los renglones de cada venta (el mismo flag que usa scripts/sync-diario.js
// del Monitor). Va apagado por defecto para no engordar `?verificar_ventas=1`, que no los usa.
async function gnFetchVentas(gnToken, from, to, incluirDetalles) {
  const out = [];
  const extra = incluirDetalles ? '&include_details=1' : '';
  for (let page = 1; page <= 200; page++) {
    const r = await fetch(`${GN_BASE}/ventas/obtener?from=${from}&to=${to}${extra}&per_page=50&page=${page}`, {
      headers: { Authorization: `Bearer ${gnToken}`, Accept: 'application/json' },
    });
    if (!r.ok) break;
    const j = await r.json().catch(() => null);
    const lista = (j && Array.isArray(j.data)) ? j.data : (Array.isArray(j) ? j : []);
    if (!lista.length) break;
    out.push(...lista);
    if (j?.meta?.has_more_pages === false || lista.length < 50) break;
  }
  return out;
}

// ── Modo "catalogo": productos de GN + fotos de TN, cruzados (admin interno por marca) ──
// Devuelve cada producto con costo/precio/variantes (GN) + sus fotos (TN). NO usa
// caché ni toca las otras rutas de este endpoint (return temprano en el handler).
function _catNormWords(s) {
  return (s == null ? '' : String(s)).toLowerCase()
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, ' ').trim().split(/\s+/).filter(Boolean);
}
async function _catGNProductos(token) {
  const baseQs = 'per_page=100&include_stock=1&include_variants=1';
  const extraer = d => (Array.isArray(d) ? d : (d.data || d.products || d.items || []));
  const get = async page => {
    const r = await fetch(`${GN_BASE}/productos/obtener?${baseQs}&page=${page}`, {
      headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' },
    });
    if (!r.ok) throw new Error('GN ' + r.status);
    return r.json();
  };
  const first = await get(1);
  let lastPage = first.meta ? (first.meta.last_page || 1) : 1;
  if (lastPage > 30) lastPage = 30;
  let pages = [extraer(first)];
  if (lastPage > 1) {
    const rest = await Promise.all(Array.from({ length: lastPage - 1 }, (_, i) => get(i + 2).then(extraer).catch(() => [])));
    pages = pages.concat(rest);
  }
  const seen = new Set(); const out = [];
  for (const raw of pages) for (const p of raw) { const id = p.id || p.product_id; if (seen.has(id) || p.active === 0) continue; seen.add(id); out.push(p); }
  return out;
}
// Reusa fetchPage (mismo User-Agent/headers que ya funciona para Zattia).
async function _catTNImageMap(storeId, token) {
  const map = {};
  const first = await fetchPage(storeId, token, 1);
  const total = first.total || first.data.length;
  const totalPages = Math.min(10, Math.max(1, Math.ceil(total / 200)));
  const pages = [first.data];
  if (totalPages > 1) {
    const rest = await Promise.all(
      Array.from({ length: totalPages - 1 }, (_, i) => fetchPage(storeId, token, i + 2).then(r => r.data).catch(() => []))
    );
    pages.push(...rest);
  }
  // Prefiere fotos: una entrada VACÍA nunca pisa una que ya tiene fotos (evita que
  // un duplicado tipo "... MAYORISTA" con 0 fotos borre las del producto bueno).
  const setKey = (k, imgs) => { if (k && (!map[k] || (!map[k].length && imgs.length))) map[k] = imgs; };
  for (const data of pages) {
    for (const p of data) {
      const imgs = (p.images || []).map(i => i.src).filter(Boolean);
      const nombre = (p.name?.es || p.name?.pt || Object.values(p.name || {})[0] || '').trim().toLowerCase();
      setKey(nombre, imgs);
      if (Array.isArray(p.variants)) for (const v of p.variants) { if (v.sku) setKey(String(v.sku).trim().toLowerCase(), imgs); }
    }
  }
  return map;
}
function _catImgsDe(p, tnMap, tnIndex) {
  const sku = String(p.code || p.sku || p.codigo || '').trim().toLowerCase();
  if (sku && tnMap[sku]) return tnMap[sku];
  const gn = _catNormWords(p.name || p.nombre || p.product_name || '');
  if (!gn.length) return [];
  let best = null, bestLen = 0;
  for (const e of tnIndex) { const tw = e.words; if (tw.length && tw.length <= gn.length && tw.length > bestLen && tw.every((w, i) => w === gn[i])) { best = e.key; bestLen = tw.length; } }
  return best ? tnMap[best] : [];
}
async function _catHandle(cfg, res) {
  if (!cfg.gnToken) return res.status(500).json({ error: 'Falta el token de Gestión Nube para esta tienda' });
  try {
    const [productos, tnMap] = await Promise.all([
      _catGNProductos(cfg.gnToken),
      _catTNImageMap(cfg.storeId, cfg.token).catch(() => ({})),
    ]);
    const tnIndex = Object.keys(tnMap).map(k => ({ key: k, words: _catNormWords(k) }));
    const out = productos.map(p => ({
      id: p.id || p.product_id,
      name: p.name || p.nombre || p.product_name || 'Sin nombre',
      code: p.code || p.sku || p.codigo || '',
      category: p.category || '',
      unit_cost: parseFloat(p.unit_cost || 0) || 0,
      wholesaler_price: parseFloat(p.wholesaler_price || p.precio_mayorista || 0) || 0,
      retailer_price: parseFloat(p.retailer_price || p.price || 0) || 0,
      variantes: (p.variantes || []).map(v => ({ size: v.size, size_id: v.size_id, stock_por_tienda: v.stock_por_tienda || [] })),
      imgs: _catImgsDe(p, tnMap, tnIndex),
    }));
    return res.status(200).json({ ok: true, total: out.length, productos: out });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
}

module.exports = async (req, res) => {
  Object.entries(CORS).forEach(([k, v]) => res.setHeader(k, v));
  // Evitar caché del navegador: el caché real vive en KV del servidor (1h),
  // los clientes deben pedir siempre y dejar que el servidor decida.
  res.setHeader('Cache-Control', 'no-store, max-age=0, must-revalidate');
  if (req.method === 'OPTIONS') return res.status(204).end();

  // Determinar qué store usar
  const storeKey = (req.query?.store || 'bdi').toLowerCase();
  const cfg = STORES[storeKey];
  if (!cfg) return res.status(400).json({ error: 'Store desconocido. Usar ?store=bdi o ?store=zattia' });
  if (!cfg.storeId || !cfg.token) return res.status(500).json({ error: `Tienda Nube no configurado para ${storeKey}` });

  // Modo catálogo: productos GN + fotos TN cruzados (admin interno por marca).
  if (req.query?.catalogo === '1') return _catHandle(cfg, res);

  // ── Leer una orden de TN por número (Cambios/Devoluciones del Monitor) ──
  if (req.query?.orden) {
    try {
      const r = await tnFetchOrden(cfg, String(req.query.orden), req.query?.pp);
      if (r.error) return res.status(502).json({ error: r.error });
      return res.status(200).json({ ok: true, store: storeKey, orden: r.orden });
    } catch (e) {
      return res.status(500).json({ error: e.message });
    }
  }

  // ── Órdenes de TN por rango, con líneas + las ventas de GN del mismo rango ──
  // Un solo round-trip con TODO lo que el dry-run del sync de ventas necesita del servidor.
  // A diferencia de las otras ramas, ésta expone nombres de clientes y montos de a cientos ⇒
  // exige usuario del Monitor. ⚠️ En producción `AUTH_MODO_AVISO=0`: el guard **rechaza de
  // verdad**, no avisa. Comprobado con un curl sin credencial (403). O sea: esta rama sólo se
  // puede probar desde el Monitor logueado (apiFetch manda `x-monitor-auth`), no con curl.
  if (req.query?.ordenes === '1') {
    if (!(await exigirUsuario(req, res, 'ordenes TN'))) return;
    const from = req.query.from, to = req.query.to;
    if (!from || !to) return res.status(400).json({ error: 'Faltan from/to (YYYY-MM-DD)' });
    try {
      const limite = Math.min(Math.max(Number(req.query.limite) || RANGO_LIMITE_DEFAULT, 1), 200);
      if (req.query?.campos === '1') {
        const d = await tnDiagCampos(cfg, from, to);
        return res.status(200).json({ ok: true, store: storeKey, from, to, campos: d });
      }
      if (req.query?.probe === '1') {
        const p = await tnProbeModos(cfg, from, to, limite);
        if (p.error) return res.status(502).json({ error: p.error });
        return res.status(200).json({ ok: true, store: storeKey, from, to, probe: p });
      }
      const [tn, ventasGn] = await Promise.all([
        tnFetchOrdenesRango(cfg, from, to, { limite, modo: req.query.modo }),
        cfg.gnToken ? gnFetchVentas(cfg.gnToken, from, to, true) : Promise.resolve([]),
      ]);
      if (tn.error) return res.status(502).json({ error: tn.error });
      return res.status(200).json({
        ok: true, store: storeKey, from, to,
        modo: tn.modo, limite, truncado: tn.truncado, total_en_rango: tn.total_en_rango, fallidas: tn.fallidas,
        // Qué tan lleno viene el bloque de envío en este rango. Barato (se calcula sobre lo que ya
        // se bajó) y es lo que decide qué columnas puede tener la pantalla de Envíos del día.
        envio_cobertura: coberturaEnvio(tn.ordenes),
        ordenes: tn.ordenes,
        // Lo que el motor necesita para NO duplicar: `tn_order` (las nativas de TN lo traen) y los
        // renglones, para cruzar por firma de ítems contra lo que hoy se carga a mano.
        ventas_gn: ventasGn.map(v => ({
          id: v.id, number: v.number || null, date_sale: v.date_sale || null,
          channel_id: v.channel_id ?? null, channel: v.channel || null, store: v.store || null,
          tn_order: v.tn_order != null ? String(v.tn_order) : null,
          integration_id: v.integration_id != null ? String(v.integration_id) : null,
          integration_source: v.integration_source || null,
          total_price: v.total_price ?? null,
          client_name: v.client_name || (v.client && v.client.name) || null,
          active: v.active, archived: v.archived,
          detalles: (v.detalles || v.details || []).map(d => ({ product_id: d.product_id, size_id: d.size_id, quantity: d.quantity })),
        })),
      });
    } catch (e) {
      return res.status(500).json({ error: e.message });
    }
  }

  // Diagnóstico: qué variables de entorno relevantes ve la función (solo presencia, sin valores)
  if (req.query?.envcheck === '1') {
    const has = n => !!process.env[n];
    return res.status(200).json({ store: storeKey, env: {
      GESTIONNUBE_TOKEN_ZATTIA: has('GESTIONNUBE_TOKEN_ZATTIA'),
      GN_TOKEN_ZATTIA: has('GN_TOKEN_ZATTIA'),
      TIENDANUBE_TOKEN_ZATTIA: has('TIENDANUBE_TOKEN_ZATTIA'),
      TIENDANNUBE_TOKEN_ZATTIA: has('TIENDANNUBE_TOKEN_ZATTIA'),
      TIENDANUBE_STORE_ID_ZATTIA: has('TIENDANUBE_STORE_ID_ZATTIA'),
      GESTIONNUBE_TOKEN: has('GESTIONNUBE_TOKEN'),
      GN_TOKEN: has('GN_TOKEN'),
      TIENDANUBE_TOKEN: has('TIENDANUBE_TOKEN'),
    }, nombres_reales: Object.keys(process.env).filter(k => /ZATTIA|GESTION|NUBE|GN_|TIENDA/i.test(k)).sort(), cfg_tiene: { token: !!cfg.token, gnToken: !!cfg.gnToken, storeId: !!cfg.storeId } });
  }

  // ── Verificación de ventas: cancelada en TN pero activa en GN ──
  if (req.query?.verificar_ventas === '1') {
    if (!cfg.gnToken) return res.status(500).json({ error: `Falta el token de Gestión Nube para ${storeKey} (GESTIONNUBE_TOKEN${storeKey === 'zattia' ? '_ZATTIA' : ''}).` });
    const from = req.query.from, to = req.query.to;
    if (!from || !to) return res.status(400).json({ error: 'Faltan from/to (YYYY-MM-DD)' });
    try {
      const [tnRes, gnVentas] = await Promise.all([
        tnFetchCanceladas(cfg, from, to),
        gnFetchVentas(cfg.gnToken, from, to),
      ]);
      const tnCanc = tnRes.out;
      const cancByNum = {};
      tnCanc.forEach(o => { if (o.number != null) cancByNum[String(o.number)] = o; });
      const discrepancias = [];
      for (const v of gnVentas) {
        if (v.channel_id !== 16) continue;                          // solo Tienda Nube
        if (!(v.active === true && v.archived !== true)) continue;  // solo activas en GN
        const num = v.tn_order != null ? String(v.tn_order) : null;
        if (!num || !cancByNum[num]) continue;                      // solo las canceladas en TN
        const o = cancByNum[num];
        discrepancias.push({
          tn_order: num,
          gn_id: v.id,
          gn_number: v.number || null,
          date_sale: v.date_sale || null,
          total_price: v.total_price ?? null,
          client_name: v.client_name || (v.client && v.client.name) || null,
          tn_cancelled_at: o.cancelled_at || null,
        });
      }
      discrepancias.sort((a, b) => String(a.date_sale).localeCompare(String(b.date_sale)));
      return res.status(200).json({
        ok: true, store: storeKey, from, to,
        resumen: { tn_cancelados: tnCanc.length, gn_ventas: gnVentas.length, discrepancias: discrepancias.length },
        tn_debug: tnRes.debug,
        discrepancias,
      });
    } catch (e) {
      return res.status(500).json({ error: e.message });
    }
  }

  const forceRefresh = req.query?.refresh === '1';
  const incluirVariantes = req.query?.variantes === '1';
  // Clave de caché separada para la versión con variantes (no pisa la que usa Monitor).
  const ckey = incluirVariantes ? cfg.cacheKey + ':var3' : cfg.cacheKey; // :var3 = variante con id+stock (además de imagenes[id,src] + color)

  if (!forceRefresh) {
    const cached = await kvGet(ckey);
    if (cached) {
      res.setHeader('X-Cache', 'HIT');
      return res.json(cached);
    }
  } else {
    // Cada tienda guarda DOS cachés —el liviano y el `:var3` con el detalle por variante— y
    // `refresh=1` regeneraba solo el que se pedía. El Monitor pide el refresco sin `variantes=1`
    // después de escribir (vincular/desvincular una foto, ocultar un producto), así que el
    // `:var3` seguía sirviendo la tienda de antes del cambio por hasta una hora: se arreglaba
    // una foto cruzada, se recargaba, y volvía a aparecer cruzada. Un `refresh` significa "la
    // tienda cambió", no "actualizame esta vista": se tira el otro también.
    await kvDel(incluirVariantes ? cfg.cacheKey : cfg.cacheKey + ':var3');
  }

  try {
    // En paralelo: primera página de productos + map de categorías
    const [firstResult, catMap] = await Promise.all([
      fetchPage(cfg.storeId, cfg.token, 1),
      fetchAllCategories(cfg.storeId, cfg.token),
    ]);
    const { data: first, total } = firstResult;
    if (!first.length) {
      const empty = { store: storeKey, total: 0, products: [], categories: catMap, cached_at: new Date().toISOString() };
      await kvSet(ckey, empty);
      return res.json(empty);
    }

    const totalPages = Math.ceil(total / 200);
    const restPages  = Array.from({ length: totalPages - 1 }, (_, i) => i + 2);
    const rest = await Promise.all(restPages.map(p => fetchPage(cfg.storeId, cfg.token, p)));

    const all      = [first, ...rest.map(r => r.data)].flat();
    const products = all.map(p => mapProduct(p, catMap, incluirVariantes));
    const payload  = { store: storeKey, total: products.length, products, categories: catMap, cached_at: new Date().toISOString() };

    await kvSet(ckey, payload);
    res.setHeader('X-Cache', 'MISS');
    res.json(payload);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
};
