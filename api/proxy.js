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
// Prioriza "Deposito Minorista" (es el que se descuenta al vender); si no hay,
// suma todas las tiendas como fallback.
//
// ⚠️ Un depósito puede venir REPETIDO. No es un error de GN: son varios renglones
// de inventario del mismo depósito para la misma variante, cada uno con su
// `inventory_id` (comprobado el 2-8-2026 en PINTED CASE / iPhone 15 Plus - BROWN:
// inventory_id 1038694 con 4 unidades y 1438922 con 0, los dos en Deposito
// Minorista). El stock real de ese depósito es la SUMA de sus renglones.
//
// Antes esto usaba `.find()`, que se queda con el primero — y GN NO devuelve los
// renglones en un orden estable: la misma variante daba 4 o 0 según la consulta.
// Un cliente podía ver "sin stock" habiendo 4, o al revés. Medido sobre las 6.726
// variantes: 7 tienen el depósito repetido y 2 cambian de valor. Sumar no infla
// nada (los otros 5 son [0,0]) y además da SIEMPRE el mismo número.
function stockDeVariante(variante) {
  if (!variante || !variante.stock_por_tienda || !variante.stock_por_tienda.length) return 0;
  const delDeposito = variante.stock_por_tienda.filter(t => t.store_name === 'Deposito Minorista');
  const filas = delDeposito.length ? delDeposito : variante.stock_por_tienda;
  return filas.reduce((s, t) => s + (t.stock_disponible || 0), 0);
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
// Se lee la config ENTERA (no solo `topes`) porque el control de precios de más
// abajo necesita las excepciones, los precios por variante y los cupones. Es la
// misma consulta al KV que ya se hacía: no agrega ni una espera.
async function leerConfigKV() {
  try {
    return (await kvGet()) || {};
  } catch (e) {
    // El KV caído no puede trabar las ventas: sin config, se vende como siempre.
    console.error('[config] no se pudo leer:', (e && e.message) || e);
    return {};
  }
}

// ---------------------------------------------------------------------------
// LA LIBRETITA DE COSTOS
//
// Para confirmar un pedido hacen falta dos cosas de cada producto: el STOCK, que
// tiene que ser del momento, y el COSTO, que solo sirve para calcular el piso de
// precio y cambia cuando alguien lo cambia a mano — no solo.
//
// Hasta el 2-8-2026 los dos salían del mismo lado: bajarse los 429 productos
// enteros (3 consultas, 1,5 MB, 2,8 s) para mirar los 5 del carrito. Ahora el
// stock se pide producto por producto (rápido) y el costo sale de acá: una copia
// que el robot de warming, que YA se baja el catálogo cada 5 minutos para
// mantenerlo caliente, deja anotada de paso.
//
// Vive en su PROPIA clave del KV y no adentro de la config a propósito: el robot
// escribe cada 5 minutos y `kvSet` pisa la config entera, así que si el robot y
// un guardado del panel se cruzaran, uno se comería al otro. Con la clave
// separada no se tocan.
//
// Que quede vieja unos minutos no afloja el control, lo endurece un poco: si un
// costo SUBIÓ y todavía tenemos el viejo, el piso queda un peso más bajo. El caso
// al revés —costo que bajó— también está cubierto, porque el precio que ve el
// cliente sale del listado cacheado, que tiene la misma antigüedad.
const COSTOS_KEY = process.env.COSTOS_KEY || 'catalog-costos';

// El robot corre cada 5 minutos. Si la libretita tiene más de 2 horas, algo pasó
// (el robot apagado, GitHub Actions caído) y no queremos seguir confiando en
// costos viejos: se vuelve al camino de siempre, que tarda 2 s pero saca los
// costos de Gestión Nube en el momento. Degradar es preferible a adivinar.
const COSTOS_VIDA_MS = 2 * 60 * 60 * 1000;

async function leerCostos() {
  try {
    const r = await kvCmd(['GET', COSTOS_KEY]);
    if (!r || !r.result) return null;
    const d = JSON.parse(r.result);
    if (!d || !d.productos) return null;
    const edad = Date.now() - Date.parse(d.actualizado);
    if (!(edad >= 0) || edad > COSTOS_VIDA_MS) {
      console.warn(`[costos] libretita vieja (${Math.round(edad / 60000)} min): se usa el catálogo entero`);
      return null;
    }
    return d;
  } catch (e) {
    console.error('[costos] no se pudo leer la libretita:', (e && e.message) || e);
    return null; // sin libretita se usa el camino de siempre
  }
}

async function guardarCostos(productos) {
  const mapa = {};
  for (const p of productos) {
    const costo = parseFloat(p.unit_cost);
    if (p && p.id != null && !isNaN(costo)) mapa[p.id] = costo;
  }
  if (!Object.keys(mapa).length) return { guardados: 0, motivo: 'ningún producto traía costo' };
  // kvCmd devuelve null cuando el KV no está configurado. Sin este chequeo el
  // robot informaba "guardados: 429" sin haber guardado nada.
  const r = await kvCmd(['SET', COSTOS_KEY, JSON.stringify({ actualizado: new Date().toISOString(), productos: mapa })]);
  if (r === null) return { guardados: 0, motivo: 'KV no configurado' };
  return { guardados: Object.keys(mapa).length };
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

// ---------------------------------------------------------------------------
// EL CAMINO RÁPIDO: preguntar por los productos del carrito, no por los 429
//
// `/productos/obtener` IGNORA todo intento de filtrar (probado el 2-8-2026 con
// id, ids, product_id y search: siempre devuelve la página entera). Por eso había
// que bajarse el catálogo completo.
//
// Pero existe `/productos/ver/{id}`, que devuelve UN producto —con su stock, en
// EXACTAMENTE el mismo formato `stock_por_tienda`— y no estaba documentada en
// ningún lado nuestro. Medido contra producción: 8 productos en paralelo tardan
// 0,43 s contra 2,76 s del catálogo entero, y 17 KB contra 1,5 MB.
//
// Lo único que NO trae es `unit_cost` (las rutas de costos que documenta la API
// devuelven 500). De ahí sale la libretita: el costo de ahí, el stock de acá.
//
// Se verificó que da los mismos números que el camino de siempre antes de
// confiarle una venta: ver el detalle en el commit.
const MAX_PRODUCTOS_CAMINO_RAPIDO = 15;

// ¿Se puede usar el camino rápido para este carrito?
// Ante la MENOR duda contesta que no, y se usa el camino de siempre. Nunca
// "dejar pasar sin verificar": eso solo pasa si TAMBIÉN falla el camino viejo.
function puedeIrPorElRapido(ids, costos) {
  if (!costos || !costos.productos) return { ok: false, motivo: 'sin libretita de costos' };
  // Más productos que esto son más consultas que las 3 del catálogo entero, y
  // encima acercan al límite de 60 por minuto de Gestión Nube.
  if (ids.length > MAX_PRODUCTOS_CAMINO_RAPIDO) return { ok: false, motivo: `carrito de ${ids.length} productos` };
  // Un producto recién creado todavía no está en la libretita: sin su costo el
  // control de precios calcularía mal el piso y rechazaría una compra buena.
  const sinCosto = ids.filter(id => costos.productos[id] === undefined);
  if (sinCosto.length) return { ok: false, motivo: `sin costo en la libretita: ${sinCosto.join(', ')}` };
  return { ok: true };
}

async function traerProductosSueltos(ids, token, costos) {
  const resp = await Promise.all(
    ids.map(id => gnFetchRetry(`/productos/ver/${encodeURIComponent(id)}?include_stock=1&include_variants=1`, token))
  );
  const productos = {};
  for (let i = 0; i < ids.length; i++) {
    const r = resp[i];
    // Una sola consulta que falle invalida el camino rápido entero: se cae al de
    // siempre. No se puede verificar "los que sí vinieron" y confiar en el resto.
    if (!r || !r.ok) return null;
    const p = (r.data && r.data.data) ? r.data.data : r.data;
    if (!p || String(p.id) !== String(ids[i])) return null; // vino otra cosa: no arriesgamos
    productos[p.id] = { ...p, unit_cost: costos.productos[ids[i]] };
  }
  return productos;
}

async function verificarStockServer(items, token, topes = {}, costos = null) {
  const productIds = new Set(items.map(i => String(i.product_id)));
  const productos = {};
  const MAX_PAGINAS = 30; // safeguard contra loops infinitos

  // --- Camino rápido -------------------------------------------------------
  const ids = [...productIds];
  const puede = puedeIrPorElRapido(ids, costos);
  if (puede.ok) {
    const sueltos = await traerProductosSueltos(ids, token, costos);
    if (sueltos) return { ...evaluar(items, sueltos, topes), completo: true, productos: sueltos, via: 'rapido' };
    console.warn('[stock] el camino rápido falló, se usa el catálogo entero');
  } else {
    console.log(`[stock] camino de siempre: ${puede.motivo}`);
  }

  // --- Camino de siempre: bajarse el catálogo entero ------------------------

  // 200 es el máximo que acepta Gestión Nube (probado el 2-8-2026: pidiendo 500 o
  // 1000 devuelve 200 igual). Con 100 el catálogo eran 5 páginas; con 200 son 3, y
  // encima una página de 200 tarda MENOS que una de 100 (1,13 s contra 1,43 s):
  // menos idas y vueltas. Va como constante y no suelto en la URL porque más abajo
  // se compara contra este mismo número para saber si una página vino llena.
  const POR_PAGINA = 200;
  const pedirPagina = (page) =>
    gnFetchRetry(`/productos/obtener?include_stock=1&include_variants=1&per_page=${POR_PAGINA}&page=${page}`, token);

  // Se queda con los productos del carrito y devuelve la página cruda.
  // De paso junta TODOS los productos vistos: si llegamos hasta acá es porque la
  // libretita de costos faltaba o estaba vieja, y estas páginas la pueden rellenar
  // sin pedir nada extra (ver `refrescarLibretita` más abajo).
  const vistos = [];
  const juntar = (data) => {
    const lista = Array.isArray(data) ? data : (data?.data || []);
    for (const p of lista) {
      if (productIds.has(String(p.id))) productos[p.id] = p;
    }
    vistos.push(...lista);
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
    } else if (!ultima && lista1.length >= POR_PAGINA) {
      // GN no dijo cuántas páginas hay y la primera vino llena: no sabemos hasta
      // dónde ir, así que caminamos de a una como antes. Sin esto marcaríamos
      // como "no existe" todo lo que esté de la página 2 en adelante.
      for (let page = 2; page <= MAX_PAGINAS && faltan(); page++) {
        const r = await pedirPagina(page);
        if (!r.ok) { completo = false; break; }
        const lista = juntar(r.data);
        if (lista.length < POR_PAGINA || r.data?.meta?.has_more_pages === false) break;
      }
    }
  }

  // No pudimos leer el catálogo completo → fail-open: sin problemas, que la venta pase.
  if (!completo) return { problemas: [], completo: false, productos };

  // AUTO-REPARACIÓN. Si caímos acá es porque la libretita faltaba o estaba vieja.
  // Estas páginas ya vienen con el costo de cada producto, así que la rellenamos
  // sin pedirle NADA extra a Gestión Nube: el próximo pedido vuelve a ser rápido.
  //
  // Hace falta porque el robot no es puntual: dice correr cada 5 minutos, pero
  // medido el 2-8-2026 corre ~1 vez por hora y hubo un hueco de 108 min. Sin esto,
  // un hueco largo dejaba el camino rápido apagado hasta que el robot se acordara.
  //
  // Se espera el guardado (no se dispara y se olvida) porque en un servidor sin
  // estado la función puede terminar antes de que la escritura salga. Son ~100 ms
  // sobre un camino que ya tardó 2 s, y solo pasa cuando la libretita no servía.
  if (!costos && vistos.length) {
    try {
      const r = await guardarCostos(vistos);
      console.log(`[costos] libretita rellenada de paso: ${r.guardados} productos`);
    } catch (e) {
      console.error('[costos] no se pudo rellenar:', (e && e.message) || e);
    }
  }

  return { ...evaluar(items, productos, topes), completo: true, productos, via: 'catalogo' };
}

// Decide qué falta, a partir de los productos ya traídos. Está aparte a propósito:
// los dos caminos (el rápido y el del catálogo entero) pasan por ESTA función, así
// que no hay forma de que uno cuente el stock distinto que el otro.
function evaluar(items, productos, topes) {
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
  return { problemas };
}

// ---------------------------------------------------------------------------
// EL PRECIO LO PONE EL NAVEGADOR (y eso hay que atajarlo)
//
// El catálogo calcula el precio en la máquina del cliente y lo manda en
// `unit_price`. Hasta el 1-8-2026 el servidor lo reenviaba a Gestión Nube tal
// cual: con la consola del navegador abierta, cualquiera podía confirmar 100
// fundas a $1 y la venta se creaba, descontando stock real.
//
// No hace falta recalcular el precio exacto (eso obliga a traer acá toda la
// lógica de la lista mejor). Alcanza con calcular el PISO: cuál es el precio más
// bajo que el catálogo pudo haber generado legítimamente para ese renglón.
//
// El piso arranca en `min(costo, mayorista)`, que es donde lo frena
// `listaMejorDesde` en index.html: el % de la lista mejor, sea 15 o 40, nunca
// baja de ahí. Después se corrige por las tres únicas cosas que SÍ pueden quedar
// por debajo, todas cargadas a propósito desde el panel:
//
//   · excepción tipo `precio` — precio fijo para un producto. Son globales (no
//     por código: config.js manda `cfg.excepciones` entero al validar cualquier
//     código), así que el servidor no necesita saber qué código usó el cliente.
//   · precio especial de variante (`variantPrices`) más bajo que el costo.
//   · un cupón vigente, que reparte su descuento entre los renglones.
//
// Los cupones se leen del KV en vivo: hoy están apagados y el piso queda entero;
// si mañana se prende uno del 30%, el margen se abre a 30% solo, sin tocar nada.
const TOLERANCIA_PORCENTAJE = 0.01; // 1% + $1 de perdón: el catálogo redondea a 2 decimales
const TOLERANCIA_PESOS = 1;

function positivo(v) {
  const n = parseFloat(v);
  return (!isNaN(n) && n > 0) ? n : 0;
}

// Cuánto puede bajar un renglón por culpa de un cupón vigente.
// Devuelve { fraccion, incierto }: `incierto` significa "no hay piso calculable".
//
// Los cupones de MONTO FIJO son siempre inciertos. El descuento se reparte solo
// entre los renglones descontables (las ofertas quedan afuera) pero la compra
// mínima se valida sobre el total CON ofertas: un carrito mayormente de ofertas
// puede dejar `descuento >= subtotalDescontable`, el factor da 0 y el renglón
// viaja a $0. Consultado con Bruno el 2-8-2026: eso es LEGÍTIMO ("si le di el
// cupón, que lo pague $0"), así que no se toca el catálogo y el control de
// precios no puede opinar mientras ese cupón esté prendido.
//
// Los de porcentaje sí acotan: el factor nunca baja de (1 − valor/100).
function aflojeDeCupones(cfg) {
  if (!cfg || cfg.mostrarCupones !== true) return { fraccion: 0, incierto: false };
  const cupones = Array.isArray(cfg.cupones) ? cfg.cupones : [];
  const ahora = new Date();
  let fraccion = 0, incierto = false;
  for (const c of cupones) {
    if (!c || c.activo === false) continue;
    if (c.vence) {
      const fin = new Date(c.vence + 'T23:59:59');
      if (!isNaN(fin.getTime()) && fin < ahora) continue; // vencido
    }
    if (c.tipo === 'porcentaje') {
      fraccion = Math.max(fraccion, Math.min(positivo(c.valor), 100) / 100);
    } else if (c.tipo === 'monto') {
      incierto = true;
    }
    // tipo 'envio' no toca precios (descuentoCupon devuelve 0)
  }
  return { fraccion: Math.min(fraccion, 1), incierto };
}

// El precio más bajo que el catálogo pudo generar para este renglón, ANTES de
// cupones. Se queda con el menor de los candidatos: si hay algo cargado a
// propósito por debajo del costo, ese manda.
function pisoDeRenglon(item, p, cfg) {
  const may = positivo(p.wholesaler_price);
  const costo = positivo(p.unit_cost);
  let piso = (costo > 0 && may > 0) ? Math.min(costo, may) : (costo || may);

  const id = item.product_id;
  const excepciones = (cfg && cfg.excepciones) || {};
  const exc = excepciones[id] || excepciones[String(id)];
  if (exc && exc.tipo === 'precio') {
    // Precio fijo puesto a mano: puede estar por debajo del costo a propósito.
    const fijo = positivo(exc.valor);
    if (fijo > 0) piso = (piso > 0) ? Math.min(piso, fijo) : fijo;
  }

  if (item.size_id !== undefined && item.size_id !== null) {
    const vp = positivo((cfg && cfg.variantPrices || {})[id + '-' + item.size_id]);
    if (vp > 0) {
      // getPrecioVariante frena en min(costo, precioDeLaVariante).
      const pisoVar = costo > 0 ? Math.min(costo, vp) : vp;
      piso = (piso > 0) ? Math.min(piso, pisoVar) : pisoVar;
    }
  }

  return piso;
}

function revisarPrecios(items, productos, cfg) {
  const { fraccion, incierto } = aflojeDeCupones(cfg);
  if (incierto) {
    // Que se vea en el registro: mientras dure el cupón de monto, el control de
    // precios queda mirando sin trabar. Si esto aparece sin cupón de monto
    // prendido, algo está mal en la config.
    console.warn('[precio] hay un cupón de MONTO FIJO activo: no se rechaza por precio (un renglón puede ir a $0 legítimamente)');
  }
  const sospechosos = [];
  for (const item of items) {
    const p = productos[item.product_id];
    if (!p) continue; // producto desconocido: ya lo maneja la verificación de stock
    const piso = pisoDeRenglon(item, p, cfg);
    if (!(piso > 0)) continue; // sin referencia de precio no se puede opinar

    // Los precios imposibles se rechazan siempre, con cupón o sin cupón: ningún
    // descuento genera un negativo ni un "abc".
    const precio = parseFloat(item.unit_price);
    if (isNaN(precio) || precio < 0) {
      sospechosos.push({ nombre: p.name, precio: item.unit_price, piso, limite: piso, grave: true });
      continue;
    }

    if (precio >= piso * (1 - TOLERANCIA_PORCENTAJE) - TOLERANCIA_PESOS) continue; // precio normal

    // Cupón de monto fijo prendido: se anota, no se traba (ver aflojeDeCupones).
    if (incierto) {
      sospechosos.push({ nombre: p.name, precio, piso, limite: 0, grave: false });
      continue;
    }

    // El límite duro: el piso aflojado por el mayor cupón de porcentaje vigente.
    // Entre el límite y el piso pasa igual, pero queda anotado: es lo esperable
    // con un cupón activo, y sin cupones es la señal de que algo hay que mirar.
    const limiteBruto = piso * (1 - fraccion);
    const limite = limiteBruto * (1 - TOLERANCIA_PORCENTAJE) - TOLERANCIA_PESOS;
    sospechosos.push({
      nombre: p.name, precio, piso,
      limite: Math.round(limiteBruto),
      grave: precio < limite,
    });
  }
  return sospechosos;
}

// ---------------------------------------------------------------------------
// FRENO A LA CANTIDAD DE PEDIDOS
//
// Confirmar un pedido crea una venta en Gestión Nube y DESCUENTA STOCK. No hacía
// falta credencial ni había límite: un script podía crear pedidos en cadena y
// dejar el depósito en cero sin comprar nada. Los topes por variante no alcanzan
// contra eso, porque cada pedido nuevo vuelve a leer el stock ya descontado.
//
// Los pedidos mayoristas reales son pocos por día y de a uno, así que un tope de
// 6 por hora por conexión no le toca el camino a nadie. El admin no cuenta: desde
// el panel se cargan varios seguidos a propósito.
//
// Si el KV no contesta, se deja pasar: el mismo criterio que el resto del archivo
// (preferimos el raro abuso antes que un cliente que no puede comprar).
const PEDIDOS_POR_HORA = 6;

function deQuienViene(req) {
  const xff = req.headers['x-forwarded-for'];
  if (xff) return String(xff).split(',')[0].trim();
  return req.headers['x-real-ip'] || 'desconocido';
}

async function pasaElFreno(req) {
  const quien = deQuienViene(req);
  if (quien === 'desconocido') return true;
  const hora = Math.floor(Date.now() / 3600000);
  const key = `catalogo-freno:${quien}:${hora}`;
  try {
    const r = await kvCmd(['INCR', key]);
    if (r === null) return true; // KV no configurado
    const n = r && r.result;
    if (n === 1) await kvCmd(['EXPIRE', key, 3600]);
    if (typeof n === 'number' && n > PEDIDOS_POR_HORA) {
      console.warn(`[freno] ${quien} lleva ${n} pedidos en la hora: se rechaza`);
      return false;
    }
    return true;
  } catch (e) {
    console.error('[freno] el KV no contestó, se deja pasar:', (e && e.message) || e);
    return true;
  }
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
      // El robot ya se trae el catálogo entero para calentar el CDN. Aprovechamos
      // ESE mismo viaje para anotar los costos: no cuesta ni una consulta más.
      const todos = [...(d1.data || [])];
      let completo = r1.ok;
      if (lastPage > 1) {
        const resto = await Promise.all(
          Array.from({ length: lastPage - 1 }, (_, i) =>
            fetch(urlPagina(i + 2)).then(r => r.ok ? r.json() : null).catch(() => null))
        );
        for (const d of resto) {
          if (!d) { completo = false; continue; }
          todos.push(...(d.data || []));
        }
      }
      // Solo se reescribe si el catálogo se leyó ENTERO. Media lectura dejaría la
      // libretita con productos de menos, y cada uno que falte manda ese pedido al
      // camino lento: preferimos la copia de hace 5 minutos antes que una a medias.
      let costos = { guardados: 0, motivo: 'lectura incompleta' };
      if (completo && todos.length) costos = await guardarCostos(todos);
      return res.status(200).json({ ok: true, pages: lastPage, productos: todos.length, costos, ms: Date.now() - t0 });
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

  // Cronómetro de la confirmación. Confirmar son varios tramos y hasta el
  // 2-8-2026 no sabíamos cuánto pesaba cada uno; en particular CREAR LA VENTA en
  // Gestión Nube, que no se puede medir sin crear una venta de verdad. Queda todo
  // en el registro para no volver a optimizar a ciegas.
  const t0 = Date.now();
  const marcas = {};
  let desde = t0;
  const marcar = (n) => { marcas[n] = Date.now() - desde; desde = Date.now(); };

  // Turno: de acá hasta el `finally`, este pedido es el único que confirma.
  const turno = esConfirmarPedido ? await tomarTurno() : null;
  if (esConfirmarPedido) marcar('turno');

  try {
    // Verificación de stock server-side antes de crear la venta
    if (esConfirmarPedido) {
      const items = req.body?.items || [];
      // El admin (pestaña "Cargar pedido") vende SIN tope a propósito: el dueño
      // decide caso por caso, y allá el aviso se muestra antes de confirmar.
      const esAdmin = !!ADMIN_PASSWORD && req.headers['x-admin-password'] === ADMIN_PASSWORD;

      if (!esAdmin && !(await pasaElFreno(req))) {
        return res.status(429).json({
          error: 'Demasiados pedidos seguidos',
          detalle: 'Se recibieron varios pedidos desde esta conexión en poco tiempo. Esperá unos minutos y volvé a intentar, o escribinos por WhatsApp.',
        });
      }

      if (items.length > 0) {
        // Config y libretita de costos EN PARALELO: son dos consultas al KV que no
        // dependen una de la otra, así que juntas cuestan lo mismo que una sola.
        const [cfg, costos] = esAdmin ? [{}, null] : await Promise.all([leerConfigKV(), leerCostos()]);
        marcar('config');
        const topes = cfg.topes || {};
        const { problemas, completo, productos, via } = await verificarStockServer(items, token, topes, costos);
        marcar('stock');
        marcas.via = via || 'catalogo';
        marcas.productos = items.length;

        // El precio que mandó el navegador, contra el del producto en Gestión Nube.
        if (!esAdmin && productos) {
          const sospechosos = revisarPrecios(items, productos, cfg);
          const graves = sospechosos.filter(s => s.grave);
          for (const s of sospechosos.filter(s => !s.grave)) {
            console.warn(`[precio] "${s.nombre}" vino a ${s.precio}, el piso es ${s.piso} y el límite ${s.limite} (pasa, queda anotado)`);
          }
          if (graves.length) {
            console.error('[precio] RECHAZADO por precio imposible:', JSON.stringify(graves));
            return res.status(400).json({
              error: 'Los precios del pedido no coinciden con los del catálogo',
              detalle: 'Recargá la página y volvé a armar el pedido. Si sigue pasando, escribinos por WhatsApp.',
            });
          }
        }

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
    if (esConfirmarPedido) marcar('precios');
    const r = await fetch(url, opts);
    const data = await r.text();
    // `via` dice por qué camino se verificó el stock: 'rapido' (por producto) o
    // 'catalogo' (el entero). Si aparece 'catalogo' seguido, el motivo está en el
    // aviso `[stock] camino de siempre: …` de más arriba. El registro sale en el
    // `finally`, para que también lo dejen los pedidos rechazados.
    if (esConfirmarPedido) marcar('crearVenta');
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
    // El cronómetro va ACÁ y no después de crear la venta: así también quedan
    // medidos los pedidos que se rechazan por precio o por stock, que antes no
    // dejaban ningún registro de tiempos. `salida` dice por dónde terminó.
    if (esConfirmarPedido) {
      console.log(`[tiempos] ${res.statusCode} en ${Date.now() - t0}ms — ${JSON.stringify(marcas)}`);
    }
  }
};
