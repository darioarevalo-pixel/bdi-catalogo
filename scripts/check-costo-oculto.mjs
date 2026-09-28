/**
 * El costo no sale a la calle: corre `api/proxy.js` y `api/config.js` **de verdad**, con Gestión
 * Nube y el KV de mentira. `node scripts/check-costo-oculto.mjs`, sin credenciales.
 *
 * Qué se prueba:
 *   · la lista pública llega SIN `unit_cost` (ni `provider`) y con la OFERTA ya calculada;
 *   · con `con_costo=1` + llave (contraseña del panel o COSTOS_CLAVE) llega con costo;
 *   · `con_costo=1` sin llave, o con llave equivocada, llega sin costo;
 *   · la versión con costo nunca se cachea en el CDN;
 *   · `con_costo` no viaja a Gestión Nube;
 *   · un código válido trae los costos de la libretita.
 *
 * Sale con código distinto de 0 si algo falla: el oráculo es `echo $?`.
 */
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

process.env.GESTIONNUBE_TOKEN = 'token-de-mentira';
process.env.ADMIN_PASSWORD = 'clave-del-panel';
process.env.COSTOS_CLAVE = 'clave-de-ml';
process.env.KV_REST_API_URL = 'https://kv-de-mentira.local';
process.env.KV_REST_API_TOKEN = 'token-de-mentira';

const require = createRequire(import.meta.url);

// Margen: A = (2110-1720)/2110 = 18,5% → OFERTA con umbral 20. B = 50% → no.
// B tiene una variante con precio especial a 1100: margen 9% → oferta SOLO esa variante.
const PRODUCTOS = [
  { id: 1, name: 'AMBER CASE', active: 1, unit_cost: '1720', wholesaler_price: '2110', provider: 'Proveedor X',
    variantes: [{ size_id: 10, size: 'iPhone 15' }] },
  { id: 2, name: 'SPACE CASE', active: 1, unit_cost: '1000', wholesaler_price: '2000', provider: 'Proveedor Y',
    variantes: [{ size_id: 20, size: 'iPhone 16' }, { size_id: 21, size: 'iPhone 17' }] },
];
const CONFIG = {
  ofertaMargen: 20,
  variantPrices: { '2-21': 1100 },
  codigosAcceso: [{ codigo: 'JUAN10', cliente: 'Juan', activo: true }],
};
const LIBRETITA = { actualizado: new Date().toISOString(), productos: { 1: 1720, 2: 1000 } };

const aGN = [];
let guardado = null;
globalThis.fetch = async (url, opts = {}) => {
  url = String(url);
  const json = (d) => new Response(JSON.stringify(d), { status: 200, headers: { 'Content-Type': 'application/json' } });
  if (url.startsWith('https://kv-de-mentira.local/get/')) return json({ result: JSON.stringify(CONFIG) });
  if (url.startsWith('https://kv-de-mentira.local')) {
    const cmd = JSON.parse(opts.body || '[]');
    if (cmd[0] === 'SET' && cmd[1] === 'catalog-costos') guardado = JSON.parse(cmd[2]);
    if (cmd[0] === 'GET' && cmd[1] === 'catalog-costos') return json({ result: JSON.stringify(LIBRETITA) });
    return json({ result: null });
  }
  // El robot calienta la copia pidiéndose la lista pública a sí mismo.
  if (url.startsWith('https://catalogo-de-mentira.local/api/proxy')) {
    return json({ data: PRODUCTOS.map(({ unit_cost, ...p }) => p), meta: { last_page: 1 } });
  }
  if (url.includes('gestionnube.com')) {
    aGN.push(url);
    return json({ data: structuredClone(PRODUCTOS), meta: { current_page: 1, last_page: 1, has_more_pages: false } });
  }
  throw new Error('fetch inesperado: ' + url);
};

const proxy = require('../api/proxy.js');
const config = require('../api/config.js');

function llamar(handler, query, headers = {}) {
  return new Promise((ok, mal) => {
    const res = {
      statusCode: 200, h: {},
      setHeader(k, v) { this.h[k.toLowerCase()] = v; return this; },
      status(c) { this.statusCode = c; return this; },
      json(b) { ok({ status: this.statusCode, h: this.h, body: b }); return this; },
      send(b) { ok({ status: this.statusCode, h: this.h, body: typeof b === 'string' ? JSON.parse(b) : b }); return this; },
      end() { ok({ status: this.statusCode, h: this.h }); return this; },
    };
    Promise.resolve(handler({ method: 'GET', query, headers, body: null }, res)).catch(mal);
  });
}
const lista = (query, headers) => llamar(proxy, { _path: '/productos/obtener', per_page: '200', page: '1', ...query }, headers);
const traeCosto = (r) => r.body.data.some(p => 'unit_cost' in p);

let fallas = 0;
async function caso(nombre, fn) {
  try { await fn(); console.log('  ok ', nombre); }
  catch (e) { fallas++; console.log('  MAL', nombre, '\n      ', e.message); }
}

await caso('la lista pública llega sin costo ni proveedor', async () => {
  const r = await lista({});
  assert.equal(r.status, 200);
  assert.equal(traeCosto(r), false);
  assert.ok(r.body.data.every(p => !('provider' in p)));
  assert.match(r.h['cache-control'], /s-maxage/);
});

await caso('la OFERTA viaja ya calculada (producto y variante con precio especial)', async () => {
  const r = await lista({});
  const [a, b] = r.body.data;
  assert.equal(a._oferta, true);
  assert.equal(b._oferta, undefined);
  assert.deepEqual(b._ofertaVar, { 21: true });
});

await caso('con_costo sin llave → sin costo, y sin caché', async () => {
  const r = await lista({ con_costo: '1' });
  assert.equal(traeCosto(r), false);
  assert.equal(r.h['cache-control'], 'private, no-store');
});

await caso('con_costo con llave equivocada → sin costo', async () => {
  assert.equal(traeCosto(await lista({ con_costo: '1' }, { 'x-admin-password': 'otra' })), false);
  assert.equal(traeCosto(await lista({ con_costo: '1' }, { 'x-costos-clave': 'otra' })), false);
});

await caso('la llave sola, sin con_costo, no alcanza (la copia pública queda limpia)', async () => {
  const r = await lista({}, { 'x-admin-password': 'clave-del-panel' });
  assert.equal(traeCosto(r), false);
});

await caso('panel: con_costo + contraseña → con costo y sin caché', async () => {
  const r = await lista({ con_costo: '1' }, { 'x-admin-password': 'clave-del-panel' });
  assert.equal(traeCosto(r), true);
  assert.equal(r.h['cache-control'], 'private, no-store');
});

await caso('Mercado Libre: con_costo + COSTOS_CLAVE → con costo', async () => {
  assert.equal(traeCosto(await lista({ con_costo: '1' }, { 'x-costos-clave': 'clave-de-ml' })), true);
});

await caso('con_costo no viaja a Gestión Nube', async () => {
  assert.ok(aGN.length > 0);
  assert.ok(aGN.every(u => !u.includes('con_costo')), aGN.find(u => u.includes('con_costo')));
});

await caso('un código válido trae los costos de la libretita', async () => {
  const r = await llamar(config, { accion: 'codigo', codigo: 'juan10' });
  assert.equal(r.body.ok, true);
  assert.deepEqual(r.body.costos, { 1: 1720, 2: 1000 });
});

await caso('un código inválido no trae nada', async () => {
  const r = await llamar(config, { accion: 'codigo', codigo: 'NOEXISTE' });
  assert.equal(r.status, 404);
  assert.equal(r.body.costos, undefined);
});

await caso('el robot sigue anotando los costos (los lee directo de Gestión Nube)', async () => {
  const r = await llamar(proxy, { warm: '1' }, { host: 'catalogo-de-mentira.local' });
  assert.equal(r.body.ok, true);
  assert.equal(r.body.costos.guardados, 2);
  assert.deepEqual(guardado.productos, { 1: 1720, 2: 1000 });
});

console.log(fallas ? `\n${fallas} caso(s) MAL` : '\ntodo ok');
process.exit(fallas ? 1 : 0);
