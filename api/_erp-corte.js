// ===== El catálogo el día del corte de BDI =====
// Hasta el corte, el catálogo lee y vende en Gestión Nube, como siempre. Desde el corte
// (lo decide el ERP con `erp_corte`, sin tocar ninguna variable) lee el catálogo y el
// stock del ERP y el pedido nace ahí. Bruno 1-nov: todo se prende solo con el corte.
//
// El lector del ERP contesta con la misma forma que GN, así que el proxy sólo cambia
// la dirección y la llave.
//
// Si el ERP no contesta, se usa lo último que se supo: primero en memoria y, en una
// instancia nueva, lo guardado en el KV. Sin dato, sigue GN (hoy el estado normal).
// Un corte ya visto no vuelve atrás por una caída: eso mandaría ventas a GN sin que
// nadie se entere. Lo vuelve atrás el ERP, contestando que no manda (`ERP_NO_MANDA`).
//
// Empieza con "_": no es ruta y no cuenta contra el límite de funciones (ver _kv.js).

const CACHE_MS = 30 * 1000;
const REINTENTO_MS = 10 * 1000;
const ESPERA_CORTE_MS = 1500;
const ESPERA_PEDIDO_MS = 15 * 1000;
const CLAVE_KV = 'erp:catalogo-manda';

const SIN_PERDER = 'Tu pedido NO se perdió: quedó guardado en el carrito. Esperá un minuto y tocá Confirmar de nuevo. Si vuelve a pasar, escribinos por WhatsApp.';

function crear({ fetch: pedir = (...a) => fetch(...a), env = process.env, kvCmd, ahora = Date.now } = {}) {
  const erpUrl = () => env.ERP_URL || 'https://erp.arebensrl.com';
  let memo = null;

  async function guardado() {
    try { const r = await kvCmd(['GET', CLAVE_KV]); return !!r && r.result === '1'; } catch { return false; }
  }

  // ¿El ERP manda el catálogo de BDI? Nunca tira.
  async function erpManda() {
    const llave = env.ERP_LLAVE_CATALOGO;
    if (!llave) return false;
    if (memo && ahora() - memo.en < memo.dura) return memo.manda;
    try {
      const r = await pedir(erpUrl() + '/api/v1/corte/obtener', {
        headers: { Authorization: 'Bearer ' + llave },
        signal: AbortSignal.timeout(ESPERA_CORTE_MS),
      });
      if (!r.ok) throw new Error('contestó ' + r.status);
      const d = await r.json();
      if (typeof d.erp_manda !== 'boolean') throw new Error('respuesta sin erp_manda');
      if (!memo || memo.manda !== d.erp_manda) {
        console.log(`[erp] el catálogo lee de ${d.erp_manda ? 'el ERP' : 'Gestión Nube'}`);
        try { await kvCmd(['SET', CLAVE_KV, d.erp_manda ? '1' : '0']); } catch (e) { console.error('[erp] no se pudo anotar en el KV:', (e && e.message) || e); }
      }
      memo = { manda: d.erp_manda, en: ahora(), dura: CACHE_MS };
      return memo.manda;
    } catch (e) {
      const manda = memo ? memo.manda : await guardado();
      console.error(`[erp] no se pudo saber quién manda (${(e && e.message) || e}): sigue ${manda ? 'el ERP' : 'Gestión Nube'}`);
      memo = { manda, en: ahora(), dura: REINTENTO_MS };
      return manda;
    }
  }

  // La dirección que corresponde a cada llave. Todo el proxy pasa el token: con esto alcanza.
  const baseDe = (token, baseGN) => (env.ERP_LLAVE_CATALOGO && token === env.ERP_LLAVE_CATALOGO ? erpUrl() + '/api/v1' : baseGN);

  // Crea el pedido en el ERP y contesta como GN, porque de ahí leen el número las dos
  // pantallas. Reintentar es seguro: el ERP reconoce el pedido por su `clave`.
  async function crearPedido({ pedido, datosErp, esAdmin }) {
    const clave = datosErp && datosErp.clave;
    if (!clave) return { status: 400, cuerpo: { error: 'Falta la clave del pedido', detalle: 'Recargá la página y volvé a confirmar.' } };
    const cuerpo = JSON.stringify({
      origen: esAdmin ? 'admin' : 'catalogo',
      ...datosErp,
      pedido: { store_id: pedido.store_id, items: pedido.items },
    });
    let ultimo = 'sin respuesta';
    for (let intento = 1; intento <= 2; intento++) {
      try {
        const r = await pedir(erpUrl() + '/api/pedido-mayorista', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'x-erp-llave': env.ERP_LLAVE_CATALOGO },
          body: cuerpo,
          signal: AbortSignal.timeout(ESPERA_PEDIDO_MS),
        });
        const d = await r.json().catch(() => ({}));
        if (r.ok && d.numero) {
          console.log(`[erp] pedido ${d.numero} creado en el ERP${d.entro ? ', reservado' : ` sin entrar (${d.motivo || '?'})`}`);
          return { status: 200, cuerpo: { data: { id: d.numero, number: d.numero, erp: true } } };
        }
        ultimo = 'contestó ' + r.status;
        if (r.status < 500) break;
      } catch (e) { ultimo = (e && e.message) || String(e); }
    }
    console.error(`[erp] el pedido no se pudo crear: ${ultimo}`);
    return { status: 503, cuerpo: { error: 'No pudimos registrar tu pedido', detalle: SIN_PERDER } };
  }

  return { erpManda, baseDe, crearPedido };
}

const { kvCmd } = require('./_kv');
module.exports = { ...crear({ kvCmd }), crear };
