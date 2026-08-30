/**
 * **La llave del alta pública: orden + mail.** ¿Puede quien pregunta ver esta orden?
 *
 * # Por qué existe
 *
 * El alta pública de Reclamos deja que el cliente abra su propio caso desde un link, sin login. El
 * número de orden **solo no alcanza**: es correlativo, así que tipear el de al lado es adivinar el
 * pedido de otra persona. Lo único que sabe el que compró y ⛔ no sabe el de al lado es **el mail
 * con el que compró** — y ya está en el 99% de las ventas online (280 de 283 en agosto de 2026), o
 * sea que ⛔ no hay que pedirle un dato nuevo a nadie: sirve de llave.
 *
 * # 🔑 El mail ya llegaba, y se tiraba
 *
 * `tnFetchOrden` pide la orden completa a Tienda Nube **sin `fields`** (con `fields` el GET por id
 * da 404), así que TN manda todo lo que tiene y `mapOrdenTN` se queda con 25 campos elegidos a
 * mano. El mail del comprador venía en esa respuesta y se descartaba una línea después. ⇒ acá
 * ⛔ **no se le pide nada nuevo a TN**: se compara lo que ya estaba en la mano, antes de tirarlo.
 *
 * # 🔴 FALLA CERRADO, y las tres puertas contestan IGUAL
 *
 * `puedeVerLaOrden` deja pasar **sólo** cuando hay un mail pedido, la orden trae uno, y los dos son
 * el mismo. Cualquier otra cosa —incluida **«la orden ⛔ no trae mail»**— es que no pasa. Esa
 * tercera es la que importa: si un pedido viejo o de un canal raro viniera sin mail, un `if` escrito
 * al revés lo dejaría abierto **a cualquiera**, que es exactamente el caso en que menos se mira.
 *
 * ⚠️ **El `motivo` es para el servidor, ⛔ NUNCA para la respuesta.** Las tres puertas cerradas
 * tienen que verse idénticas desde afuera: contestar «el mail no coincide» convierte al endpoint en
 * un oráculo de *«¿existe esta orden?»* sobre una numeración correlativa. Mismo criterio que el
 * 404 pelado del portal del cliente (`api/_reclamo.js` del monitor).
 *
 * # ⛔ Lo que la comparación NO hace, a propósito
 *
 * Normaliza **sólo** los espacios y las mayúsculas — dos cosas que ⛔ no cambian a quién le llega
 * el mail. ⛔ **No** saca los puntos de Gmail ni lo que va después de un `+`: cada indulgencia que
 * se le agregue a esta comparación **ensancha el conjunto de strings que abren la puerta**. Una
 * llave que perdona ⛔ no es una llave.
 */

/**
 * Dónde vive el mail del comprador en una orden de Tienda Nube.
 *
 * ⚠️ Son varios lugares porque TN ⛔ no siempre llena el mismo: `contact_email` es el del checkout
 * —hermano de `contact_name`, que este repo ya usa para el nombre— y `customer.email` es el de la
 * cuenta, que existe sólo si la persona tiene una. Se prueban **en ese orden** y se corta con el
 * primero que sirva.
 */
const CAMPOS_MAIL = [
  o => o && o.contact_email,
  o => o && o.customer && o.customer.email,
  o => o && o.email,
];

/** ¿Esto se parece a un mail? Un umbral bajo a propósito: acá ⛔ no se valida, se compara. */
function pareceMail(s) {
  return typeof s === 'string' && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s.trim());
}

/**
 * El mail que trae la orden, normalizado. `null` si ⛔ no trae ninguno que sirva — y ese `null`
 * **cierra la puerta**, ⛔ no la abre.
 */
function mailDeLaOrden(orden) {
  for (const donde of CAMPOS_MAIL) {
    const v = donde(orden);
    if (pareceMail(v)) return normalizar(v);
  }
  return null;
}

/** Espacios y mayúsculas, nada más. Ver el ⛔ del encabezado antes de agregarle indulgencias. */
function normalizar(mail) {
  return typeof mail === 'string' ? mail.trim().toLowerCase() : null;
}

/**
 * ¿Se le puede mostrar esta orden a quien dijo ser el dueño del mail `mailPedido`?
 *
 * @returns {{ok: boolean, motivo: string}} — `motivo` es **para el log del servidor**. ⛔ Nunca
 *   viaja en la respuesta: las tres razones de un `false` tienen que ser indistinguibles desde
 *   afuera.
 */
function puedeVerLaOrden(orden, mailPedido) {
  if (!orden) return { ok: false, motivo: 'no-existe' };
  const pedido = normalizar(mailPedido);
  if (!pareceMail(pedido)) return { ok: false, motivo: 'sin-mail-pedido' };
  const suyo = mailDeLaOrden(orden);
  // 🔴 La orden sin mail ⛔ NO pasa. Es la puerta que se abriría sola si esto fuera `if (suyo && ...)`.
  if (!suyo) return { ok: false, motivo: 'la-orden-no-trae-mail' };
  return suyo === pedido ? { ok: true, motivo: 'coincide' } : { ok: false, motivo: 'no-coincide' };
}

/**
 * **Lo único que ve el cliente de su propia orden.**
 *
 * ⚠️ **Recibe la orden YA MAPEADA** (la que sale de `mapOrdenTN`), ⛔ no la cruda de Tienda Nube —
 * al revés que `puedeVerLaOrden`, que necesita la cruda porque el mapper **tira el mail**. Son dos
 * entradas distintas a propósito y por eso está dicho acá: el orden es *comparar sobre la cruda,
 * después mapear, después recortar*. Se arma campo por campo, ⛔ no filtrando: lo
 * que ⛔ no está acá no puede escaparse el día que alguien agregue una columna al mapper.
 *
 * ⛔ **Sin un solo monto** —ni total, ni subtotal, ni descuentos, ni forma de pago, ni tracking—:
 * el alta pública necesita saber **qué compró**, ⛔ no cuánto pagó. Lo que decide plata se decide
 * adentro, con la evidencia delante, y agregar un número acá es agrandar lo que se filtra el día
 * que la llave falle.
 */
function ordenParaElCliente(orden) {
  if (!orden) return null;
  return {
    number: orden.number,
    cliente: orden.cliente || null,
    products: (orden.products || []).map(p => ({
      product_id: p.product_id,
      variant_id: p.variant_id,
      name: p.name,
      sku: p.sku,
      quantity: p.quantity,
    })),
  };
}

/**
 * **El diagnóstico: ¿esta orden trae mail?** Sí o no, y ⛔ nunca cuál.
 *
 * 🔑 **La forma vive acá y ⛔ no en un objeto suelto adentro del handler**, por la misma razón que
 * `ordenParaElCliente`: lo que sale del servidor es una regla. Escrito inline, cambiar el `!!` por
 * el valor —para "debuggear un minuto"— publica el mail del comprador y ⛔ no hay nada que se ponga
 * rojo. Acá lo mira un test.
 */
function diagnosticoDeMail(orden) {
  return { tiene_mail: !!mailDeLaOrden(orden), number: (orden && orden.number) || null };
}

module.exports = { puedeVerLaOrden, mailDeLaOrden, ordenParaElCliente, diagnosticoDeMail, normalizar, pareceMail };
