// ---------------------------------------------------------------------------
// EL MAIL DE "RECIBIMOS TU PEDIDO"
//
// Pedido de Darío (30-9-2026): que a cada cliente le llegue un mail con la
// compra que hizo. Sale por Amazon SES (el mismo que usa el mailer de
// marketing; ver _ses.js). Siempre SES: es la decisión de Bruno.
//
// Variables en Vercel:
//   · las de AWS de _ses.js → sin ellas no se manda nada (y el pedido sigue igual).
//   · MAIL_FROM       → quién firma. Por defecto BDI Accesorios <info@bdiaccesorios.com.ar>.
//   · MAIL_REPLY_TO   → opcional: a dónde va si el cliente contesta.
//
// El mail NO repite el pedido renglón por renglón con fotos: un pedido
// mayorista tiene decenas de renglones y el detalle vivo ya está en el link
// (que se actualiza si se corrige la venta en Gestión Nube). Acá va el resumen
// del momento de confirmar y el botón al link.
// ---------------------------------------------------------------------------

const SES = require('./_ses.js');

const MAIL_FROM = process.env.MAIL_FROM || 'BDI Accesorios <info@bdiaccesorios.com.ar>';

/** Formato mínimo razonable; el que manda de verdad es el proveedor. */
function mailValido(m) {
  return typeof m === 'string' && m.length <= 200 && /^[^\s@<>()",;:]+@[^\s@<>()",;:]+\.[a-z]{2,}$/i.test(m);
}

function esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function pesos(n) {
  const v = Math.round(Number(n) || 0);
  return '$' + v.toLocaleString('es-AR');
}

function armarMail(pedido, link) {
  const items = Array.isArray(pedido.items) ? pedido.items : [];
  const unidades = items.reduce((s, i) => s + (Number(i.cantidad) || 0), 0);
  const filas = items.map(i => {
    const cant = Number(i.cantidad) || 0;
    return '<tr>' +
      '<td style="padding:6px 8px;border-bottom:1px solid #eee">' + esc(i.nombre) +
        (i.variante ? '<br><span style="color:#777;font-size:12px">' + esc(i.variante) + '</span>' : '') + '</td>' +
      '<td style="padding:6px 8px;border-bottom:1px solid #eee;text-align:center">' + cant + '</td>' +
      '<td style="padding:6px 8px;border-bottom:1px solid #eee;text-align:right;white-space:nowrap">' + pesos((Number(i.precio) || 0) * cant) + '</td>' +
      '</tr>';
  }).join('');

  const descuento = pedido.cupon && pedido.cupon.descuento ? Number(pedido.cupon.descuento) : 0;
  const nombre = String(pedido.cliente || '').split(' ')[0];

  const html =
    '<div style="font-family:Arial,Helvetica,sans-serif;max-width:600px;margin:0 auto;color:#222">' +
    '<h2 style="margin:0 0 4px">¡Recibimos tu pedido' + (nombre ? ', ' + esc(nombre) : '') + '!</h2>' +
    '<p style="margin:0 0 16px;color:#555">Pedido N° <b>' + esc(pedido.id) + '</b> · ' + unidades + ' unidades</p>' +
    '<p style="margin:0 0 16px">Ya lo tenemos. Te vamos a escribir por WhatsApp para coordinar el pago y la entrega.</p>' +
    (link ? '<p style="margin:0 0 20px"><a href="' + esc(link) + '" style="display:inline-block;background:#111;color:#fff;text-decoration:none;padding:10px 18px;border-radius:6px">Ver mi pedido</a></p>' : '') +
    '<table style="width:100%;border-collapse:collapse;font-size:14px">' +
      '<tr style="background:#f5f5f5"><th style="padding:6px 8px;text-align:left">Producto</th><th style="padding:6px 8px">Cant.</th><th style="padding:6px 8px;text-align:right">Importe</th></tr>' +
      filas +
    '</table>' +
    '<table style="width:100%;font-size:14px;margin-top:10px">' +
      (descuento ? '<tr><td>Subtotal</td><td style="text-align:right">' + pesos(pedido.subtotal) + '</td></tr>' +
        '<tr><td>Cupón ' + esc(pedido.cupon.codigo) + '</td><td style="text-align:right">-' + pesos(descuento) + '</td></tr>' : '') +
      (pedido.cupon && pedido.cupon.tipo === 'envio' ? '<tr><td colspan="2">Envío bonificado (' + esc(pedido.cupon.codigo) + ')</td></tr>' : '') +
      '<tr><td style="font-weight:bold;padding-top:6px">Total</td><td style="text-align:right;font-weight:bold;padding-top:6px">' + pesos(pedido.total) + '</td></tr>' +
    '</table>' +
    '<p style="font-size:14px;margin:16px 0 0"><b>Pago:</b> ' + esc(pedido.pago) + '<br><b>Entrega:</b> ' + esc(pedido.entrega) +
      (pedido.obs ? '<br><b>Observaciones:</b> ' + esc(pedido.obs) : '') + '</p>' +
    '<p style="font-size:12px;color:#888;margin-top:24px">El detalle del link se actualiza si hay que corregir algo del pedido (por ejemplo, por stock).</p>' +
    '</div>';

  const texto =
    '¡Recibimos tu pedido!\n\nPedido N° ' + pedido.id + ' · ' + unidades + ' unidades\n' +
    items.map(i => '· ' + i.nombre + (i.variante ? ' (' + i.variante + ')' : '') + ' x' + (Number(i.cantidad) || 0)).join('\n') +
    '\n\nTotal: ' + pesos(pedido.total) + '\nPago: ' + (pedido.pago || '') + '\nEntrega: ' + (pedido.entrega || '') +
    (link ? '\n\nVer mi pedido: ' + link : '') +
    '\n\nTe vamos a escribir por WhatsApp para coordinar.';

  return { asunto: 'Recibimos tu pedido N° ' + pedido.id + ' — BDI Accesorios', html, texto };
}

/** Manda el mail. Devuelve { ok } o { ok:false, motivo }. Nunca tira. */
async function mandarMailPedido(pedido, link) {
  if (!mailValido(pedido.email)) return { ok: false, motivo: 'mail inválido' };
  const { asunto, html, texto } = armarMail(pedido, link);
  return SES.mandarMail({
    from: MAIL_FROM, to: pedido.email, subject: asunto, html, text: texto,
    replyTo: process.env.MAIL_REPLY_TO || '',
  });
}

module.exports = { mailValido, armarMail, mandarMailPedido };
