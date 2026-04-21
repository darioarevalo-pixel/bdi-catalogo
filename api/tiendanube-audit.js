const STORE_ID = process.env.TIENDANUBE_STORE_ID;
const TOKEN    = process.env.TIENDANUBE_TOKEN;
const API_BASE = `https://api.tiendanube.com/v1/${STORE_ID}`;
const KV_URL   = process.env.KV_REST_API_URL   || process.env.STORAGE_KV_REST_API_URL;
const KV_TOKEN = process.env.KV_REST_API_TOKEN || process.env.STORAGE_KV_REST_API_TOKEN;
const CACHE_KEY = 'tiendanube-audit';
const CACHE_TTL = 3600; // 1 hora en segundos

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

const TN_HEADERS = {
  'Authentication': `bearer ${TOKEN}`,
  'User-Agent': 'BDI Catalogo (darioarevalo@arebensrl.com)',
};

async function kvGet() {
  if (!KV_URL || !KV_TOKEN) return null;
  try {
    const r = await fetch(`${KV_URL}/get/${CACHE_KEY}`, {
      headers: { Authorization: `Bearer ${KV_TOKEN}` }
    });
    const d = await r.json();
    return d.result ? JSON.parse(d.result) : null;
  } catch { return null; }
}

async function kvSet(value) {
  if (!KV_URL || !KV_TOKEN) return;
  try {
    await fetch(KV_URL, {
      method: 'POST',
      headers: { Authorization: `Bearer ${KV_TOKEN}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(['SET', CACHE_KEY, JSON.stringify(value), 'EX', CACHE_TTL])
    });
  } catch { /* ignorar error de caché */ }
}

async function fetchPage(page) {
  const r = await fetch(
    `${API_BASE}/products?per_page=200&page=${page}&fields=id,name,handle,description,images,variants,published`,
    { headers: TN_HEADERS }
  );
  if (!r.ok) return { data: [], total: 0 };
  const total = parseInt(r.headers.get('X-Total-Count') || '0', 10);
  const data  = await r.json();
  return { data: Array.isArray(data) ? data : [], total };
}

function mapProduct(p) {
  const name    = p.name?.es    || p.name?.pt    || Object.values(p.name    || {})[0] || '(sin nombre)';
  const handle  = p.handle?.es  || p.handle?.pt  || Object.values(p.handle  || {})[0] || null;
  const rawDesc = p.description?.es || p.description?.pt || Object.values(p.description || {})[0] || '';
  const desc    = rawDesc.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
  const images  = (p.images   || []).map(i => i.src).filter(Boolean);
  const sku     = (p.variants || [])[0]?.sku || null;
  return {
    id: p.id, name, handle, sku,
    published:   p.published ?? true,
    image_count: images.length,
    images,
    has_desc:    desc.length > 10,
    desc_length: desc.length,
    desc,
    raw_desc: rawDesc || '',
  };
}

module.exports = async (req, res) => {
  Object.entries(CORS).forEach(([k, v]) => res.setHeader(k, v));
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (!STORE_ID || !TOKEN) return res.status(500).json({ error: 'Tienda Nube no configurado' });

  // Forzar refresco con ?refresh=1
  const forceRefresh = req.query?.refresh === '1';

  if (!forceRefresh) {
    const cached = await kvGet();
    if (cached) {
      res.setHeader('X-Cache', 'HIT');
      return res.json(cached);
    }
  }

  try {
    // Primera página para saber el total
    const { data: first, total } = await fetchPage(1);
    if (!first.length) {
      const empty = { total: 0, products: [], cached_at: new Date().toISOString() };
      await kvSet(empty);
      return res.json(empty);
    }

    // Páginas restantes en paralelo
    const totalPages = Math.ceil(total / 200);
    const restPages  = Array.from({ length: totalPages - 1 }, (_, i) => i + 2);
    const rest = await Promise.all(restPages.map(p => fetchPage(p)));

    const all      = [first, ...rest.map(r => r.data)].flat();
    const products = all.map(mapProduct);
    const payload  = { total: products.length, products, cached_at: new Date().toISOString() };

    await kvSet(payload);
    res.setHeader('X-Cache', 'MISS');
    res.json(payload);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
};
