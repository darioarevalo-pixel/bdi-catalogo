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

// ---------------------------------------------------------------------------
// EL TABLERO: cuánto cupo nos queda en Gestión Nube
//
// GN manda el límite y el saldo en CADA respuesta, y nunca los habíamos mirado:
// veníamos manejando sin tablero. Anotarlos cuesta cero consultas y contesta dos
// preguntas que hoy no podemos responder:
//
//  · ¿Cuánto es el límite HOY? El 3-8-2026 medimos 60 por minuto, pero para el
//    12-8-2026 GN ya había cambiado su manejo de límites (antes contestaba un 500
//    con HTML al saturarse; ahora contesta un 429 con mensaje en español). Cuando
//    alguien reescribe eso, es normal que también cambie el número o la forma de
//    contar. Este registro lo dice en vez de suponerlo.
//
//  · ¿Quién se está comiendo el cupo? El 12-8 hubo clientes que no podían ni ver
//    el catálogo 20 MINUTOS ANTES de que apareciera ningún carrito grande, así que
//    algo lo estaba gastando por su cuenta. Si el saldo aparece bajo en un momento
//    sin ventas, el consumo viene de otro lado (otro sistema pegándole a GN desde
//    la misma dirección), no del catálogo.
//
// Solo se avisa cuando el saldo está para preocuparse, para no llenar el registro.
let ultimoSaldo = null;
let ultimoLimite = null;

function anotarSaldo(headers) {
  const saldo = parseInt(headers.get('X-RateLimit-Remaining') || '', 10);
  const limite = parseInt(headers.get('X-RateLimit-Limit') || '', 10);
  if (!isNaN(saldo)) ultimoSaldo = saldo;
  if (!isNaN(limite)) ultimoLimite = limite;
  if (!isNaN(saldo) && !isNaN(limite) && saldo <= Math.max(5, Math.floor(limite / 4))) {
    console.warn(`[cupo] queda poco: ${saldo} de ${limite}`);
  }
}

// Cuánto pide esperar GN. Viene en la cabecera `Retry-After` (comprobado el
// 12-8-2026: llegó con 8) y también puede venir como `retry_after` DENTRO del
// JSON, que es como lo nombró Eugenio. Se miran los dos: si mañana dejan solo
// uno, seguimos obedeciendo igual.
//
// El número VARÍA a propósito y por eso no se puede reemplazar por una espera
// fija: ~1 segundo si fue un exceso puntual, hasta ~60 con presión sostenida.
function cuantoEsperar(headers, data) {
  const candidatos = [
    headers.get('Retry-After'),
    data && typeof data === 'object' ? (data.retry_after ?? data.retryAfter) : null,
  ];
  for (const c of candidatos) {
    const n = parseInt(c ?? '', 10);
    if (!isNaN(n) && n > 0) return n;
  }
  return 0;
}

async function gnFetch(path, token) {
  await esperarTurnoDeRitmo();
  const r = await fetch(API_BASE + path, {
    headers: { 'Authorization': 'Bearer ' + token, 'Content-Type': 'application/json' },
  });
  const text = await r.text();
  anotarSaldo(r.headers);
  let data = text;
  try { data = JSON.parse(text); } catch { /* GN a veces contesta HTML */ }
  return { ok: r.ok, status: r.status, data, esperaSeg: cuantoEsperar(r.headers, data) };
}

// Cuánto esperamos como mucho a que GN se libere. GN puede pedir hasta ~60 s
// cuando hay presión sostenida, y nadie mira una rueda girando un minuto: pasado
// este tope se corta y se avisa, que es más honesto.
//
// Son dos topes distintos a propósito:
//  · LEER el stock: 4 s. Si no se pudo leer, el pedido no se frena — hay
//    fail-open más abajo — así que estirar la espera no compra nada.
//  · CREAR la venta: 10 s. Acá ya está todo verificado y lo único que falta es
//    que GN la tome; perder la venta por no esperar 8 segundos sale carísimo.
//    Entra cómodo en los 30 s que Vercel le da a esta función.
const ESPERA_MAX_MS = 4000;
const ESPERA_MAX_VENTA_MS = 10000;

// Igual que gnFetch pero reintenta ante rate limit (429) o errores de GN (5xx).
// Clave para verificar stock: si una página del catálogo se cae por saturación,
// NO queremos darla por vacía (eso marcaba productos como "no existe").
//
// ⚠️ El backoff era de 300 ms y 600 ms, y eso EMPEORABA el problema. Comprobado
// en producción el 12-8-2026: un carrito de 43 renglones disparó 15 consultas en
// paralelo que, con reintentos, se volvieron ~45 en dos segundos. El cliente
// (Facundo Villafaña, $152.930) reintentó 6 veces y las 6 fallaron; cada
// reintento alimentaba el corte que lo estaba bloqueando.
//
// Ahora se le hace caso a GN: si dice cuánto esperar, se espera ESO. Y si lo que
// pide es más de lo que un cliente tolera mirando la pantalla, se corta el
// reintento y se devuelve el 429 para avisarle bien (mismo criterio que
// api/tn-subir-imagen.js, que ya lo hacía con TiendaNube).
async function gnFetchRetry(path, token, tries = 3) {
  let last = { ok: false, status: 0, data: null };
  for (let i = 0; i < tries; i++) {
    try {
      const r = await gnFetch(path, token);
      if (r.ok) return r;
      last = r;
      if (r.status === 429 || r.status >= 500) {
        // Lo que pide GN, o 1s / 2s si no dijo nada (backoff exponencial: 0,3 s
        // era demasiado poco para un límite que se cuenta por minuto).
        const espera = r.esperaSeg ? r.esperaSeg * 1000 : 1000 * Math.pow(2, i);
        if (espera > ESPERA_MAX_MS) return r; // no vale la pena: que avise arriba
        await sleep(espera);
        continue;
      }
      return r; // otros 4xx no se reintentan
    } catch (e) {
      last = { ok: false, status: 0, data: String(e && e.message || e) };
      await sleep(1000 * Math.pow(2, i));
    }
  }
  return last;
}

// ---------------------------------------------------------------------------
// EL RITMO: ~800 ms entre consultas, nunca ráfagas
//
// 🔴 Confirmado por Eugenio (dueño de GN) el 12-8-2026: **el techo es por
// SEGUNDO, ~2 consultas**. NO es un cupo por minuto. Medido contra producción:
// a 1,8/seg corta al 5º pedido; a 1,28/seg pasan 20 seguidos limpios.
//
// Por eso este archivo pasó por dos arreglos el mismo día y el primero se quedó
// corto: cambiar la ráfaga de 15 por tandas de 4 sigue siendo el DOBLE del techo.
// Contra un límite por segundo no alcanza con "menos de golpe": hay que ir al
// ritmo. 800 ms da 1,25/seg, que es el ritmo medido como seguro.
//
// Las tareas se LANZAN escalonadas y se esperan juntas: no se espera a que una
// termine para largar la siguiente. Así el ritmo de salida es el correcto sin
// pagar la latencia de cada consulta en fila india.
//
// ⚠️ El techo se comparte por CUENTA, no por dirección de internet (también lo
// corrigió Eugenio). O sea: el Monitor, los scripts y este catálogo se pisan
// entre ellos aunque corran en máquinas distintas. Nuestro ritmo puede estar
// bien y rebotar igual porque otro está ocupando el lugar — razón de más para
// pedir lo mínimo y obedecer el `retry_after`.
const MS_ENTRE_CONSULTAS = 800;

// El regulador va ADENTRO de `gnFetch` y del envío de la venta, o sea en el único
// lugar por donde se sale hacia GN. La primera versión espaciaba en cada sitio que
// hacía varias consultas, y se le escapó justo la más cara: el pedido que CREA la
// venta salía pegado a la última consulta de stock — 3 en el mismo segundo, sobre
// el techo de 2. Lo cazó una prueba. Con el regulador acá, no hay forma de que un
// camino nuevo se olvide de pedir turno.
//
// Reserva turnos en vez de mirar el reloj: si tres consultas piden turno a la vez,
// se van a las 0 ms, 800 ms y 1600 ms en lugar de creerse las tres que "pasó
// tiempo suficiente" y salir juntas.
let proximoTurno = 0;

async function esperarTurnoDeRitmo() {
  const ahora = Date.now();
  const turno = Math.max(ahora, proximoTurno);
  proximoTurno = turno + MS_ENTRE_CONSULTAS;
  if (turno > ahora) await sleep(turno - ahora);
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
// ⚠️ Estuvo en 15 hasta el 12-8-2026, contradiciendo el comentario de acá abajo:
// 15 consultas son CINCO VECES las 3 del catálogo entero, no menos. Con carritos
// mayoristas (que tienen muchos renglones pero se cuentan por producto distinto)
// el camino "rápido" gastaba más límite del que ahorraba, chocaba, y encima caía
// igual al catálogo entero: lo peor de los dos.
//
// 🔴 Y con el techo REAL de GN (~2 consultas por segundo, confirmado por Eugenio
// el 12-8-2026) el atajo dejó de ser atajo. Al ritmo obligado de 800 ms:
//   · camino rápido con N productos ≈ N × 0,8 s
//   · catálogo entero = 3 páginas ≈ 2,7 s, sin importar el tamaño del carrito
// O sea que a partir de 4 productos el "rápido" TARDA MÁS que el largo. La
// medición vieja que lo justificaba (8 en paralelo en 0,43 s) valía cuando
// creíamos que se podía disparar en paralelo; no se puede.
//
// Queda en 3: ahí todavía gana un poco de tiempo y sobre todo mueve 17 KB en vez
// de 1,5 MB. Arriba de eso manda el camino de siempre.
const MAX_PRODUCTOS_CAMINO_RAPIDO = 3;

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
  // Se piden juntas y el regulador de `gnFetch` las va soltando al ritmo que GN
  // aguanta (~800 ms). Acá no hay que espaciar nada a mano.
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

  // Normalmente se corta apenas están todos los productos del carrito. PERO si no
  // hay libretita de costos, se leen TODAS las páginas a propósito: son las que
  // van a rellenarla, y con media lectura quedaría a medias (comprobado en
  // producción el 3-8-2026: rellenó 200 de 429 y los otros 229 seguían cayendo al
  // camino lento). Son 2 consultas de más, UNA sola vez, y deja el camino rápido
  // andando para todos los pedidos siguientes.
  const hayQueLeerTodo = faltan() || !costos;
  if (hayQueLeerTodo && lista1.length > 0 && meta1?.has_more_pages !== false) {
    if (ultima > 1) {
      // El resto de las páginas EN PARALELO. Antes se pedían una tras otra: con 5
      // páginas de ~1s cada una, confirmar un pedido podía tardar 5 segundos. El
      // cliente esperaba, y ese rato es justo la ventana en la que dos pedidos
      // simultáneos leen el mismo stock. Pedirlas juntas lo baja a ~2s.
      // Se piden juntas; el regulador de `gnFetch` las espacia (~800 ms).
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
      for (let page = 2; page <= MAX_PAGINAS && (faltan() || !costos); page++) {
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
    // Se compara contra el total que declara GN: una libretita a medias es peor
    // que ninguna, porque cada producto que falte manda ese pedido al camino
    // lento igual y encima nadie se entera de que quedó incompleta.
    const totalGN = parseInt(meta1?.total, 10);
    if (totalGN > 0 && vistos.length < totalGN) {
      console.warn(`[costos] no se rellena: se leyeron ${vistos.length} de ${totalGN} productos`);
    } else {
      try {
        const r = await guardarCostos(vistos);
        console.log(`[costos] libretita rellenada de paso: ${r.guardados} de ${vistos.length} productos leídos`);
      } catch (e) {
        console.error('[costos] no se pudo rellenar:', (e && e.message) || e);
      }
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
// baja de ahí. Ese es el truco que evita que el servidor tenga que saber QUÉ
// código usó el cliente.
//
// ⚠️ SALVO QUE EL PRODUCTO NO TENGA COSTO CARGADO. Ahí el truco se queda sin nada
// de qué agarrarse y los dos lados hacían cosas opuestas (medido el 3-8-2026):
//   · la pantalla: `piso = cost > 0 ? min(cost, publico) : 0` → sin costo NO hay
//     piso, así que aplica el −15% completo;
//   · el servidor: `costo || may` → el piso quedaba en el MAYORISTA ENTERO.
// Resultado: el cliente CON CÓDIGO armaba el pedido, apretaba confirmar y le
// saltaba "los precios no coinciden con el catálogo", sin nada que pudiera hacer.
// Sin código no pasa (se cobra el mayorista entero y el servidor lo acepta).
//
// Hoy no explota porque los 47 productos sin costo tampoco tienen precio
// mayorista, así que están ocultos; explota en el próximo ingreso de mercadería,
// que es justo cuando entra un producto con el precio puesto y el costo todavía no.
//
// El arreglo: cuando no hay costo, el piso se calcula por el otro lado —el
// mayorista MENOS el mejor descuento que la lista mejor pueda llegar a hacer— que
// es exactamente lo que ya se hace con los cupones más abajo. Sigue rechazando el
// pedido de $1 y deja pasar el de −15%.
//
// Después se corrige por las tres únicas cosas que SÍ pueden quedar
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

// Cuánto puede bajar un precio por la LISTA MEJOR (el descuento del código), en
// tanto por uno. Solo se usa para los productos SIN COSTO CARGADO: con costo, el
// piso sale del costo y este número no hace falta.
//
// Se toma el descuento MÁS GRANDE que exista configurado, mirando el % general y
// el propio de cada código (config.js hace la misma cuenta al validar un código:
// el del código si lo tiene, si no el general). Tres decisiones a propósito:
//  · Se miran TODOS los códigos, también los apagados y los vencidos. Es un piso:
//    ser un poco generoso solo cuesta protección en productos sin costo —un
//    estado pasajero— mientras que hilar fino trae de vuelta el rechazo de compras
//    buenas, que es justo lo que estamos arreglando. Y así no entra ningún reloj
//    en el cálculo (los relojes ya nos costaron el lío de los cupones).
//  · El techo por producto (`descuentoMax`) SUBE el precio, nunca lo baja, así que
//    ignorarlo deja el piso más abajo: del lado seguro.
//  · Si no hay nada configurado se usa 15, el mismo valor por defecto que usan
//    config.js e index.html.
function aflojeDeListaMejor(cfg) {
  const base = parseFloat(cfg && cfg.descuentoBase);
  let mejor = isNaN(base) ? 15 : base;
  const codigos = Array.isArray(cfg && cfg.codigosAcceso) ? cfg.codigosAcceso : [];
  for (const c of codigos) {
    const d = parseFloat(c && c.descuento);
    if (!isNaN(d)) mejor = Math.max(mejor, d);
  }
  return Math.min(Math.max(mejor, 0), 100) / 100;
}

// El precio más bajo que el catálogo pudo generar para este renglón, ANTES de
// cupones. Se queda con el menor de los candidatos: si hay algo cargado a
// propósito por debajo del costo, ese manda.
function pisoDeRenglon(item, p, cfg, afloje) {
  const may = positivo(p.wholesaler_price);
  const costo = positivo(p.unit_cost);
  // Con costo: min(costo, mayorista), que es donde frena el catálogo.
  // Sin costo: el mayorista menos el mejor descuento posible (ver la nota larga).
  let piso = (costo > 0)
    ? (may > 0 ? Math.min(costo, may) : costo)
    : may * (1 - afloje);

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
      // getPrecioVariante frena en min(costo, precioDeLaVariante) — y sin costo no
      // frena en nada, igual que el precio del producto: mismo arreglo.
      const pisoVar = costo > 0 ? Math.min(costo, vp) : vp * (1 - afloje);
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
  const afloje = aflojeDeListaMejor(cfg);
  const sospechosos = [];
  const avisados = new Set();
  for (const item of items) {
    const p = productos[item.product_id];
    if (!p) continue; // producto desconocido: ya lo maneja la verificación de stock

    // Un producto que se vende sin el costo cargado no deja rastro en ningún lado,
    // y es el que hace que el piso se calcule por el camino flojo. Que se vea, para
    // poder cargarle el costo y que vuelva a estar bien protegido.
    if (!(positivo(p.unit_cost) > 0) && positivo(p.wholesaler_price) > 0 && !avisados.has(p.id)) {
      avisados.add(p.id);
      console.warn(`[precio] "${p.name}" (${p.id}) se está vendiendo SIN COSTO cargado en Gestión Nube: el piso sale del mayorista menos ${Math.round(afloje * 100)}%, que es más flojo. Conviene cargarle el costo.`);
    }

    const piso = pisoDeRenglon(item, p, cfg, afloje);
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
  // ---------------------------------------------------------------------------
  // ?cupo=1 — PREGUNTARLE A GN CUÁNTO CUPO NOS QUEDA, AHORA
  //
  // El saldo viaja en las respuestas de GN, pero hasta ahora solo quedaba anotado
  // cuando alguien confirmaba un pedido: para saber el límite había que esperar
  // una venta. Esto lo pregunta en el momento, con UNA consulta de un solo
  // producto (la más barata que hay), y contesta lo que el 12-8-2026 no podíamos
  // responder: si GN bajó el límite, y si el cupo se está gastando cuando no hay
  // ventas (ahí el consumo viene de otro sistema que le pega desde la misma
  // dirección, no del catálogo).
  //
  // No va detrás de contraseña por la misma razón que `?warm=1`: gasta UNA
  // consulta, menos que abrir el catálogo, así que no agrega superficie real.
  if (req.query.cupo !== undefined) {
    const token = process.env.GESTIONNUBE_TOKEN;
    if (!token) return res.status(500).json({ ok: false, error: 'Token no configurado en el servidor' });
    const t0 = Date.now();
    const r = await fetch(API_BASE + '/productos/obtener?per_page=1', {
      headers: { 'Authorization': 'Bearer ' + token, 'Content-Type': 'application/json' },
    });
    const cabecera = (n) => r.headers.get(n);
    return res.status(200).json({
      ok: r.ok,
      status: r.status,
      limite: cabecera('X-RateLimit-Limit'),
      saldo: cabecera('X-RateLimit-Remaining'),
      esperar: cabecera('Retry-After'),
      // Todas las cabeceras de límite que mande GN, se llamen como se llamen: si
      // cambiaron los nombres al reescribir su sistema, acá se ven igual.
      otras: Object.fromEntries([...r.headers].filter(([k]) => /limit|rate|retry|quota/i.test(k))),
      ms: Date.now() - t0,
    });
  }

  if (req.query.warm !== undefined) {
    const t0 = Date.now();
    try {
      const host = req.headers['x-forwarded-host'] || req.headers.host;
      if (!host) return res.status(500).json({ ok: false, error: 'sin host' });
      const proto = (req.headers['x-forwarded-proto'] || 'https').split(',')[0];
      const base = `${proto}://${host}`;
      // Debe coincidir EXACTO con cargarProductos() en index.html: la copia del
      // CDN se identifica por la URL completa.
      // Igual que en index.html, y tiene que seguir igual: la copia se busca por
      // la URL entera, así que un número distinto acá calienta una copia que
      // ningún cliente pide (ver la nota larga en `traerProductosCrudos`).
      const baseQs = 'per_page=200&include_stock=1&include_images=1&include_variants=1';
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
        // DE A UNA, no todas juntas. Cada página es una llamada a NUESTRA propia
        // función, o sea otra instancia con su propio regulador de ritmo: pedirlas
        // en paralelo se saltea el espaciado y choca contra el techo de ~2 por
        // segundo. Pasó el 12-8-2026: el robot rebotó y no calentó nada. El robot
        // no tiene apuro, así que va en fila.
        for (let p = 2; p <= lastPage; p++) {
          await sleep(MS_ENTRE_CONSULTAS);
          const r = await fetch(urlPagina(p));
          const d = r.ok ? await r.json().catch(() => null) : null;
          if (!d) { completo = false; continue; }
          todos.push(...(d.data || []));
        }
      }
      // Solo se reescribe si el catálogo se leyó ENTERO. Media lectura dejaría la
      // libretita con productos de menos, y cada uno que falte manda ese pedido al
      // camino lento: preferimos la copia de hace 5 minutos antes que una a medias.
      let costos = { guardados: 0, motivo: 'lectura incompleta' };
      if (completo && todos.length) {
        // Aparte: si el KV falla, la libretita no se pudo anotar pero el CDN SÍ
        // quedó caliente, que es el trabajo principal del robot. Se informa el
        // problema sin dar por fallada la corrida entera.
        try { costos = await guardarCostos(todos); }
        catch (e) { costos = { guardados: 0, motivo: (e && e.message) || String(e) }; }
      }
      // ⚠️ `ok` tiene que decir la VERDAD. Estaba clavado en `true` y el 12-8-2026
      // contestó `{"ok":true, "productos":0}`: no había leído una sola página
      // —GN venía cortando— y aun así informaba éxito. Un robot que miente es
      // peor que uno que falla, porque tapa justamente el problema que hay que
      // ver: si la copia no se calienta, cada visita al catálogo le pega a GN.
      const salioBien = completo && todos.length > 0;
      if (!salioBien) console.warn(`[warm] NO se calentó la copia: leídos ${todos.length} productos, completo=${completo}`);
      return res.status(200).json({
        ok: salioBien,
        pages: lastPage,
        productos: todos.length,
        motivo: salioBien ? undefined : (todos.length ? 'lectura incompleta' : 'Gestión Nube no contestó ninguna página'),
        costos,
        ms: Date.now() - t0,
      });
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

  // El total se sella en el MOMENTO DE RESPONDER, no en el `finally`. Medido el
  // 2-8-2026: el registro decía 3.107 ms cuando el cliente había esperado 0,73 s.
  // No era un error de medición: en Vercel, lo que queda después de mandar la
  // respuesta (acá `liberarTurno`) corre en segundo plano y puede quedar
  // suspendido, así que el reloj sigue corriendo sin que nadie espere. Envolver
  // `res.json` es la forma de quedarse con el número que de verdad le importa al
  // cliente, y cubre TODAS las salidas sin tocar cada `return`.
  if (esConfirmarPedido) {
    const jsonOriginal = res.json.bind(res);
    res.json = (cuerpo) => { marcas.total = Date.now() - t0; return jsonOriginal(cuerpo); };
  }

  // El admin (pestaña "Cargar pedido") vende SIN tope a propósito: el dueño
  // decide caso por caso, y allá el aviso se muestra antes de confirmar.
  const esAdmin = !!ADMIN_PASSWORD && req.headers['x-admin-password'] === ADMIN_PASSWORD;

  // ESTAS TRES COSAS NO DEPENDEN DEL TURNO, así que se piden MIENTRAS se espera:
  //   · el freno (¿esta conexión ya mandó demasiados pedidos?)
  //   · la config (topes de stock y reglas de precio)
  //   · la libretita de costos
  // Antes iban una tras otra DESPUÉS de tomar el turno. Medido el 2-8-2026, cada
  // viaje al almacén cuesta ~112 ms, así que eran ~220 ms que el cliente esperaba
  // de gusto. El turno solo hace falta antes de LEER EL STOCK, que es donde está
  // la carrera; nada de esto lo toca.
  //
  // Las tres se protegen solas y devuelven un valor seguro si el almacén falla
  // (el freno deja pasar, la config vuelve vacía, la libretita vuelve null), así
  // que este Promise.all no puede quedar colgado ni tirar el pedido abajo.
  const enParalelo = (esConfirmarPedido && !esAdmin)
    ? Promise.all([pasaElFreno(req), leerConfigKV(), leerCostos()])
    : null;

  // Turno: de acá hasta el `finally`, este pedido es el único que confirma.
  const turno = esConfirmarPedido ? await tomarTurno() : null;
  if (esConfirmarPedido) marcar('turno');

  try {
    // Verificación de stock server-side antes de crear la venta
    if (esConfirmarPedido) {
      const items = req.body?.items || [];
      const [pasaFreno, cfg, costos] = enParalelo ? await enParalelo : [true, {}, null];
      marcar('datos');

      if (!esAdmin && !pasaFreno) {
        return res.status(429).json({
          error: 'Demasiados pedidos seguidos',
          detalle: 'Se recibieron varios pedidos desde esta conexión en poco tiempo. Esperá unos minutos y volvé a intentar, o escribinos por WhatsApp.',
        });
      }

      if (items.length > 0) {
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

    // ⚠️ ACÁ SE CREA LA VENTA. Iba sin ninguna red: un corte pasajero de GN le
    // llegaba crudo al cliente ("Demasiadas solicitudes desde esta dirección",
    // 12-8-2026) y la venta no se hacía, aunque alcanzaba con esperar unos
    // segundos.
    //
    // Se reintenta SOLO ante 429 y NUNCA ante 5xx ni ante un corte de red. La
    // diferencia importa: un 429 es GN diciendo "ni la miré", así que no hay
    // ninguna venta creada y repetir es seguro. Un 500 o una conexión cortada
    // dejan la duda de si la venta entró o no, y repetir ahí duplicaría el
    // pedido. Ante la duda, no se repite: un cliente que reintenta a mano es
    // mucho mejor que una venta cargada dos veces.
    // Turno también acá: es el pedido más caro de todos y salía pegado a la
    // última consulta de stock.
    await esperarTurnoDeRitmo();
    let r = await fetch(url, opts);
    let data = await r.text();
    anotarSaldo(r.headers);
    for (let i = 0; i < 2 && r.status === 429; i++) {
      let cuerpo = null;
      try { cuerpo = JSON.parse(data); } catch { /* puede venir HTML */ }
      const dice = cuantoEsperar(r.headers, cuerpo);
      const espera = dice > 0 ? dice * 1000 : 1000 * Math.pow(2, i);
      // Los 10 s son SOLO para crear la venta, que es lo que sale caro perder.
      // Para una lectura (mirar el catálogo) esperar 10 s es peor que avisar: la
      // pantalla se queda colgada y el cliente igual se va.
      const tope = esConfirmarPedido ? ESPERA_MAX_VENTA_MS : ESPERA_MAX_MS;
      if (espera > tope) break;
      console.warn(`[gn] cortó por límite, se reintenta en ${espera} ms (intento ${i + 2})`);
      await sleep(espera);
      await esperarTurnoDeRitmo();
      r = await fetch(url, opts);
      data = await r.text();
      anotarSaldo(r.headers);
    }

    // Si GN sigue cortando, el cliente merece un aviso en criollo y no su cartel
    // técnico. Clave: decirle que NO perdió el pedido —el carrito queda guardado
    // en el navegador— porque si no, reintenta a lo loco y alimenta el corte
    // (Facundo reintentó 6 veces seguidas y las 6 fallaron por eso mismo).
    if (r.status === 429) {
      console.error(`[gn] límite alcanzado, se avisa al cliente (${esConfirmarPedido ? 'confirmar pedido' : req.method + ' ' + apiPath})`);
      return res.status(429).json({
        error: 'Gestión Nube está recibiendo demasiados pedidos juntos',
        detalle: esConfirmarPedido
          ? 'Tu pedido NO se perdió: quedó guardado en el carrito. Esperá un minuto y tocá Confirmar de nuevo. Si vuelve a pasar, escribinos por WhatsApp y lo cargamos nosotros.'
          : 'Esperá un minuto y recargá la página. Si sigue pasando, escribinos por WhatsApp.',
      });
    }
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
      // `total` es lo que esperó el cliente; `hastaLiberar` incluye la limpieza de
      // después, que nadie espera (y que Vercel puede suspender).
      // `cupo` es el saldo que declaró GN en su última respuesta. Va en cada
      // pedido a propósito: es la única forma de ver, con el tiempo, si el límite
      // cambia o si alguien se lo está comiendo cuando no hay ventas.
      if (ultimoSaldo !== null) marcas.cupo = `${ultimoSaldo}/${ultimoLimite ?? '?'}`;
      console.log(`[tiempos] ${res.statusCode} en ${marcas.total ?? '?'}ms (hastaLiberar ${Date.now() - t0}ms) — ${JSON.stringify(marcas)}`);
    }
  }
};
