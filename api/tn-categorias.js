// Auto-categorización por modelo de iPhone según stock (BDI).
// GET  → modo PRUEBA: calcula y devuelve el reporte de cambios, sin tocar nada (solo lee).
// POST → APLICA los cambios en TiendaNube (necesita token con write_products).
//
// Regla: para cada producto, cada categoría de modelo (subcategoría de "Modelo de iPhone")
// debe estar SI alguna variante de ese modelo tiene stock; si ninguna tiene, se quita.
// Las categorías que no son de modelo no se tocan.

const STORES = {
  bdi:    { storeId: process.env.TIENDANUBE_STORE_ID,        token: process.env.TIENDANUBE_TOKEN },
  zattia: { storeId: process.env.TIENDANUBE_STORE_ID_ZATTIA, token: process.env.TIENDANUBE_TOKEN_ZATTIA },
};
const MODELO_PARENT = 36220324; // categoría padre "Modelo de iPhone" (BDI)

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};
function tnHeaders(token) {
  return { 'Authentication': `bearer ${token}`, 'User-Agent': 'Monitor Areben (brunoarevalo@arebensrl.com)', 'Content-Type': 'application/json' };
}
const valEs = v => v?.es || (v && Object.values(v)[0]) || '';
const norm = s => String(s || '').toLowerCase().replace(/[^a-z0-9]/g, ''); // p/ matchear modelos

// De una variante saca los nombres de modelo (maneja "12 / 12 Pro" → ["iPhone 12","iPhone 12 Pro"])
function modelosDeVariante(variant) {
  const out = [];
  (variant.values || []).forEach(v => {
    const txt = valEs(v);
    if (/iphone/i.test(txt)) {
      const resto = txt.replace(/^.*?iphone/i, '').trim(); // lo que sigue a "iPhone"
      resto.split('/').map(p => p.trim()).filter(Boolean).forEach(p => out.push('iPhone ' + p));
    }
  });
  return out;
}

async function tnGet(storeId, token, path) {
  const r = await fetch(`https://api.tiendanube.com/v1/${storeId}/${path}`, { headers: tnHeaders(token) });
  const total = parseInt(r.headers.get('X-Total-Count') || '0', 10);
  const data = await r.json();
  return { ok: r.ok, status: r.status, data, total };
}

async function fetchTodosProductos(storeId, token) {
  const first = await tnGet(storeId, token, 'products?per_page=200&page=1&fields=id,name,categories,variants');
  if (!Array.isArray(first.data)) throw new Error('No se pudieron leer productos: ' + JSON.stringify(first.data).slice(0, 200));
  let all = [...first.data];
  const totalPages = Math.ceil((first.total || first.data.length) / 200);
  for (let p = 2; p <= totalPages && p <= 30; p++) {
    const res = await tnGet(storeId, token, `products?per_page=200&page=${p}&fields=id,name,categories,variants`);
    if (Array.isArray(res.data)) all.push(...res.data);
  }
  return all;
}

async function fetchModelCats(storeId, token) {
  // Subcategorías de "Modelo de iPhone": normName → id, y el set de ids de modelo
  let cats = [], page = 1;
  while (page <= 10) {
    const r = await tnGet(storeId, token, `categories?per_page=200&page=${page}&fields=id,name,parent`);
    if (!Array.isArray(r.data) || !r.data.length) break;
    cats.push(...r.data); if (r.data.length < 200) break; page++;
  }
  const map = {}, ids = new Set(), nombre = {};
  cats.filter(c => c.parent === MODELO_PARENT).forEach(c => {
    const nm = valEs(c.name);
    map[norm(nm)] = c.id; ids.add(c.id); nombre[c.id] = nm;
  });
  return { map, ids, nombre };
}

function calcularProducto(p, modelCats) {
  const nombre = valEs(p.name);
  const catActuales = (p.categories || []).map(c => (typeof c === 'object' ? c.id : c)).filter(Boolean);
  // Modelos con stock
  const conStock = new Set();
  (p.variants || []).forEach(v => {
    const st = v.stock; // null = sin gestión de stock (lo tratamos como con stock)
    if (st === null || st > 0) modelosDeVariante(v).forEach(m => conStock.add(norm(m)));
  });
  // Categorías de modelo deseadas (las que tienen stock y existen como categoría)
  const deseadas = new Set();
  conStock.forEach(nm => { if (modelCats.map[nm]) deseadas.add(modelCats.map[nm]); });
  // Actuales de modelo
  const actualesModelo = catActuales.filter(id => modelCats.ids.has(id));
  const agregar = [...deseadas].filter(id => !actualesModelo.includes(id));
  const quitar = actualesModelo.filter(id => !deseadas.has(id));
  // Nueva lista completa: no-modelo + deseadas
  const nuevas = catActuales.filter(id => !modelCats.ids.has(id)).concat([...deseadas]);
  return {
    id: p.id, nombre,
    agregar: agregar.map(id => ({ id, nombre: modelCats.nombre[id] })),
    quitar: quitar.map(id => ({ id, nombre: modelCats.nombre[id] })),
    nuevasCategorias: nuevas,
    cambia: agregar.length > 0 || quitar.length > 0,
  };
}

module.exports = async (req, res) => {
  Object.entries(CORS).forEach(([k, v]) => res.setHeader(k, v));
  res.setHeader('Cache-Control', 'no-store');
  if (req.method === 'OPTIONS') return res.status(204).end();

  const storeKey = (req.query?.store || 'bdi').toLowerCase();
  const cfg = STORES[storeKey];
  if (!cfg || !cfg.storeId || !cfg.token) return res.status(500).json({ error: 'TiendaNube no configurado para ' + storeKey });
  const aplicar = req.method === 'POST';

  try {
    const [productos, modelCats] = await Promise.all([
      fetchTodosProductos(cfg.storeId, cfg.token),
      fetchModelCats(cfg.storeId, cfg.token),
    ]);
    const analizados = productos.map(p => calcularProducto(p, modelCats));
    const conCambios = analizados.filter(a => a.cambia);

    let aplicados = 0, errores = [];
    if (aplicar) {
      for (const a of conCambios) {
        const r = await fetch(`https://api.tiendanube.com/v1/${cfg.storeId}/products/${a.id}`, {
          method: 'PUT', headers: tnHeaders(cfg.token), body: JSON.stringify({ categories: a.nuevasCategorias }),
        });
        if (r.ok) aplicados++; else { const t = await r.text(); errores.push({ id: a.id, nombre: a.nombre, status: r.status, msg: t.slice(0, 150) }); }
      }
    }

    return res.status(200).json({
      store: storeKey,
      modo: aplicar ? 'aplicado' : 'prueba',
      total_productos: productos.length,
      total_con_cambios: conCambios.length,
      total_agregados: conCambios.reduce((s, a) => s + a.agregar.length, 0),
      total_quitados: conCambios.reduce((s, a) => s + a.quitar.length, 0),
      aplicados, errores,
      detalle: conCambios.map(a => ({
        id: a.id, nombre: a.nombre,
        agregar: a.agregar.map(x => x.nombre),
        quitar: a.quitar.map(x => x.nombre),
      })),
      generado: new Date().toISOString(),
    });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
};
