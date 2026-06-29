const KV_URL   = process.env.KV_REST_API_URL   || process.env.STORAGE_KV_REST_API_URL;
const KV_TOKEN = process.env.KV_REST_API_TOKEN || process.env.STORAGE_KV_REST_API_TOKEN;
const CACHE_TTL = 3600; // 1 hora en segundos

// Configuración por store. Permite usar ?store=zattia o ?store=bdi (default).
const STORES = {
  bdi: {
    storeId: process.env.TIENDANUBE_STORE_ID,
    token:   process.env.TIENDANUBE_TOKEN,
    cacheKey:'tiendanube-audit',
  },
  zattia: {
    storeId: process.env.TIENDANUBE_STORE_ID_ZATTIA,
    token:   process.env.TIENDANUBE_TOKEN_ZATTIA,
    cacheKey:'tiendanube-audit-zattia',
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
    out.variantes = variantsRaw.map(v => {
      const vals = (v.values || []).map(val => val?.es || val?.pt || (val && Object.values(val)[0])).filter(Boolean);
      const pr = parseFloat(v.promotional_price) > 0 ? parseFloat(v.promotional_price) : (parseFloat(v.price) || null);
      return {
        sku: v.sku || null,
        barcode: v.barcode || null,
        valores: vals,                                                  // ej. ["iPhone 16 - Azul"] o ["Azul"]
        image_url: v.image_id != null ? (imgById[v.image_id] || null) : null,  // foto PROPIA de la variante
        price: pr,
      };
    });
  }
  return out;
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

  const forceRefresh = req.query?.refresh === '1';
  const incluirVariantes = req.query?.variantes === '1';
  // Clave de caché separada para la versión con variantes (no pisa la que usa Monitor).
  const ckey = incluirVariantes ? cfg.cacheKey + ':var' : cfg.cacheKey;

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
