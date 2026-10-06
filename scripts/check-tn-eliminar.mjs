/**
 * El arnés de `api/_tn-eliminar.js`. `node scripts/check-tn-eliminar.mjs; echo $?` — sin token,
 * sin KV y sin tocar ninguna tienda: TN y el KV son falsos. El oráculo es el código de salida.
 *
 * 🔴 Lo que se prueba es lo que NO tiene vuelta atrás: que nada llegue al DELETE sin pasar los
 * cuatro frenos, y que sin respaldo no se elimine.
 */
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const t = require('../api/_tn-eliminar.js');

let fallas = 0;
const caso = async (nombre, fn) => {
  try { await fn(); console.log('  ok  ' + nombre); }
  catch (e) { fallas++; console.log('FALLA  ' + nombre + '\n       ' + e.message.split('\n')[0]); }
};

function tienda(productos, { kvFalla = false } = {}) {
  const llamadas = [];
  const kvCmds = [];
  return {
    llamadas, kvCmds,
    deps: {
      tnFetch: async (path, init) => {
        llamadas.push(`${init.method} ${path}`);
        const id = path.split('/').pop();
        const p = productos[id];
        if (!p) return { ok: false, status: 404, json: async () => ({}) };
        if (init.method === 'DELETE') { delete productos[id]; return { ok: true, status: 200 }; }
        return { ok: true, status: 200, json: async () => p };
      },
      kv: async (cmd) => { if (kvFalla) throw new Error('KV caído'); kvCmds.push(cmd); return cmd[0] === 'SET' ? 'OK' : 1; },
    },
  };
}
const prod = (name, stocks) => ({ id: 1, name: { es: name }, variants: stocks.map((s) => ({ stock: s })) });
const base = { store: 'zattia', quien: 'Dario Arevalo', ahora: '2026-10-06T00:00:00Z' };

await caso('quién: sólo Darío y Bruno, y admin; la cuenta CRM no', () => {
  assert.equal(t.puedeEliminar({ name: 'Dario Arevalo', admin: true }), true);
  assert.equal(t.puedeEliminar({ name: 'Bruno Arevalo', admin: true }), true);
  assert.equal(t.puedeEliminar({ name: 'CRM', admin: true }), false);
  assert.equal(t.puedeEliminar({ name: 'Dario Arevalo', admin: false }), false);
  assert.equal(t.puedeEliminar({ name: '(sin credencial)', _modoAviso: true }), false);
  assert.equal(t.puedeEliminar(null), false);
});

await caso('sin stock y con el nombre esperado: respaldo ANTES del DELETE', async () => {
  const s = tienda({ 10: prod('TOP ALO', [0, 0]) });
  const r = await t.eliminarUno({ ...base, id: 10, esperado: 'Top Aló' }, s.deps);
  assert.equal(r.resultado, 'eliminado');
  assert.deepEqual(s.llamadas, ['GET /products/10', 'DELETE /products/10']);
  assert.equal(s.kvCmds[0][0], 'SET');
  assert.equal(s.kvCmds[0][1], 'tn-eliminado:zattia:10');
  assert.equal(JSON.parse(s.kvCmds[0][2]).producto.name.es, 'TOP ALO');
  assert.equal(s.kvCmds[1][0], 'LPUSH');
});

await caso('con stock en la tienda NO se elimina', async () => {
  const s = tienda({ 11: prod('TOP VERA', [0, 3]) });
  const r = await t.eliminarUno({ ...base, id: 11, esperado: 'TOP VERA' }, s.deps);
  assert.equal(r.resultado, 'salteado'); assert.equal(r.motivo, 'tiene-stock');
  assert.ok(!s.llamadas.some((l) => l.startsWith('DELETE')));
});

await caso('stock infinito (null) NO se elimina', async () => {
  const s = tienda({ 12: prod('TOP X', [null]) });
  assert.equal((await t.eliminarUno({ ...base, id: 12, esperado: 'TOP X' }, s.deps)).motivo, 'stock-infinito');
  assert.ok(!s.llamadas.some((l) => l.startsWith('DELETE')));
});

await caso('si el nombre del id no es el esperado NO se elimina (id equivocado)', async () => {
  const s = tienda({ 13: prod('TOP BALINA', [0]) });
  const r = await t.eliminarUno({ ...base, id: 13, esperado: 'TOP BALI' }, s.deps);
  assert.equal(r.motivo, 'nombre-distinto');
  assert.ok(!s.llamadas.some((l) => l.startsWith('DELETE')));
});

await caso('si el respaldo falla NO se elimina', async () => {
  const s = tienda({ 14: prod('TOP ALO', [0]) }, { kvFalla: true });
  const r = await t.eliminarUno({ ...base, id: 14, esperado: 'TOP ALO' }, s.deps);
  assert.equal(r.resultado, 'error');
  assert.ok(!s.llamadas.some((l) => l.startsWith('DELETE')));
});

await caso('el que ya no está se informa, no es error', async () => {
  const s = tienda({});
  assert.equal((await t.eliminarUno({ ...base, id: 15, esperado: 'TOP ALO' }, s.deps)).resultado, 'ya-no-estaba');
});

console.log(fallas ? `\n${fallas} FALLA(S)` : '\ntodo ok');
process.exit(fallas ? 1 : 0);
