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
            // El nombre de la variante en GN viene en `.size` (color/modelo);
            // `size_name` no existe en esta API, por eso antes salía vacío.
            variante: variante.size || variante.size_name || null,
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

  // Modo "calentar la copia" (lo llama un robot de GitHub Actions cada ~5 min).
  // Toca todas las páginas del catálogo a través de la MISMA URL pública que usa
  // el navegador, para que el CDN guarde/renueve esas copias y el cliente casi
  // nunca pague el viaje lento a Gestión Nube al abrir. No necesita el token de
  // GN: cada página que pide pasa por este mismo proxy, que sí lo usa.
  if (req.query.warm !== undefined) {
    const t0 = Date.now();
    try {
      const host = req.headers['x-forwarded-host'] || req.headers.host;
      if (!host) return res.status(500).json({ ok: false, error: 'sin host' });
      const proto = (req.headers['x-forwarded-proto'] || 'https').split(',')[0];
      const base = `${proto}://${host}`;
      // Debe coincidir EXACTO con cargarProductos() en index.html: la copia del
      // CDN se identifica por la URL completa.
      const baseQs = 'per_page=100&include_stock=1&include_images=1&include_variants=1';
      const pathEnc = encodeURIComponent('/productos/obtener');
      const urlPagina = (page) => `${base}/api/proxy?_path=${pathEnc}&${baseQs}&page=${page}`;
      const r1 = await fetch(urlPagina(1));
      const d1 = await r1.json().catch(() => ({}));
      let lastPage = d1.meta ? (d1.meta.last_page || d1.meta.total_pages || 1) : 1;
      if (lastPage > 20) lastPage = 20;
      if (lastPage > 1) {
        await Promise.all(
          Array.from({ length: lastPage - 1 }, (_, i) => fetch(urlPagina(i + 2)).catch(() => null))
        );
      }
      return res.status(200).json({ ok: true, pages: lastPage, ms: Date.now() - t0 });
    } catch (e) {
      return res.status(500).json({ ok: false, error: e.message, ms: Date.now() - t0 });
    }
  }

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
    // Cacheo en el CDN de Vercel SOLO para la lista de productos (lectura pura,
    // se usa para mostrar el catálogo). El navegador igual revalida (max-age=0),
    // pero el CDN sirve una copia compartida hasta 60s → abrir el catálogo es
    // casi instantáneo y no se golpea Gestión Nube en cada visita/recarga.
    // stale-while-revalidate=300: si la copia venció, sirve la vieja al instante
    // y refresca por detrás (nadie espera). El stock REAL se re-verifica aparte
    // al confirmar el pedido (POST /ventas, sin caché), así que una copia de
    // hasta 60s es segura: nunca deja pasar una venta sin stock.
    if (req.method === 'GET' && apiPath === '/productos/obtener' && r.status === 200) {
      // s-maxage=300: copia "fresca" 5 min. stale-while-revalidate=86400: durante
      // las 24 h siguientes se sigue sirviendo AL INSTANTE mientras se refresca por
      // detrás (nadie espera). Clave: mientras alguien entre al menos una vez por
      // día, la copia nunca se enfría del todo → recargas siempre rápidas, sin
      // depender de que el robot caliente el servidor justo. El stock puede quedar
      // hasta ~5 min viejo, pero es seguro: se re-verifica en vivo al confirmar.
      res.setHeader('Cache-Control', 'public, s-maxage=300, stale-while-revalidate=86400, max-age=0');
    }
    res.status(r.status).setHeader('Content-Type', 'application/json').send(data);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
};
