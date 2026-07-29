const { kvGet, kvCmd } = require('./_kv');

const API_BASE = 'https://www.gestionnube.com/api/v1';
// Sin respaldo: ver la nota larga en api/config.js. Si la variable no está
// cargada, `esAdmin` da false siempre (nadie saltea los topes) en vez de que un
// pedido sin header pase por admin.
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || '';

// ---------------------------------------------------------------------------
// LISTA DE LO PERMITIDO
//
// Este proxy usa el token de Gestión Nube DE LA EMPRESA y está abierto al
// público (tiene que estarlo: lo llama el navegador de cada cliente). Sin esta
// lista, cualquiera podía pedirle CUALQUIER cosa de GN con nuestro token:
// probado el 26-jul-2026, /ventas/obtener devolvía 27.420 ventas con nombre,
// mail, teléfono y dirección de los clientes. Y como el método se reenviaba tal
// cual, también aceptaba crear/modificar/borrar.
//
// Estas 3 rutas son las ÚNICAS que se usan de verdad. Censo hecho sobre todos
// los repos, los workflows de n8n y el robot de warming:
//   GET  /productos/obtener   → catálogo público, admin, admin-zattia y bdi-mercadolibre
//   GET  /ventas/referencias  → formas de pago al armar el pedido (catálogo y admin)
//   POST /ventas              → confirmar el pedido (único que escribe, ya valida stock)
//
// Si algún día hace falta una ruta nueva, se agrega ACÁ a propósito.
// ---------------------------------------------------------------------------
const PERMITIDO = {
  GET:  new Set(['/productos/obtener', '/ventas/referencias']),
  POST: new Set(['/ventas']),
};

// _path puede venir con su propia query adentro (bdi-mercadolibre manda
// "/productos/obtener?per_page=200&page=1" codificado). Comparamos solo la ruta.
function rutaLimpia(p) {
  return String(p || '/').split('?')[0].split('#')[0].replace(/\/+$/, '') || '/';
}

const CORS = {
  'Access-Control-Allow-Origin': '*',
  // Solo lo que la lista PERMITIDO deja pasar de verdad. Antes anunciaba
  // PUT/PATCH/DELETE, que ya no se aceptan.
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, x-api-token, x-admin-password',
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

// ---------------------------------------------------------------------------
// TOPES DE STOCK (protección del depósito)
//
// El depósito es UNO SOLO: el mismo stock que ve el catálogo mayorista es el que
// alimenta la tienda online. Sin freno, un mayorista grande puede llevarse todo
// de un pedido y dejar el retail en cero. El tope es una cantidad FIJA de
// unidades por variante que el catálogo NO puede vender: `disponible = stock − tope`.
//
// Esto TIENE que estar en el servidor y no solo en la pantalla: el listado de
// productos se sirve del CDN con hasta 5 min de atraso (ver más abajo), así que
// justo después de una compra grande otro cliente todavía ve el stock viejo. Sin
// este chequeo el tope sería un cartel, no una tranca.
//
// Los topes se guardan en la misma config del KV que `apagados`/`excepciones`:
//   topes: { <product_id>: { porVariante: { <size_id>: <unidades> }, creado, stockAlCrear } }
// La clave es producto+variante porque en GN el `size_id` es un talle compartido
// entre productos (el mismo "iPhone 15 - Negro" se repite en muchos diseños).
async function leerTopes() {
  try {
    const cfg = await kvGet();
    return (cfg && cfg.topes) || {};
  } catch (e) {
    // El KV caído no puede trabar las ventas: sin topes, se vende como siempre.
    console.error('[topes] no se pudieron leer:', (e && e.message) || e);
    return {};
  }
}

function topeDe(topes, productId, sizeId) {
  const t = topes[productId] || topes[String(productId)];
  if (!t || !t.porVariante) return 0;
  const v = t.porVariante[sizeId] ?? t.porVariante[String(sizeId)];
  const n = parseInt(v, 10);
  return isNaN(n) || n < 0 ? 0 : n;
}

// ---------------------------------------------------------------------------
// EL TURNO PARA CONFIRMAR PEDIDOS
//
// Confirmar un pedido son dos pasos separados por ~2 segundos: primero le
// preguntamos el stock a GN, después le pedimos que cree la venta. Si en ese
// hueco entra un segundo pedido, GN todavía no descontó nada y los dos leen el
// mismo stock: los dos pasan, y entre los dos se llevan más de lo que había
// (o se comen el tope). Es una carrera clásica.
//
// El turno la cierra sin ponerse pesado: los pedidos se atienden de a uno. El
// segundo espera a que el primero termine y RECIÉN AHÍ pregunta el stock, ya con
// la venta anterior descontada.
//
// Los pedidos mayoristas son pocos por día, así que casi nunca hay alguien
// esperando: el costo normal son las dos anotaciones en el KV (~100 ms).
//
// Tres decisiones a propósito:
//  · VIDA 20s: la nota se borra sola. Si la función se muere a la mitad y no
//    llega a liberar el turno, nadie queda trabado para siempre. Tiene que durar
//    más que el trabajo que protege (~2-4s), por eso 20 y no 5.
//  · Si el turno sigue ocupado tras ESPERA_MAX, se sigue igual en vez de trabar
//    al cliente. Mismo criterio que el resto del archivo: preferimos la rara
//    carrera antes que un cliente que no puede comprar.
//  · Si el KV no está o falla, tampoco se traba a nadie: se vende como antes.
const TURNO_KEY = 'catalogo-turno-venta';
const TURNO_VIDA_SEG = 20;
const TURNO_ESPERA_MAX_MS = 8000;
const TURNO_REINTENTO_MS = 400;

async function tomarTurno() {
  const mio = `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
  const limite = Date.now() + TURNO_ESPERA_MAX_MS;
  for (;;) {
    let d;
    try {
      d = await kvCmd(['SET', TURNO_KEY, mio, 'NX', 'EX', TURNO_VIDA_SEG]);
    } catch (e) {
      console.error('[turno] el KV no contestó, se sigue sin turno:', (e && e.message) || e);
      return null;
    }
    if (d === null) return null;            // KV no configurado → como antes
    if (d && d.result === 'OK') return mio; // turno tomado
    if (Date.now() >= limite) {
      console.warn(`[turno] ocupado más de ${TURNO_ESPERA_MAX_MS} ms, se sigue igual`);
      return null;
    }
    await sleep(TURNO_REINTENTO_MS);
  }
}

async function liberarTurno(mio) {
  if (!mio) return;
  try {
    // Solo borramos si el turno sigue siendo NUESTRO: si ya se venció y lo tomó
    // otro pedido, borrarlo sería sacárselo de las manos.
    const g = await kvCmd(['GET', TURNO_KEY]);
    if (g && g.result === mio) await kvCmd(['DEL', TURNO_KEY]);
  } catch (e) {
    // No pasa nada: la nota se borra sola a los TURNO_VIDA_SEG.
    console.error('[turno] no se pudo liberar:', (e && e.message) || e);
  }
}

async function verificarStockServer(items, token, topes = {}) {
  // Trae todos los productos paginando y filtra localmente por los IDs del carrito.
  // GN ignora el parámetro ?id=X en /productos/obtener (siempre devuelve primeros
  // por paginación). Una sola pasada por el catálogo es lo más eficiente y correcto.
  const productIds = new Set(items.map(i => String(i.product_id)));
  const productos = {};
  const MAX_PAGINAS = 30; // safeguard contra loops infinitos

  const pedirPagina = (page) =>
    gnFetchRetry(`/productos/obtener?include_stock=1&include_variants=1&per_page=100&page=${page}`, token);

  // Se queda con los productos del carrito y devuelve la página cruda.
  const juntar = (data) => {
    const lista = Array.isArray(data) ? data : (data?.data || []);
    for (const p of lista) {
      if (productIds.has(String(p.id))) productos[p.id] = p;
    }
    return lista;
  };
  const faltan = () => productIds.size > Object.keys(productos).length;

  let completo = true; // ¿pudimos leer TODO el catálogo sin fallas?

  // Página 1: además de traer datos, nos dice cuántas páginas hay en total.
  // Si una página no se pudo leer (429/5xx tras reintentos), NO damos por
  // inexistentes los productos que faltan: abortamos y dejamos pasar la venta
  // (fail-open). Un falso "no existe" que traba al cliente es peor que un raro
  // sobre-stock (el stock igual se controla en GN).
  const r1 = await pedirPagina(1);
  if (!r1.ok) return { problemas: [], completo: false };
  const lista1 = juntar(r1.data);
  const meta1 = r1.data?.meta;
  const ultima = Math.min(parseInt(meta1?.last_page || meta1?.total_pages, 10) || 0, MAX_PAGINAS);

  if (faltan() && lista1.length > 0 && meta1?.has_more_pages !== false) {
    if (ultima > 1) {
      // El resto de las páginas EN PARALELO. Antes se pedían una tras otra: con 5
      // páginas de ~1s cada una, confirmar un pedido podía tardar 5 segundos. El
      // cliente esperaba, y ese rato es justo la ventana en la que dos pedidos
      // simultáneos leen el mismo stock. Pedirlas juntas lo baja a ~2s.
      const resp = await Promise.all(
        Array.from({ length: ultima - 1 }, (_, i) => pedirPagina(i + 2))
      );
      for (const r of resp) {
        if (!r.ok) completo = false; // una sola página caída ya invalida la verificación
        else juntar(r.data);
      }
    } else if (!ultima && lista1.length >= 100) {
      // GN no dijo cuántas páginas hay y la primera vino llena: no sabemos hasta
      // dónde ir, así que caminamos de a una como antes. Sin esto marcaríamos
      // como "no existe" todo lo que esté de la página 2 en adelante.
      for (let page = 2; page <= MAX_PAGINAS && faltan(); page++) {
        const r = await pedirPagina(page);
        if (!r.ok) { completo = false; break; }
        const lista = juntar(r.data);
        if (lista.length < 100 || r.data?.meta?.has_more_pages === false) break;
      }
    }
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
        // Lo que el catálogo puede vender = stock real − tope reservado.
        const stock = Math.max(0, stockDeVariante(variante) - topeDe(topes, item.product_id, item.size_id));
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

  // --- Portero: solo pasa lo de la lista, y solo con el método que corresponde ---
  const ruta = rutaLimpia(apiPath);
  const permitidasDelMetodo = PERMITIDO[req.method];
  if (!permitidasDelMetodo || !permitidasDelMetodo.has(ruta) || ruta.includes('..')) {
    return res.status(403).json({
      error: 'Esta consulta no está permitida.',
      detalle: `${req.method} ${ruta} no está en la lista del proxy. ` +
               'Si es una consulta nueva y legítima, hay que agregarla a PERMITIDO en api/proxy.js.',
    });
  }

  const qsObj = Object.fromEntries(Object.entries(req.query).filter(([k]) => k !== '_path'));
  const qs = new URLSearchParams(qsObj);
  const url = API_BASE + apiPath + (qs.toString() ? '?' + qs.toString() : '');

  // ¿Es un pedido? Se compara contra `ruta` (la ruta sin query) y NO contra
  // apiPath: mandando "_path=/ventas?x" el portero de arriba dejaba pasar el
  // POST igual, pero esta comparación daba false y la venta se creaba SIN
  // verificar stock ni topes.
  const esConfirmarPedido = req.method === 'POST' && ruta === '/ventas';

  // Turno: de acá hasta el `finally`, este pedido es el único que confirma.
  const turno = esConfirmarPedido ? await tomarTurno() : null;

  try {
    // Verificación de stock server-side antes de crear la venta
    if (esConfirmarPedido) {
      const items = req.body?.items || [];
      if (items.length > 0) {
        // El admin (pestaña "Cargar pedido") vende SIN tope a propósito: el dueño
        // decide caso por caso, y allá el aviso se muestra antes de confirmar.
        const esAdmin = !!ADMIN_PASSWORD && req.headers['x-admin-password'] === ADMIN_PASSWORD;
        const topes = esAdmin ? {} : await leerTopes();
        const { problemas, completo } = await verificarStockServer(items, token, topes);
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
  } finally {
    // Pase lo que pase (409 por falta de stock, error de GN, excepción), el turno
    // se libera. Si no, el próximo cliente esperaría al pedo hasta que venza.
    await liberarTurno(turno);
  }
};
