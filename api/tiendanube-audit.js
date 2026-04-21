const STORE_ID = process.env.TIENDANUBE_STORE_ID;
const TOKEN    = process.env.TIENDANUBE_TOKEN;
const API_BASE = `https://api.tiendanube.com/v1/${STORE_ID}`;

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

module.exports = async (req, res) => {
  Object.entries(CORS).forEach(([k, v]) => res.setHeader(k, v));
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (!STORE_ID || !TOKEN) return res.status(500).json({ error: 'Tienda Nube no configurado' });

  try {
    let all = [];
    let page = 1;
    while (true) {
      const r = await fetch(
        `${API_BASE}/products?per_page=200&page=${page}&fields=id,name,handle,description,images,variants,published`,
        { headers: { 'Authentication': `bearer ${TOKEN}`, 'User-Agent': 'BDI Catalogo (darioarevalo@arebensrl.com)' } }
      );
      if (!r.ok) break;
      const data = await r.json();
      if (!Array.isArray(data) || !data.length) break;
      all = all.concat(data);
      if (data.length < 200) break;
      page++;
    }

    const products = all.map(p => {
      const name    = p.name?.es || p.name?.pt || Object.values(p.name || {})[0] || '(sin nombre)';
      const rawDesc = p.description?.es || p.description?.pt || Object.values(p.description || {})[0] || '';
      const desc    = rawDesc.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
      const images  = (p.images || []).map(i => i.src).filter(Boolean);
      const sku     = (p.variants || [])[0]?.sku || null;

      const handle = p.handle?.es || p.handle?.pt || Object.values(p.handle || {})[0] || null;

      return {
        id:          p.id,
        name,
        handle,
        sku,
        published:   p.published ?? true,
        image_count: images.length,
        images,
        has_desc:    desc.length > 10,
        desc_length: desc.length,
      };
    });

    res.json({ total: products.length, products });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
};
