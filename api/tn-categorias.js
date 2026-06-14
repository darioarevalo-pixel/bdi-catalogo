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
// Alias: nombres de variante que en realidad refieren a una categoría con otro nombre (normalizado)
const MODEL_ALIAS = { 'iphone17air': 'iphoneair' };

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

// Todas las categorías (id + nombre) — para el desplegable y la asignación masiva por nombre.
async function fetchAllCats(storeId, token) {
  let cats = [], page = 1;
  while (page <= 15) {
    const r = await tnGet(storeId, token, `categories?per_page=200&page=${page}&fields=id,name`);
    if (!Array.isArray(r.data) || !r.data.length) break;
    cats.push(...r.data); if (r.data.length < 200) break; page++;
  }
  return cats.map(c => ({ id: c.id, name: valEs(c.name) })).filter(c => c.name);
}
const normNombre = s => String(s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/\s+/g, ' ').trim();

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
  conStock.forEach(nm => { const k = MODEL_ALIAS[nm] || nm; if (modelCats.map[k]) deseadas.add(modelCats.map[k]); });
  // Actuales de modelo
  const actualesModelo = catActuales.filter(id => modelCats.ids.has(id));
  const agregar = [...deseadas].filter(id => !actualesModelo.includes(id));
  const quitar = actualesModelo.filter(id => !deseadas.has(id));
  // Categoría padre "Modelo de iPhone": va si hay algún modelo con stock; se saca si no hay ninguno
  const tieneParent = catActuales.includes(MODELO_PARENT);
  const quiereParent = deseadas.size > 0;
  // Nueva lista completa: no-modelo (sin el padre, que va aparte) + deseadas + padre si corresponde
  let nuevas = catActuales.filter(id => !modelCats.ids.has(id) && id !== MODELO_PARENT).concat([...deseadas]);
  if (quiereParent) nuevas.push(MODELO_PARENT);
  const agregarN = agregar.map(id => ({ id, nombre: modelCats.nombre[id] }));
  const quitarN = quitar.map(id => ({ id, nombre: modelCats.nombre[id] }));
  if (quiereParent && !tieneParent) agregarN.push({ id: MODELO_PARENT, nombre: 'Modelo de iPhone' });
  if (!quiereParent && tieneParent) quitarN.push({ id: MODELO_PARENT, nombre: 'Modelo de iPhone' });
  return {
    id: p.id, nombre,
    agregar: agregarN, quitar: quitarN,
    nuevasCategorias: nuevas,
    cambia: agregarN.length > 0 || quitarN.length > 0,
  };
}

module.exports = async (req, res) => {
  Object.entries(CORS).forEach(([k, v]) => res.setHeader(k, v));
  res.setHeader('Cache-Control', 'no-store');
  if (req.method === 'OPTIONS') return res.status(204).end();

  const storeKey = (req.query?.store || 'bdi').toLowerCase();
  const cfg = STORES[storeKey];
  if (!cfg || !cfg.storeId || !cfg.token) return res.status(500).json({ error: 'TiendaNube no configurado para ' + storeKey });

  // --- Listar todas las categorías (para el desplegable) ---
  if (req.query?.accion === 'cats') {
    try {
      const cats = await fetchAllCats(cfg.storeId, cfg.token);
      cats.sort((a, b) => a.name.localeCompare(b.name, 'es'));
      return res.status(200).json({ ok: true, categorias: cats });
    } catch (e) { return res.status(500).json({ error: e.message }); }
  }

  // --- Asignación masiva de categoría ---
  if (req.method === 'POST' && req.body && req.body.accion === 'asignar') {
    try {
      const { categoriaId, nombres, items } = req.body;

      // MODO APLICAR POR LOTES: el cliente manda items ya resueltos {id, nombre, nuevas}.
      // Así no re-leemos todos los productos en cada lote y mostramos progreso real.
      if (Array.isArray(items)) {
        let aplicados = 0; const errores = [];
        for (const m of items) {
          if (!m || !m.id || !Array.isArray(m.nuevas)) continue;
          const r = await fetch(`https://api.tiendanube.com/v1/${cfg.storeId}/products/${m.id}`, {
            method: 'PUT', headers: tnHeaders(cfg.token), body: JSON.stringify({ categories: m.nuevas }),
          });
          if (r.ok) aplicados++; else { const t = await r.text(); errores.push({ nombre: m.nombre, status: r.status, msg: t.slice(0, 150) }); }
        }
        return res.status(200).json({ ok: true, modo: 'aplicado', aplicados, errores });
      }

      // MODO PRUEBA: resolver por nombre y devolver el match (con ids) para previsualizar.
      if (!categoriaId || !Array.isArray(nombres) || !nombres.length) return res.status(400).json({ error: 'Falta categoriaId o la lista de nombres.' });
      const catId = Number(categoriaId);
      const [productos, cats] = await Promise.all([
        fetchTodosProductos(cfg.storeId, cfg.token),
        fetchAllCats(cfg.storeId, cfg.token),
      ]);
      const catObj = cats.find(c => c.id === catId);
      if (!catObj) return res.status(400).json({ error: 'La categoría seleccionada no existe.' });
      const byName = {};
      productos.forEach(p => { byName[normNombre(valEs(p.name))] = p; });
      const matched = [], noEncontrados = [], yaTenian = [];
      nombres.forEach(nm => {
        const p = byName[normNombre(nm)];
        if (!p) { noEncontrados.push(nm); return; }
        const actuales = (p.categories || []).map(c => (typeof c === 'object' ? c.id : c)).filter(Boolean);
        if (actuales.includes(catId)) { yaTenian.push(valEs(p.name)); return; }
        matched.push({ id: p.id, nombre: valEs(p.name), nuevas: [...new Set([...actuales, catId])] });
      });
      return res.status(200).json({
        ok: true, modo: 'prueba', categoria: catObj.name,
        total: nombres.length,
        matched, yaTenian, noEncontrados, // matched = objetos {id, nombre, nuevas}
      });
    } catch (e) { return res.status(500).json({ error: e.message }); }
  }

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
