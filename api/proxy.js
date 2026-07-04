const API_BASE = 'https://www.gestionnube.com/api/v1';

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, PUT, PATCH, DELETE, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, x-api-token',
};

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

async function gnFetch(path, token) {
  const r = await fetch(API_BASE + path, {
    headers: { 'Authorization': 'Bearer ' + token, 'Content-Type': 'application/json' },
  });
  const text = await r.text();
  try { return { ok: r.ok, status: r.status, data: JSON.parse(text) }; }
  catch { return { ok: r.ok, status: r.status, data: text }; }
}

// Igual que gnFetch pero reintenta ante rate limit (429) o errores de GN (5xx),
// con backoff. Clave para verificar stock: si una página del catálogo se cae por
// saturación, NO queremos darla por vacía (eso marcaba productos como "no existe").
async function gnFetchRetry(path, token, tries = 3) {
  let last = { ok: false, status: 0, data: null };
  for (let i = 0; i < tries; i++) {
    try {
      const r = await gnFetch(path, token);
      if (r.ok) return r;
      last = r;
      if (r.status === 429 || r.status >= 500) { await sleep(300 * (i + 1)); continue; }
      return r; // otros 4xx no se reintentan
    } catch (e) {
      last = { ok: false, status: 0, data: String(e && e.message || e) };
      await sleep(300 * (i + 1));
    }
  }
  return last;
}

// Lee stock de una variante usando stock_por_tienda (formato real de GN).
// Prioriza "Deposito Minorista" si existe (es el que se descuenta al vender);
// si no hay, suma stock de todas las tiendas como fallback.
function stockDeVariante(variante) {
  if (!variante || !variante.stock_por_tienda || !variante.stock_por_tienda.length) return 0;
  const deposito = variante.stock_por_tienda.find(t => t.store_name === 'Deposito Minorista');
  if (deposito) return deposito.stock_disponible || 0;
  return variante.stock_por_tienda.reduce((s, t) => s + (t.stock_disponible || 0), 0);
}

function stockDeProducto(p) {
  // Producto SIN variantes: si tuviera stock a nivel producto, GN lo devolvería como stock_total.
  // Por seguridad también miramos available_quantity / stock por si la API cambia.
  return p.available_quantity ?? p.stock ?? p.stock_total ?? 0;
}

async function verificarStockServer(items, token) {
  // Trae todos los productos paginando y filtra localmente por los IDs del carrito.
  // GN ignora el parámetro ?id=X en /productos/obtener (siempre devuelve primeros
  // por paginación). Una sola pasada por el catálogo es lo más eficiente y correcto.
  const productIds = new Set(items.map(i => String(i.product_id)));
  const productos = {};

  let page = 1;
  let completo = true; // ¿pudimos leer TODO el catálogo sin fallas?
  while (productIds.size > Object.keys(productos).length) {
    const resp = await gnFetchRetry(`/productos/obtener?include_stock=1&include_variants=1&per_page=100&page=${page}`, token);
    // Si una página no se pudo leer (429/5xx tras reintentos), NO damos por
    // inexistentes los productos que faltan: abortamos y dejamos pasar la venta
    // (fail-open). Un falso "no existe" que traba al cliente es peor que un raro
    // sobre-stock (el stock igual se controla en GN).
    if (!resp.ok) { completo = false; break; }
    const data = resp.data;
    const lista = Array.isArray(data) ? data : (data?.data || []);
    for (const p of lista) {
      if (productIds.has(String(p.id))) productos[p.id] = p;
    }
    // Página vacía o última página → terminamos de leer el catálogo (esto SÍ es
    // fin legítimo, distinto de una página caída).
    const hasMore = lista.length > 0 &&
                    data?.meta?.has_more_pages !== false &&
                    (data?.meta?.last_page ? page < data.meta.last_page : lista.length >= 100);
    if (!hasMore) break;
    page++;
    if (page > 30) break; // safeguard contra loops infinitos
  }

  // No pudimos leer el catálogo completo → fail-open: sin problemas, que la venta pase.
  if (!completo) return { problemas: [], completo: false };

  const problemas = [];
  for (const item of items) {
    const p = productos[item.product_id];
    const qty = item.quantity || 1;

    // Producto ya no existe en GN (borrado o inactivo)
    if (!p) {
      problemas.push({
        product_id: item.product_id,
        size_id: item.size_id || null,
        nombre: null, // el frontend lo resuelve desde su carrito local
        variante: null,
        pedido: qty,
        disponible: 0,
        motivo: 'no_existe',
      });
      continue;
    }

    if (item.size_id) {
      const variante = (p.variantes || []).find(v => String(v.size_id) === String(item.size_id));
      if (!variante) {
        // Variante específica ya no existe
        problemas.push({
          product_id: item.product_id,
          size_id: item.size_id,
          nombre: p.name,
          variante: null,
          pedido: qty,
          disponible: 0,
          motivo: 'variante_no_existe',
        });
      } else {
        const stock = stockDeVariante(variante);
        if (stock < qty) {
          problemas.push({
            product_id: item.product_id,
            size_id: item.size_id,
            nombre: p.name,
            variante: variante.size_name || null,
            pedido: qty,
            disponible: stock,
          });
        }
      }
    } else {
      const stock = stockDeProducto(p);
      if (stock < qty) {
        problemas.push({
          product_id: item.product_id,
          nombre: p.name,
          variante: null,
          pedido: qty,
          disponible: stock,
        });
      }
    }
  }
  return { problemas, completo: true };
}

module.exports = async (req, res) => {
  Object.entries(CORS).forEach(([k, v]) => res.setHeader(k, v));
  // Evitar que el navegador cachee respuestas del proxy.
  // Crítico para verificar stock al confirmar pedidos: siempre debe leer
  // datos frescos de Gestión Nube, no servir respuestas viejas en disco.
  res.setHeader('Cache-Control', 'no-store, max-age=0, must-revalidate');

  if (req.method === 'OPTIONS') return res.status(204).end();

  const token = process.env.GESTIONNUBE_TOKEN;
  if (!token) return res.status(500).json({ error: 'Token no configurado en el servidor' });

  const apiPath = req.query._path || '/';
  const qsObj = Object.fromEntries(Object.entries(req.query).filter(([k]) => k !== '_path'));
  const qs = new URLSearchParams(qsObj);
  const url = API_BASE + apiPath + (qs.toString() ? '?' + qs.toString() : '');

  try {
    // Verificación de stock server-side antes de crear la venta
    if (req.method === 'POST' && apiPath === '/ventas') {
      const items = req.body?.items || [];
      if (items.length > 0) {
        const { problemas, completo } = await verificarStockServer(items, token);
        // Solo bloqueamos si pudimos verificar el catálogo COMPLETO y hay faltantes
        // reales. Si la verificación quedó incompleta (GN saturado), dejamos pasar.
        if (completo && problemas.length > 0) {
          const detalle = problemas.map(p =>
            `${p.nombre}${p.variante ? ' (' + p.variante + ')' : ''}: pedido ${p.pedido}, disponible ${p.disponible}`
          ).join('; ');
          return res.status(409).json({
            error: 'Stock insuficiente al momento de confirmar el pedido',
            detalle,
            problemas,
          });
        }
      }
    }

    const opts = {
      method: req.method,
      headers: { 'Authorization': 'Bearer ' + token, 'Content-Type': 'application/json' },
    };
    if (req.body && ['POST', 'PUT', 'PATCH'].includes(req.method)) {
      opts.body = JSON.stringify(req.body);
    }
    const r = await fetch(url, opts);
    const data = await r.text();
    res.status(r.status).setHeader('Content-Type', 'application/json').send(data);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
};
