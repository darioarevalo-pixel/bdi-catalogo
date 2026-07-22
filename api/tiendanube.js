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

    // Color de una variante = value que NO es modelo de iPhone ni talle.
    const TALLES = new Set(['s', 'm', 'l', 'xl', 'xxl', 'xs', 'xxs', 'xxxl', 'xxxxl', 'u', 'unico', 'único']);
    const esTalle = t => { const x = String(t || '').toLowerCase().trim(); return TALLES.has(x) || /^\d{1,3}$/.test(x) || x.startsWith('talle'); };
    const valEs = v => v?.es || v?.pt || (v && Object.values(v)[0]) || '';
    const colorDeVariante = v => ((v.values || []).map(valEs).filter(t => t && !/iphone/i.test(t) && !esTalle(t))[0]) || '';
    const normColor = s => String(s || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9]+/g, ' ').trim();

    // Construir mapa nombre_normalizado -> { imgs, desc, varImgByColor }
    const map = {};
    for (const p of all) {
      const imgs = (p.images || []).map(i => i.src).filter(Boolean);
      const nombre = (p.name?.es || p.name?.pt || Object.values(p.name || {})[0] || '').trim().toLowerCase();
      const rawDesc = p.description?.es || p.description?.pt || Object.values(p.description || {})[0] || '';
      // Limpiar HTML de la descripción
      const desc = rawDesc.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
      // Foto propia por color: image_id de la variante -> src de la imagen del producto.
      const imgById = {};
      (p.images || []).forEach(i => { if (i.id != null && i.src) imgById[i.id] = i.src; });
      const varImgByColor = {};
      if (Array.isArray(p.variants)) {
        for (const v of p.variants) {
          if (v.image_id == null) continue;
          const src = imgById[v.image_id];
          const c = normColor(colorDeVariante(v));
          if (src && c && !varImgByColor[c]) varImgByColor[c] = src;
        }
      }
      const entry = { imgs, desc };
      if (Object.keys(varImgByColor).length) entry.varImgByColor = varImgByColor;
      if (nombre) map[nombre] = entry;
      if (Array.isArray(p.variants)) {
        for (const v of p.variants) {
          if (v.sku) map[v.sku.trim().toLowerCase()] = entry;
        }
      }
    }

    // Las imágenes/descripciones de Tienda Nube cambian rara vez. Cacheamos en el
    // edge de Vercel: 5 min frescas + 10 min sirviendo viejas mientras se revalida.
    // Así la 2da visita (y la de otros clientes) recibe este ~1MB casi instantáneo.
    res.setHeader('Cache-Control', 'public, max-age=60, s-maxage=300, stale-while-revalidate=600');
    res.json(map);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
};
