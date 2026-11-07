/**
 * El arnés de `api/_erp-corte.js` — el interruptor del catálogo el día del corte de BDI.
 * `node scripts/check-erp-corte.mjs`, sin credenciales. Sale con código distinto de 0 si algo falla.
 *
 * Lo que se cuida: que un corte ya visto ⛔ vuelva a Gestión Nube por una caída del ERP, y que sin
 * corte el catálogo siga exactamente como hoy.
 */
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { crear } = require('../api/_erp-corte.js');

const API_GN = 'https://www.gestionnube.com/api/v1';
const silencio = () => {};
console.log = silencio; const decir = console.info; console.error = silencio;

const armar = ({ contesta, env = { ERP_LLAVE_CATALOGO: 'cat' }, kv = {} } = {}) => {
  const llamadas = [];
  const reloj = { t: 1000 };
  const m = crear({
    env, ahora: () => reloj.t,
    kvCmd: async ([cmd, k, v]) => { if (cmd === 'SET') { kv[k] = v; return { result: 'OK' }; } return { result: kv[k] ?? null }; },
    fetch: async (url, op) => { llamadas.push({ url, op }); return contesta(url, op); },
  });
  return { m, llamadas, reloj, kv };
};
const json = (status, cuerpo) => ({ ok: status < 400, status, json: async () => cuerpo });
const caido = () => { throw new Error('caído'); };

// Sin llave: GN, sin preguntar.
{
  const { m, llamadas } = armar({ env: {}, contesta: caido });
  assert.equal(await m.erpManda(), false);
  assert.equal(llamadas.length, 0);
}

// Sin corte: GN, con la misma dirección de siempre.
{
  const { m } = armar({ contesta: () => json(200, { erp_manda: false }) });
  assert.equal(await m.erpManda(), false);
  assert.equal(m.baseDe('token-gn', API_GN), API_GN);
}

// Con corte: el ERP. Se pregunta una vez cada 30 s y queda anotado para las instancias nuevas.
{
  const { m, llamadas, reloj, kv } = armar({ contesta: () => json(200, { erp_manda: true }) });
  assert.equal(await m.erpManda(), true);
  assert.equal(await m.erpManda(), true);
  assert.equal(llamadas.length, 1, 'la copia de 30 s');
  assert.equal(llamadas[0].url, 'https://erp.arebensrl.com/api/v1/corte/obtener');
  assert.equal(llamadas[0].op.headers.Authorization, 'Bearer cat');
  assert.equal(kv['erp:catalogo-manda'], '1');
  assert.equal(m.baseDe('cat', API_GN), 'https://erp.arebensrl.com/api/v1');
  reloj.t += 31000;
  await m.erpManda();
  assert.equal(llamadas.length, 2, 'vencida, pregunta de nuevo');
}

// 🔴 Corte visto y el ERP se cae: ⛔ vuelve a GN.
{
  let caer = false;
  const { m, reloj } = armar({ contesta: () => { if (caer) caido(); return json(200, { erp_manda: true }); } });
  assert.equal(await m.erpManda(), true);
  caer = true; reloj.t += 31000;
  assert.equal(await m.erpManda(), true, 'misma instancia');
}

// 🔴 Instancia NUEVA con el ERP caído: lo que dejó anotado el KV.
{
  const { m } = armar({ contesta: caido, kv: { 'erp:catalogo-manda': '1' } });
  assert.equal(await m.erpManda(), true);
}
{
  const { m } = armar({ contesta: caido });
  assert.equal(await m.erpManda(), false, 'sin dato: GN, el estado de hoy');
}

// Una respuesta rota ⛔ cambia nada: cuenta como que ⛔ contestó.
{
  const { m } = armar({ contesta: () => json(200, { otra: 1 }), kv: { 'erp:catalogo-manda': '1' } });
  assert.equal(await m.erpManda(), true);
}
{
  const { m } = armar({ contesta: () => json(503, {}), kv: { 'erp:catalogo-manda': '1' } });
  assert.equal(await m.erpManda(), true);
}

// El freno: el ERP contesta false y el catálogo vuelve a GN, también en el KV.
{
  let manda = true;
  const { m, reloj, kv } = armar({ contesta: () => json(200, { erp_manda: manda }) });
  assert.equal(await m.erpManda(), true);
  manda = false; reloj.t += 31000;
  assert.equal(await m.erpManda(), false);
  assert.equal(kv['erp:catalogo-manda'], '0');
}

// Caído, no se traba: reintenta a los 10 s y ⛔ en cada pedido.
{
  const { m, llamadas, reloj } = armar({ contesta: caido });
  await m.erpManda(); await m.erpManda();
  assert.equal(llamadas.length, 1);
  reloj.t += 11000;
  await m.erpManda();
  assert.equal(llamadas.length, 2);
}

// EL PEDIDO
const datos = { pedido: { store_id: 13307, items: [{ product_id: 1, size_id: 2, quantity: 1, unit_price: 100 }], comments: 'x', client_id: 563310 }, datosErp: { clave: 'clave-12345', contacto: { telefono: '341' } }, esAdmin: false };
{
  const { m, llamadas } = armar({ contesta: () => json(200, { ok: true, numero: 51, entro: true }) });
  const r = await m.crearPedido(datos);
  assert.equal(r.status, 200);
  assert.deepEqual(r.cuerpo.data, { id: 51, number: 51, erp: true }, 'las pantallas leen el número de data');
  assert.equal(llamadas[0].url, 'https://erp.arebensrl.com/api/pedido-mayorista');
  assert.equal(llamadas[0].op.headers['x-erp-llave'], 'cat');
  assert.deepEqual(JSON.parse(llamadas[0].op.body), { origen: 'catalogo', clave: 'clave-12345', contacto: { telefono: '341' }, pedido: { store_id: 13307, items: datos.pedido.items } }, 'sólo lo que el ERP lee');
}
{
  const { m, llamadas } = armar({ contesta: () => json(200, { ok: true, numero: 52 }) });
  await m.crearPedido({ ...datos, esAdmin: true });
  assert.equal(JSON.parse(llamadas[0].op.body).origen, 'admin');
}
// Sin clave ⛔ se manda: sin ella un reintento duplicaría.
{
  const { m, llamadas } = armar({ contesta: () => json(200, { numero: 1 }) });
  assert.equal((await m.crearPedido({ ...datos, datosErp: {} })).status, 400);
  assert.equal(llamadas.length, 0);
}
// 🔴 El ERP cae: reintenta una vez con la MISMA clave y le dice al cliente que ⛔ perdió el pedido. ⛔ cae a GN.
{
  let n = 0; const bodies = [];
  const { m, llamadas } = armar({ contesta: (u, op) => { n++; bodies.push(op.body); return n === 1 ? json(503, {}) : json(200, { numero: 53 }); } });
  const r = await m.crearPedido(datos);
  assert.equal(r.status, 200);
  assert.equal(llamadas.length, 2);
  assert.equal(bodies[0], bodies[1], 'la misma clave');
}
{
  const { m, llamadas } = armar({ contesta: caido });
  const r = await m.crearPedido(datos);
  assert.equal(r.status, 503);
  assert.match(r.cuerpo.detalle, /NO se perdió/);
  assert.equal(llamadas.length, 2);
  assert.ok(llamadas.every((l) => l.url.startsWith('https://erp.arebensrl.com')), '⛔ toca GN');
}
// Un 4xx ⛔ se reintenta: el pedido está mal, repetirlo da lo mismo.
{
  const { m, llamadas } = armar({ contesta: () => json(409, {}) });
  assert.equal((await m.crearPedido(datos)).status, 503);
  assert.equal(llamadas.length, 1);
}
decir('✔ erp-corte');
