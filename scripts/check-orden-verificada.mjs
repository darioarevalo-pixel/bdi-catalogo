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
  if (/\/orders\/88(\?|$)/.test(u)) return ok(sinMail ? { ...ORDEN_CRUDA, contact_email: null } : ORDEN_CRUDA);
  if (/\/orders\?/.test(u)) return u.includes('page=1') ? ok([{ id: 88, number: 21033 }]) : ok([]);
  return { ok: false, status: 404, json: async () => ({}), text: async () => 'no' };
};

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

await caso('GET ?orden=21033 sigue contestando la orden entera, como siempre', async () => {
  const r = await pedir({ method: 'GET', query: { orden: '21033', store: 'bdi' } });
  assert.equal(r.code, 200);
  assert.equal(r.body.orden.number, 21033);
  assert.equal(r.body.orden.cliente, 'Victoria Singh');
  assert.equal(r.body.orden.total, '90000.00'); // el interno SÍ ve la plata
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
