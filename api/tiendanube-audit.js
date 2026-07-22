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

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
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
async function tnFetchOrden(cfg, numero) {
  const base = `https://api.tiendanube.com/v1/${cfg.storeId}/orders`;
  const fields = 'id,number,contact_name,customer,products,shipping_address,shipping_option,shipping_cost_customer,status,total,created_at';
  const target = String(numero);
  const objetivo = Number(numero);
  // TN NO busca por número de orden con ?q= (devuelve 404). Las órdenes vienen DESCENDENTES (más nueva
  // primero), así que se pagina y se filtra por `number`, con corte temprano cuando la página ya bajó
  // del número buscado. Cap de páginas para acotar (cubre las órdenes recientes, que son el caso de cambios).
  for (let page = 1; page <= 20; page++) {
    const r = await fetch(`${base}?per_page=200&page=${page}&fields=${fields}`, { headers: tnHeaders(cfg.token) });
    if (r.status === 404) break; // no hay más páginas
    if (!r.ok) return { error: `TN ${r.status}: ${(await r.text()).slice(0, 200)}` };
    const arr = await r.json();
    if (!Array.isArray(arr) || !arr.length) break;
    const o = arr.find(x => String(x.number) === target);
    if (o) return { orden: {
      id: o.id, number: o.number,
      cliente: o.contact_name || (o.customer && o.customer.name) || null,
      total: o.total, envio: o.shipping_option || null,
      products: (o.products || []).map(p => ({ product_id: p.product_id, variant_id: p.variant_id, name: p.name, sku: p.sku, quantity: p.quantity, price: p.price })),
    } };
    const nums = arr.map(x => Number(x.number)).filter(n => !isNaN(n));
    if (nums.length && Math.min(...nums) < objetivo) break; // ya pasamos el número buscado
    if (arr.length < 200) break;
  }
  return { orden: null };
}
async function gnFetchVentas(gnToken, from, to) {
  const out = [];
  for (let page = 1; page <= 200; page++) {
    const r = await fetch(`${GN_BASE}/ventas/obtener?from=${from}&to=${to}&per_page=50&page=${page}`, {
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
      const r = await tnFetchOrden(cfg, String(req.query.orden));
      if (r.error) return res.status(502).json({ error: r.error });
      return res.status(200).json({ ok: true, store: storeKey, orden: r.orden });
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
