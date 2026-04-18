const STORE_ID = process.env.TIENDANUBE_STORE_ID;
const TOKEN = process.env.TIENDANUBE_TOKEN;
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
    // Traer todos los productos con paginación
    let all = [];
    let page = 1;
    while (true) {
      const r = await fetch(`${API_BASE}/products?per_page=200&page=${page}&fields=id,name,description,variants,images`, {
        headers: {
          'Authentication': `bearer ${TOKEN}`,
          'User-Agent': `BDI Catalogo (darioarevalo@arebensrl.com)`,
        }
      });
      if (!r.ok) break;
      const data = await r.json();
      if (!Array.isArray(data) || !data.length) break;
      all = all.concat(data);
      if (data.length < 200) break;
      page++;
    }

    // Construir mapa nombre_normalizado -> { imgs, desc }
    const map = {};
    for (const p of all) {
      const imgs = (p.images || []).map(i => i.src).filter(Boolean);
      const nombre = (p.name?.es || p.name?.pt || Object.values(p.name || {})[0] || '').trim().toLowerCase();
      const rawDesc = p.description?.es || p.description?.pt || Object.values(p.description || {})[0] || '';
      // Limpiar HTML de la descripción
      const desc = rawDesc.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
      const entry = { imgs, desc };
      if (nombre) map[nombre] = entry;
      if (Array.isArray(p.variants)) {
        for (const v of p.variants) {
          if (v.sku) map[v.sku.trim().toLowerCase()] = entry;
        }
      }
    }

    res.json(map);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
};
