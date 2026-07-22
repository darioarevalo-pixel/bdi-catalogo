// Datos de catálogo de ZATTIA para el admin interno (solo lectura).
// Trae productos de Gestión Nube (Zattia) + fotos de Tienda Nube (Zattia) y los
// cruza por SKU o por prefijo de nombre, devolviendo cada producto ya con sus
// imágenes resueltas. NO toca nada del catálogo BDI (endpoint aparte).
//
// Tokens (ya cargados en Vercel):
//   GESTIONNUBE_TOKEN_ZATTIA, TIENDANUBE_TOKEN_ZATTIA, TIENDANUBE_STORE_ID_ZATTIA
const GN_BASE = 'https://www.gestionnube.com/api/v1';

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

// Normaliza un nombre a palabras (minúsculas, sin acentos/puntuación) para el
// cruce GN↔TN por prefijo. Misma lógica que el admin de BDI.
function normWords(s) {
  return (s == null ? '' : String(s))
    .toLowerCase()
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .split(/\s+/)
    .filter(Boolean);
}

// --- Gestión Nube: productos de Zattia (paginado) ---
async function fetchGNProductos(token) {
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
    const rest = await Promise.all(
      Array.from({ length: lastPage - 1 }, (_, i) => get(i + 2).then(extraer).catch(() => []))
    );
    pages = pages.concat(rest);
  }
  const seen = new Set();
  const out = [];
  for (const raw of pages) {
    for (const p of raw) {
      const id = p.id || p.product_id;
      if (seen.has(id) || p.active === 0) continue;
      seen.add(id);
      out.push(p);
    }
  }
  return out;
}

// --- Tienda Nube: mapa nombre/SKU -> [fotos] de Zattia (paginado) ---
async function fetchTNImageMap(storeId, token) {
  const map = {};
  let page = 1;
  while (true) {
    const r = await fetch(`https://api.tiendanube.com/v1/${storeId}/products?per_page=200&page=${page}&fields=id,name,sku,variants,images`, {
      headers: { Authentication: 'bearer ' + token, 'User-Agent': 'ZATTIA Admin (brunoarevalo@arebensrl.com)' },
    });
    if (!r.ok) break;
    const data = await r.json();
    if (!Array.isArray(data) || !data.length) break;
    for (const p of data) {
      const imgs = (p.images || []).map(i => i.src).filter(Boolean);
      const nombre = (p.name?.es || p.name?.pt || Object.values(p.name || {})[0] || '').trim().toLowerCase();
      if (nombre) map[nombre] = imgs;
      if (Array.isArray(p.variants)) {
        for (const v of p.variants) { if (v.sku) map[String(v.sku).trim().toLowerCase()] = imgs; }
      }
    }
    if (data.length < 200) break;
    page++;
  }
  return map;
}

// Cruza un producto GN con el mapa TN (por SKU o prefijo de nombre más largo).
function imgsDe(p, tnMap, tnIndex) {
  const sku = String(p.code || p.sku || p.codigo || '').trim().toLowerCase();
  if (sku && tnMap[sku]) return tnMap[sku];
  const gn = normWords(p.name || p.nombre || p.product_name || '');
  if (!gn.length) return [];
  let best = null, bestLen = 0;
  for (const e of tnIndex) {
    const tw = e.words;
    if (tw.length && tw.length <= gn.length && tw.length > bestLen && tw.every((w, i) => w === gn[i])) {
      best = e.key; bestLen = tw.length;
    }
  }
  return best ? tnMap[best] : [];
}

module.exports = async (req, res) => {
  Object.entries(CORS).forEach(([k, v]) => res.setHeader(k, v));
  res.setHeader('Cache-Control', 'no-store, max-age=0, must-revalidate');
  if (req.method === 'OPTIONS') return res.status(204).end();

  const gnToken = process.env.GESTIONNUBE_TOKEN_ZATTIA || process.env.GN_TOKEN_ZATTIA;
  const tnToken = process.env.TIENDANUBE_TOKEN_ZATTIA;
  const tnStore = process.env.TIENDANUBE_STORE_ID_ZATTIA;
  if (!gnToken) return res.status(500).json({ error: 'Falta GESTIONNUBE_TOKEN_ZATTIA' });

  try {
    // GN (productos) y TN (fotos) en paralelo. Si TN falla, seguimos sin fotos.
    const [productos, tnMap] = await Promise.all([
      fetchGNProductos(gnToken),
      (tnToken && tnStore) ? fetchTNImageMap(tnStore, tnToken).catch(() => ({})) : Promise.resolve({}),
    ]);
    const tnIndex = Object.keys(tnMap).map(k => ({ key: k, words: normWords(k) }));

    const out = productos.map(p => {
      const imgs = imgsDe(p, tnMap, tnIndex);
      return {
        id: p.id || p.product_id,
        name: p.name || p.nombre || p.product_name || 'Sin nombre',
        code: p.code || p.sku || p.codigo || '',
        category: p.category || '',
        unit_cost: parseFloat(p.unit_cost || 0) || 0,
        wholesaler_price: parseFloat(p.wholesaler_price || p.precio_mayorista || 0) || 0,
        retailer_price: parseFloat(p.retailer_price || p.price || 0) || 0,
        variantes: (p.variantes || []).map(v => ({
          size: v.size, size_id: v.size_id, stock_por_tienda: v.stock_por_tienda || [],
        })),
        imgs,
      };
    });

    res.status(200).json({ ok: true, total: out.length, productos: out });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
};
