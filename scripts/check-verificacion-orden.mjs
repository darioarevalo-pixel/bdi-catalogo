/**
 * El arnés de `api/_verificacion-orden.js` — la llave del alta pública de Reclamos.
 * `node scripts/check-verificacion-orden.mjs`, sin credenciales.
 *
 * Sale con código distinto de 0 si algo falla: el oráculo es `echo $?`, ⛔ no la última línea.
 *
 * 🔑 Lo que se cuida acá ⛔ no es que la comparación funcione cuando coincide: es **que ninguna de
 * las formas de "no sé" abra la puerta**. Este archivo decide quién ve el pedido de otra persona.
 */
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { puedeVerLaOrden, mailDeLaOrden, ordenParaElCliente, diagnosticoDeMail, normalizar } = require('../api/_verificacion-orden.js');

let fallas = 0;
const caso = (nombre, fn) => {
  try { fn(); console.log('  ok  ' + nombre); }
  catch (e) { fallas++; console.log('FALLA  ' + nombre + '\n       ' + e.message.split('\n')[0]); }
};

// La orden CRUDA de Tienda Nube — la que ve `puedeVerLaOrden`, con el mail todavía adentro.
const ORDEN = { number: 21033, contact_email: 'victoria@gmail.com', products: [{ sku: 'A1', name: 'Campera', quantity: 1, price: '90000.00', product_id: 7, variant_id: 9 }] };
// La orden YA MAPEADA — la que ve `ordenParaElCliente`. ⚠️ Acá el mail YA no está: lo tira el
// mapper. Por eso la comparación va antes, sobre la cruda.
const MAPEADA = {
  id: 88, number: 21033, cliente: 'Victoria Singh', total: 90000, subtotal: 90000,
  pago_metodo: 'credit_card', pago_gateway: 'mercadopago', descuento_total: 0, cupon: 'VERANO',
  envio_tracking: 'AR123', envio_costo_cliente: 0, estado_pago: 'paid',
  products: [{ product_id: 7, variant_id: 9, name: 'Campera', sku: 'A1', quantity: 1, price: '90000.00' }],
};

// ── Lo que abre ──────────────────────────────────────────────────────────────

caso('el mail exacto abre', () => {
  assert.equal(puedeVerLaOrden(ORDEN, 'victoria@gmail.com').ok, true);
});

caso('mayúsculas y espacios no son otra persona: abren igual', () => {
  assert.equal(puedeVerLaOrden(ORDEN, '  VICTORIA@Gmail.com ').ok, true);
});

caso('el mail de la CUENTA sirve si no está el del checkout', () => {
  assert.equal(puedeVerLaOrden({ ...ORDEN, contact_email: null, customer: { email: 'v@x.com' } }, 'v@x.com').ok, true);
});

// ── 🔴 Lo que NO abre: las cuatro formas de "no sé" ───────────────────────────

caso('🔴 la orden SIN MAIL no abre — la puerta que se abre sola si el guard mira el valor', () => {
  const r = puedeVerLaOrden({ ...ORDEN, contact_email: null }, 'victoria@gmail.com');
  assert.equal(r.ok, false);
  assert.equal(r.motivo, 'la-orden-no-trae-mail');
});

caso('🔴 la orden sin mail no abre NI con un mail vacío del otro lado', () => {
  assert.equal(puedeVerLaOrden({ number: 21033 }, '').ok, false);
  assert.equal(puedeVerLaOrden({ number: 21033 }, null).ok, false);
  assert.equal(puedeVerLaOrden({ number: 21033 }, undefined).ok, false);
});

caso('🔴 un mail distinto no abre', () => {
  assert.equal(puedeVerLaOrden(ORDEN, 'otro@gmail.com').ok, false);
});

caso('🔴 sin mail pedido no abre, aunque la orden traiga el suyo', () => {
  for (const v of [null, undefined, '', '   ', 'victoria', 'victoria@', '@gmail.com', 0, {}, []]) {
    assert.equal(puedeVerLaOrden(ORDEN, v).ok, false, `abrió con ${JSON.stringify(v)}`);
  }
});

caso('🔴 un mail que es PEDAZO del verdadero no abre', () => {
  // Lo cazó un mutante que cambiaba `===` por `includes`. `vic@` está adentro de
  // `victoria@gmail.com` como texto, y es **otra persona**: una comparación por substring deja
  // entrar a cualquiera que sepa un pedazo. La igualdad es la regla, ⛔ no el parecido.
  assert.equal(puedeVerLaOrden(ORDEN, 'vic@gmail.com').ok, false);
  assert.equal(puedeVerLaOrden(ORDEN, 'victoria@gmail.com.ar').ok, false);
});

caso('🔴 el mail VACÍO de los dos lados no abre — el empate de dos "no sé"', () => {
  // Lo cazó un mutante que aflojaba `pareceMail`. Tienda Nube manda `""` —⛔ no `null`— en los
  // campos que nadie llenó, así que una orden con `contact_email: ""` y alguien que manda el
  // campo vacío son **dos cadenas iguales**: sin el filtro de forma, `"" === ""` abre la puerta.
  assert.equal(puedeVerLaOrden({ ...ORDEN, contact_email: '' }, '').ok, false);
  assert.equal(puedeVerLaOrden({ ...ORDEN, contact_email: '   ' }, '   ').ok, false);
  assert.equal(mailDeLaOrden({ contact_email: '' }), null);
});

caso('🔴 una orden que no existe no abre', () => {
  assert.equal(puedeVerLaOrden(null, 'victoria@gmail.com').ok, false);
});

caso('🔴 la comparación NO perdona los puntos de Gmail ni el +tag', () => {
  // Una llave que perdona ensancha el conjunto de strings que abren la puerta.
  assert.equal(puedeVerLaOrden(ORDEN, 'vic.toria@gmail.com').ok, false);
  assert.equal(puedeVerLaOrden(ORDEN, 'victoria+reclamo@gmail.com').ok, false);
});

// ── Lo que sale por la puerta cuando sí abre ─────────────────────────────────

caso('🔴 lo que se le muestra al cliente NO lleva un solo monto', () => {
  const salida = ordenParaElCliente(MAPEADA);
  const texto = JSON.stringify(salida);
  for (const prohibido of ['total', 'price', 'pago', 'subtotal', 'descuento', 'tracking', 'envio', 'cupon']) {
    assert.equal(texto.includes(prohibido), false, `se escapó «${prohibido}»: ${texto}`);
  }
  assert.equal(salida.number, 21033);
  assert.equal(salida.cliente, 'Victoria Singh');
  assert.equal(salida.products[0].sku, 'A1');
});

caso('🔴 el MAIL nunca sale en lo que se le devuelve al cliente', () => {
  // Aunque alguien le pase una orden que TODAVÍA tiene el mail adentro, ⛔ no puede escaparse:
  // la salida se arma campo por campo y ⛔ no filtrando.
  const salida = ordenParaElCliente({ ...MAPEADA, contact_email: 'victoria@gmail.com' });
  assert.equal(JSON.stringify(salida).includes('@'), false);
});

caso('🔴 el diagnóstico contesta SÍ o NO, y ⛔ nunca el mail', () => {
  const d = diagnosticoDeMail(ORDEN);
  assert.equal(d.tiene_mail, true);
  assert.equal(d.number, 21033);
  assert.equal(JSON.stringify(d).includes('@'), false);
  assert.equal(diagnosticoDeMail({ number: 1 }).tiene_mail, false);
  assert.equal(diagnosticoDeMail(null).number, null);
});

caso('el mail de la orden se lee normalizado', () => {
  assert.equal(mailDeLaOrden({ contact_email: '  Victoria@GMAIL.com ' }), 'victoria@gmail.com');
  assert.equal(mailDeLaOrden({}), null);
  assert.equal(normalizar(null), null);
});

console.log(fallas ? `\n${fallas} FALLA(S)` : '\ntodo ok');
process.exit(fallas ? 1 : 0);
