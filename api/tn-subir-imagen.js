// Carga de imágenes a TiendaNube (BDI/Zattia).
// GET  ?store=bdi&productos=1 → lista de productos (id, name, sku, colores) para los selectores.
// POST {store, product_id, image (dataURL base64), filename, color?} → sube la imagen al producto
//      y, si se pasa color, la asigna a las variantes de ese color.
const STORES = {
  bdi:    { storeId: process.env.TIENDANUBE_STORE_ID,        token: process.env.TIENDANUBE_TOKEN },
  zattia: { storeId: process.env.TIENDANUBE_STORE_ID_ZATTIA, token: process.env.TIENDANUBE_TOKEN_ZATTIA },
};
const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};
function tnH(token) { return { 'Authentication': `bearer ${token}`, 'User-Agent': 'Monitor Areben (brunoarevalo@arebensrl.com)', 'Content-Type': 'application/json' }; }
const valEs = v => v?.es || (v && Object.values(v)[0]) || '';
// Talles (no son colores): se excluyen para que la imagen vaya por color, no por talle
const TALLES = new Set(['s', 'm', 'l', 'xl', 'xxl', 'xs', 'xxs', 'xxxl', 'xxxxl', 'u', 'unico', 'único']);
const _esTalle = t => { const x = String(t || '').toLowerCase().trim(); return TALLES.has(x) || /^\d{1,3}$/.test(x) || x.startsWith('talle'); };
// El "color" de una variante = value que NO es modelo de iPhone NI talle
const coloresDeVariante = v => (v.values || []).map(valEs).filter(t => t && !/iphone/i.test(t) && !_esTalle(t));

const sleep = ms => new Promise(r => setTimeout(r, ms));
// fetch a TN con reintento ante 429 (rate limit) y 5xx, respetando Retry-After. Sin esto,
// al subir varias fotos seguidas TN rechaza los PUT de vinculación y la foto queda sin color.
async function tnReq(url, opts, retries = 5) {
  for (let a = 1; a <= retries; a++) {
    const r = await fetch(url, opts);
    if ((r.status === 429 || r.status >= 500) && a < retries) {
      const ra = parseInt(r.headers.get('Retry-After') || '0', 10);
      await sleep(ra > 0 ? ra * 1000 : Math.min(1200 * a, 5000));
      continue;
    }
    return r;
  }
}
async function tnGet(storeId, token, path) {
  const r = await tnReq(`https://api.tiendanube.com/v1/${storeId}/${path}`, { headers: tnH(token) });
  return { ok: r.ok, status: r.status, total: parseInt(r.headers.get('X-Total-Count') || '0', 10), data: await r.json() };
}
// Vincula una imagen (imageId) a todas las variantes de un color. Reintenta y throttlea para no saturar.
async function asignarColor(cfg, product_id, imageId, color) {
  const vr = await tnGet(cfg.storeId, cfg.token, `products/${product_id}/variants?fields=id,values`);
  if (!Array.isArray(vr.data)) return { objetivo: 0, asignadas: 0, errores: ['no se pudieron leer variantes'] };
  const objetivo = vr.data.filter(v => coloresDeVariante(v).some(c => c.toLowerCase() === String(color).toLowerCase()));
  let asignadas = 0; const errores = [];
  for (const v of objetivo) {
    const pr = await tnReq(`https://api.tiendanube.com/v1/${cfg.storeId}/products/${product_id}/variants/${v.id}`, {
      method: 'PUT', headers: tnH(cfg.token), body: JSON.stringify({ image_id: imageId }),
    });
    if (pr.ok) asignadas++; else errores.push(`v${v.id}:${pr.status}`);
    await sleep(300); // no saturar el rate limit de TN
  }
  return { objetivo: objetivo.length, asignadas, errores };
}

module.exports = async (req, res) => {
  Object.entries(CORS).forEach(([k, v]) => res.setHeader(k, v));
  res.setHeader('Cache-Control', 'no-store');
  if (req.method === 'OPTIONS') return res.status(204).end();

  const store = (req.query?.store || 'bdi').toLowerCase();
  const cfg = STORES[store];
  if (!cfg || !cfg.storeId || !cfg.token) return res.status(500).json({ error: 'TiendaNube no configurado para ' + store });

  try {
    if (req.method === 'GET') {
      // Listar productos con sus colores (para los selectores)
      let all = [], page = 1;
      const first = await tnGet(cfg.storeId, cfg.token, 'products?per_page=200&page=1&fields=id,name,variants');
      if (!Array.isArray(first.data)) return res.status(500).json({ error: 'No se pudieron leer productos', body: first.data });
      all.push(...first.data);
      const tp = Math.ceil((first.total || first.data.length) / 200);
      for (page = 2; page <= tp && page <= 30; page++) {
        const r = await tnGet(cfg.storeId, cfg.token, `products?per_page=200&page=${page}&fields=id,name,variants`);
        if (Array.isArray(r.data)) all.push(...r.data);
      }
      const productos = all.map(p => {
        const colores = [...new Set((p.variants || []).flatMap(coloresDeVariante))];
        return { id: p.id, name: valEs(p.name), sku: (p.variants || [])[0]?.sku || null, colores };
      }).sort((a, b) => a.name.localeCompare(b.name, 'es'));
      return res.status(200).json({ store, total: productos.length, productos });
    }

    if (req.method === 'POST') {
      const body = req.body || {};
      const { product_id, image, filename, color, action, image_id } = body;
      if (!product_id) return res.status(400).json({ error: 'Falta product_id' });

      // Acción "link": vincular una imagen YA subida a las variantes de un color (sin re-subir → sin duplicar)
      if (action === 'link') {
        if (!image_id || !color) return res.status(400).json({ error: 'Faltan image_id o color' });
        const r = await asignarColor(cfg, product_id, image_id, color);
        return res.status(200).json({ ok: true, image_id, color, variantesObjetivo: r.objetivo, variantesAsignadas: r.asignadas, linkErrores: r.errores });
      }

      if (!image) return res.status(400).json({ error: 'Falta image' });
      const base64 = String(image).includes(',') ? String(image).split(',')[1] : String(image);
      // 1) Subir la imagen al producto (con reintentos ante rate limit)
      const up = await tnReq(`https://api.tiendanube.com/v1/${cfg.storeId}/products/${product_id}/images`, {
        method: 'POST', headers: tnH(cfg.token), body: JSON.stringify({ attachment: base64, filename: filename || ('foto-' + product_id + '.jpg') }),
      });
      const upBody = await up.json();
      if (!up.ok) return res.status(up.status).json({ error: 'Error subiendo imagen', detalle: upBody });
      const imageId = upBody.id;
      // 2) Si hay color, asignar la imagen a las variantes de ese color (con reintentos/throttle)
      let r = { objetivo: 0, asignadas: 0, errores: [] };
      if (color) r = await asignarColor(cfg, product_id, imageId, color);
      return res.status(200).json({ ok: true, image_id: imageId, color: color || null, variantesObjetivo: r.objetivo, variantesAsignadas: r.asignadas, linkErrores: r.errores });
    }

    return res.status(405).json({ error: 'Método no permitido' });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
};

// redeploy 1780964452
