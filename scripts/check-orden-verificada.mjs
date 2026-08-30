/**
 * El CABLE de la llave: corre `api/tiendanube-audit.js` **de verdad**, con Tienda Nube de mentira.
 * `node scripts/check-orden-verificada.mjs`, sin credenciales.
 *
 * 🔑 `check-verificacion-orden.mjs` prueba **la regla**; esto prueba que **esté enchufada**, que es
 * la otra mitad y la que se rompe callada: una regla perfecta llamada con el argumento en
 * `undefined` deja pasar todo y ⛔ nada se pone rojo.
 *
 * Sale con código distinto de 0 si algo falla: el oráculo es `echo $?`.
 */
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

process.env.TIENDANUBE_STORE_ID = '111';
process.env.TIENDANUBE_TOKEN = 'token-de-mentira';
// 🔴 **Como corre en PRODUCCIÓN, ⛔ no como corre acá.** `_auth.js` arranca en `MODO_AVISO`: sin
// credencial **avisa y deja pasar**, para no romper llamadores viejos mientras se migran. En
// producción está `AUTH_MODO_AVISO=0` y el guard rechaza de verdad. Sin esta línea, el arnés medía
// el modo aviso y un `exigirUsuario` que faltara habría salido **verde**.
process.env.AUTH_MODO_AVISO = '0';
// El padrón vive en el KV, y `_admin.js` lo lee por `fetch` — que acá está intervenido.
process.env.KV_REST_API_URL = 'https://kv-de-mentira.local';
process.env.KV_REST_API_TOKEN = 'token-de-mentira';

const require = createRequire(import.meta.url);

// ── Tienda Nube de mentira ───────────────────────────────────────────────────
// Dos llamadas: la lista liviana (id,number) para hallar el id, y el GET por id con la orden
// completa — que es donde viaja el mail.
const ORDEN_CRUDA = {
  id: 88, number: 21033, contact_name: 'Victoria Singh', contact_email: 'Victoria@Gmail.com',
  total: '90000.00', subtotal: '90000.00', gateway: 'mercadopago', payment_status: 'paid',
  shipping_tracking_number: 'AR123',
  shipping_address: { name: 'Victoria Singh', phone: '11-5555', address: 'Calle Falsa', city: 'CABA' },
  products: [{ product_id: 7, variant_id: 9, name: 'Campera', sku: 'A1', quantity: 1, price: '90000.00' }],
};
let sinMail = false;
globalThis.fetch = async (url) => {
  const u = String(url);
  const ok = (body) => ({ ok: true, status: 200, json: async () => body, text: async () => JSON.stringify(body) });
  // El KV con el padrón: un solo usuario, con la pass en el formato viejo (sin hashear), que
  // `verificarPass` acepta comparando texto.
  if (u.includes('kv-de-mentira')) return ok({ result: JSON.stringify({ users: [{ name: 'Bruno Arevalo', pass: 'la-pass' }] }) });
  if (/\/orders\/88(\?|$)/.test(u)) return ok(sinMail ? { ...ORDEN_CRUDA, contact_email: null } : ORDEN_CRUDA);
  if (/\/orders\?/.test(u)) return u.includes('page=1') ? ok([{ id: 88, number: 21033 }]) : ok([]);
  return { ok: false, status: 404, json: async () => ({}), text: async () => 'no' };
};

/**
 * El padrón de mentira. `_auth.js` lo lee del KV por `fetch`, que acá ya está intervenido: se le
 * suma la ruta del KV al stub de arriba. La pass se compara como la compara `_admin.js`.
 */
const DEL_PADRON = Buffer.from(JSON.stringify({ user: 'Bruno Arevalo', pass: 'la-pass' })).toString('base64');

const handler = require('../api/tiendanube-audit.js');

function resFalso() {
  const r = { code: 0, body: null, headers: {},
    setHeader(k, v) { r.headers[k] = v; }, status(c) { r.code = c; return r; },
    json(b) { r.body = b; return r; }, end() { return r; } };
  return r;
}
const pedir = async (req) => { const res = resFalso(); await handler({ headers: {}, ...req }, res); return res; };

let fallas = 0;
const caso = async (nombre, fn) => {
  try { await fn(); console.log('  ok  ' + nombre); }
  catch (e) { fallas++; console.log('FALLA  ' + nombre + '\n       ' + e.message.split('\n')[0]); }
};

// ── El camino de siempre: el Monitor interno ─────────────────────────────────

/**
 * 🔴 **El camino interno pide usuario del padrón desde el 30-ago-2026.** Antes contestaba a
 * cualquiera con un número de orden —correlativo, y con este repo público en GitHub— el nombre del
 * comprador, lo que pagó, la forma de pago y el seguimiento.
 *
 * Se prueba con las DOS puntas: sin credencial rechaza, con credencial contesta lo de siempre. Una
 * sola punta ⛔ no defiende la regla — un guard que rechaza a todo el mundo también pasa el primer
 * test, y rompe Reclamos, Cambios y Canjes.
 */
await caso('🔴 GET ?orden=21033 SIN credencial ya no contesta', async () => {
  const r = await pedir({ method: 'GET', query: { orden: '21033', store: 'bdi' } });
  assert.notEqual(r.code, 200);
  assert.equal(JSON.stringify(r.body || {}).includes('Victoria'), false);
});

await caso('🔴 GET ?orden=21033 CON credencial del padrón contesta la orden entera, como siempre', async () => {
  const r = await pedir({ method: 'GET', query: { orden: '21033', store: 'bdi' }, headers: { 'x-monitor-auth': DEL_PADRON } });
  assert.equal(r.code, 200);
  assert.equal(r.body.orden.number, 21033);
  assert.equal(r.body.orden.cliente, 'Victoria Singh');
  assert.equal(r.body.orden.total, '90000.00'); // el interno SÍ ve la plata
});

await caso('🔑 el POST verificado ⛔ NO pide padrón: su llave es el mail del comprador', async () => {
  const r = await pedir({ method: 'POST', query: { orden: '21033', store: 'bdi' }, body: { mail: 'victoria@gmail.com' } });
  assert.equal(r.code, 200); // sin un solo header de sesión
});

// ── El camino nuevo: el alta pública ─────────────────────────────────────────

await caso('POST con el mail correcto abre, y devuelve MUCHO MENOS', async () => {
  const r = await pedir({ method: 'POST', query: { orden: '21033', store: 'bdi' }, body: { mail: 'victoria@gmail.com' } });
  assert.equal(r.code, 200);
  assert.equal(r.body.orden.number, 21033);
  assert.equal(r.body.orden.products[0].sku, 'A1');
  const texto = JSON.stringify(r.body);
  for (const p of ['total', 'price', 'gateway', 'tracking', 'address', 'phone', '@']) {
    assert.equal(texto.includes(p), false, `se escapó «${p}»: ${texto}`);
  }
});

await caso('🔴 POST con OTRO mail contesta 404 y ⛔ ni una letra de la orden', async () => {
  const r = await pedir({ method: 'POST', query: { orden: '21033', store: 'bdi' }, body: { mail: 'otro@gmail.com' } });
  assert.equal(r.code, 404);
  assert.equal(JSON.stringify(r.body).includes('Victoria'), false);
});

await caso('🔴 POST SIN mail no abre: quien postea viene de afuera', async () => {
  const r = await pedir({ method: 'POST', query: { orden: '21033', store: 'bdi' }, body: {} });
  assert.equal(r.code, 404);
  const r2 = await pedir({ method: 'POST', query: { orden: '21033', store: 'bdi' } });
  assert.equal(r2.code, 404);
});

await caso('🔴 la orden SIN MAIL no abre — falla cerrado', async () => {
  sinMail = true;
  try {
    const r = await pedir({ method: 'POST', query: { orden: '21033', store: 'bdi' }, body: { mail: 'victoria@gmail.com' } });
    assert.equal(r.code, 404);
  } finally { sinMail = false; }
});

await caso('🔴 una orden que no existe contesta IGUAL que un mail que no coincide', async () => {
  const noExiste = await pedir({ method: 'POST', query: { orden: '99999', store: 'bdi' }, body: { mail: 'victoria@gmail.com' } });
  const noCoincide = await pedir({ method: 'POST', query: { orden: '21033', store: 'bdi' }, body: { mail: 'otro@gmail.com' } });
  assert.equal(noExiste.code, noCoincide.code);
  assert.deepEqual(noExiste.body, noCoincide.body);
});

await caso('🔴 el mail en la URL se RECHAZA: una query string queda escrita en los logs', async () => {
  const r = await pedir({ method: 'POST', query: { orden: '21033', store: 'bdi', mail: 'victoria@gmail.com' } });
  assert.equal(r.code, 400);
  const g = await pedir({ method: 'GET', query: { orden: '21033', store: 'bdi', mail: 'victoria@gmail.com' } });
  assert.equal(g.code, 400);
});

// ── CORS: lo único de acá que sólo rompe en un navegador ─────────────────────

await caso('🔴 el preflight permite POST — sin esto el alta pública no anda en NINGÚN navegador', async () => {
  // node ⛔ no valida CORS, así que este endpoint contesta perfecto por curl y por script aunque la
  // cabecera diga que no. El navegador corta el POST en el preflight **antes** de salir, y el
  // servidor ni se entera. Es la única aserción de este archivo que mira una CABECERA y no un body.
  const r = await pedir({ method: 'OPTIONS', query: {} });
  assert.match(String(r.headers['Access-Control-Allow-Methods']), /POST/);
  assert.match(String(r.headers['Access-Control-Allow-Headers']), /Content-Type/);
});

// ── El diagnóstico ───────────────────────────────────────────────────────────

await caso('🔴 `?mail_diag=1` PIDE USUARIO: saber que una orden existe ya es demasiado', async () => {
  // Sin credencial en los headers, `exigirUsuario` tiene que cortar. Si contestara igual, esto
  // sería un enumerador de órdenes con un nombre inofensivo.
  const r = await pedir({ method: 'GET', query: { orden: '21033', store: 'bdi', mail_diag: '1' } });
  assert.notEqual(r.code, 200);
  assert.equal(JSON.stringify(r.body || {}).includes('tiene_mail'), false);
});

console.log(fallas ? `\n${fallas} FALLA(S)` : '\ntodo ok');
process.exit(fallas ? 1 : 0);
