/**
 * `api/proxy.js` entero, con `fetch` falso: ¿a quién le pega antes y después del corte de BDI?
 * `node scripts/check-erp-corte-proxy.mjs`, sin credenciales. Sale con código distinto de 0 si algo falla.
 */
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);

process.env.GESTIONNUBE_TOKEN = 'token-gn';
process.env.ERP_LLAVE_CATALOGO = 'llave-erp';
delete process.env.KV_REST_API_URL; delete process.env.STORAGE_KV_REST_API_URL;

const decir = console.info;
console.log = console.warn = console.error = () => {};

const producto = (stock) => ({
  id: 7, name: 'FUNDA', active: 1, category: 'FUNDAS', wholesaler_price: '1000.00', retailer_price: '3000.00', unit_cost: '400.00', stock_total: stock,
  variantes: [{ size_id: 70, size: 'iPhone 13', stock_por_tienda: [{ store_id: 13307, store_name: 'Deposito Minorista', stock_disponible: stock }, { store_id: 18393, store_name: 'Local', stock_disponible: 0 }] }],
});
const hoja = (stock) => ({ data: [producto(stock)], meta: { current_page: 1, last_page: 1, total: 1, per_page: 200, has_more_pages: false } });
const cabeceras = { get: () => null, [Symbol.iterator]: function* () {} };
const resp = (status, cuerpo) => ({ ok: status < 400, status, headers: cabeceras, text: async () => JSON.stringify(cuerpo), json: async () => cuerpo });

let manda = false;
let llamadas = [];
globalThis.fetch = async (url, op = {}) => {
  const u = String(url);
  llamadas.push({ u, metodo: op.method || 'GET', auth: op.headers?.Authorization, llave: op.headers?.['x-erp-llave'], body: op.body });
  if (u.endsWith('/api/v1/corte/obtener')) return resp(200, { erp_manda: manda });
  if (u.includes('/api/pedido-mayorista')) return resp(200, { ok: true, numero: 51, entro: true });
  if (u.includes('/productos/obtener')) return resp(200, u.includes('erp.arebensrl') ? hoja(5) : hoja(50));
  if (u.includes('/ventas/referencias')) return resp(200, { canales: [], tipos_venta: [], monedas: [], configuracion: { default_store_id: 13307 } });
  if (u.endsWith('/ventas')) return resp(201, { data: { id: 9000, number: 29999 } });
  throw new Error('fetch inesperado: ' + u);
};

const proxy = require('../api/proxy.js');
const ERP_CORTE = require('../api/_erp-corte.js');

const correr = async (req) => {
  const r = { code: 0, body: null, headers: {} };
  r.status = (c) => ((r.code = c), r);
  r.setHeader = (k, v) => ((r.headers[k] = v), r);
  r.json = (b) => ((r.body = b), r);
  r.send = (b) => { r.body = JSON.parse(b); return r; };
  r.end = () => r;
  await proxy({ headers: { host: 'prueba' }, socket: {}, ...req }, r);
  return r;
};
const pedido = (cantidad) => ({
  method: 'POST', query: { _path: '/ventas' },
  body: { client_id: 563310, store_id: 13307, comments: 'x', items: [{ product_id: 7, size_id: 70, quantity: cantidad, unit_price: 1000 }], erp: { clave: 'clave-12345', contacto: { telefono: '3415551234' } } },
});
const lista = { method: 'GET', query: { _path: '/productos/obtener', per_page: '200', include_stock: '1', page: '1' } };

// ── SIN CORTE: exactamente como hoy ──────────────────────────────────────────────────────────────
{
  llamadas = [];
  const r = await correr(lista);
  assert.equal(r.code, 200);
  const l = llamadas.find((x) => x.u.includes('/productos/obtener'));
  assert.match(l.u, /^https:\/\/www\.gestionnube\.com/);
  assert.equal(l.auth, 'Bearer token-gn');
  assert.equal(r.body.data[0].unit_cost, undefined, 'el costo ⛔ sale a la calle');
  assert.ok(!llamadas.some((x) => x.auth === 'Bearer token-gn' && x.u.includes('erp.arebensrl')), 'el token de GN ⛔ viaja al ERP');
}
{
  llamadas = [];
  const r = await correr(pedido(2));
  assert.equal(r.code, 201);
  assert.ok(llamadas.some((x) => x.metodo === 'POST' && x.u === 'https://www.gestionnube.com/api/v1/ventas'), 'la venta en GN');
  const copia = llamadas.find((x) => x.u.includes('/api/pedido-mayorista'));
  assert.equal(JSON.parse(copia.body).gn.id, 9000, 'con la copia al ERP de siempre');
}

// ── CON CORTE ────────────────────────────────────────────────────────────────────────────────────
manda = true;
// La copia de 30 s se vence con el reloj: se fuerza con una instancia nueva, como en un deploy.
delete require.cache[require.resolve('../api/proxy.js')];
delete require.cache[require.resolve('../api/_erp-corte.js')];
const proxyCorte = require('../api/proxy.js');
const correrCorte = async (req) => {
  const r = { code: 0, body: null, headers: {} };
  r.status = (c) => ((r.code = c), r);
  r.setHeader = (k, v) => ((r.headers[k] = v), r);
  r.json = (b) => ((r.body = b), r);
  r.send = (b) => { r.body = JSON.parse(b); return r; };
  r.end = () => r;
  await proxyCorte({ headers: { host: 'prueba' }, socket: {}, ...req }, r);
  return r;
};
{
  llamadas = [];
  const r = await correrCorte(lista);
  assert.equal(r.code, 200);
  assert.equal(r.body.data[0].stock_total, 5, 'el stock del ERP');
  assert.equal(r.body.data[0].unit_cost, undefined, 'el costo ⛔ sale a la calle, tampoco desde el ERP');
  assert.ok(llamadas.every((x) => !x.u.includes('gestionnube')), '⛔ toca GN');
  const l = llamadas.find((x) => x.u.includes('/productos/obtener'));
  assert.equal(l.u.split('?')[0], 'https://erp.arebensrl.com/api/v1/productos/obtener');
  assert.equal(l.auth, 'Bearer llave-erp');
}
{
  llamadas = [];
  const r = await correrCorte(pedido(2));
  assert.equal(r.code, 200);
  assert.deepEqual(r.body.data, { id: 51, number: 51, erp: true });
  assert.ok(llamadas.every((x) => !x.u.includes('gestionnube')), 'el pedido ⛔ toca GN');
  const p = llamadas.find((x) => x.u.includes('/api/pedido-mayorista'));
  const b = JSON.parse(p.body);
  assert.equal(b.gn, undefined, 'nace en el ERP, sin venta de GN');
  assert.equal(b.clave, 'clave-12345');
  assert.equal(b.contacto.telefono, '3415551234', 'con el número, para que entre solo');
}
{
  // 🔴 El stock que frena es el del ERP: en GN (50) alcanzaría, en el ERP (5) no.
  llamadas = [];
  const r = await correrCorte(pedido(9));
  assert.equal(r.code, 409);
  assert.ok(!llamadas.some((x) => x.u.includes('/api/pedido-mayorista')), 'sin stock ⛔ se crea');
}
void ERP_CORTE;
decir('✔ erp-corte-proxy');
