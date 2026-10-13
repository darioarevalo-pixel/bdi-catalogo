// ---------------------------------------------------------------------------
// EL CORREO DE LOS CARRITOS SIN TERMINAR
//
// Pedido de Darío (13-10-2026): que al final del día le llegue por correo quién
// armó un pedido en el catálogo y no lo confirmó, sin tener que entrar al panel.
// Lo dispara el cron de vercel.json una vez por día (23:00 UTC = 20:00 de
// Argentina) y va a las mismas direcciones que el aviso de pedido nuevo
// (`mailAvisoA` del panel, o PEDIDOS_AVISO_A de respaldo).
//
// Entran los carritos tocados en las últimas 24 horas, menos los de un
// teléfono que después confirmó un pedido. Los que tienen teléfono van
// primero y con detalle; los anónimos, solo contados. Si no quedó ninguno, no
// sale nada.
// ---------------------------------------------------------------------------
const SES = require('./_ses.js');
const { mailValido } = require('./_mail-pedido.js');

const MAIL_FROM = process.env.MAIL_FROM || 'BDI Accesorios <info@bdiaccesorios.com.ar>';

function esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function pesos(n) {
  return '$' + Math.round(Number(n) || 0).toLocaleString('es-AR');
}

function hora(iso) {
  const d = new Date(iso);
  if (isNaN(d.getTime())) return '';
  return d.toLocaleString('es-AR', { timeZone: 'America/Argentina/Buenos_Aires', day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
}

/** Los últimos 8 dígitos: alcanza para reconocer el mismo número escrito distinto. */
function digitos(t) { return String(t || '').replace(/\D/g, '').slice(-8); }

/**
 * Elige qué carritos van en el correo.
 * @param carritos  todos los guardados
 * @param pedidos   [{ telefono, fecha }] de los pedidos confirmados
 */
function elegir(carritos, pedidos, ahora) {
  const desde = new Date(ahora - 24 * 3600 * 1000).toISOString();
  const confirmo = (c) => {
    const tel = digitos(c.telefono);
    return tel.length >= 8 && pedidos.some(p => digitos(p.telefono) === tel && String(p.fecha || '') >= String(c.creado || ''));
  };
  const delDia = carritos.filter(c => String(c.actualizado || '') >= desde && !confirmo(c));
  delDia.sort((a, b) => (b.total || 0) - (a.total || 0));
  return {
    conTelefono: delDia.filter(c => c.telefono),
    sinTelefono: delDia.filter(c => !c.telefono),
  };
}

function bloqueCarrito(c) {
  const nombre = c.cliente || c.codigoCliente || 'Sin nombre';
  const renglones = (c.items || []).map(i =>
    '<tr><td style="padding:2px 0;color:#374151;font-size:13px">' + i.cantidad + ' × ' + esc(i.nombre) + (i.variante ? ' — ' + esc(i.variante) : '') + '</td>' +
    '<td style="padding:2px 0 2px 12px;color:#6b7280;font-size:13px;text-align:right;white-space:nowrap">' + pesos(i.precio * i.cantidad) + '</td></tr>'
  ).join('');
  return '<div style="border:1px solid #e5e7eb;border-radius:10px;padding:14px 16px;margin:0 0 12px">' +
    '<table width="100%" cellpadding="0" cellspacing="0"><tr>' +
    '<td style="font-size:15px;font-weight:700;color:#111827">' + esc(nombre) + '</td>' +
    '<td style="font-size:15px;font-weight:700;color:#111827;text-align:right;white-space:nowrap">' + pesos(c.total) + '</td></tr></table>' +
    '<div style="font-size:13px;color:#4f46e5;font-weight:600;margin-top:2px">' + esc(c.telefono) + (c.email ? ' · ' + esc(c.email) : '') + '</div>' +
    '<div style="font-size:12px;color:#6b7280;margin:2px 0 8px">' + hora(c.actualizado) + ' · ' + c.unidades + ' unidades' +
      (c.codigo ? ' · código ' + esc(c.codigo) : '') + (c.llegoADatos ? ' · llegó a cerrar la compra' : '') + '</div>' +
    '<table width="100%" cellpadding="0" cellspacing="0">' + renglones + '</table>' +
    '</div>';
}

function armar(sel, linkPanel) {
  const { conTelefono, sinTelefono } = sel;
  const n = conTelefono.length + sinTelefono.length;
  const asunto = n === 1 ? '1 pedido sin terminar en el catálogo' : n + ' pedidos sin terminar en el catálogo';
  const totalSin = sinTelefono.reduce((s, c) => s + (c.total || 0), 0);

  let html = '<div style="font-family:Arial,Helvetica,sans-serif;max-width:600px;margin:0 auto;padding:20px;color:#111827">' +
    '<h2 style="font-size:18px;margin:0 0 4px">Pedidos sin terminar de hoy</h2>' +
    '<p style="font-size:13px;color:#6b7280;margin:0 0 18px">Armaron un pedido en el catálogo y no lo confirmaron.</p>';
  if (conTelefono.length) html += conTelefono.map(bloqueCarrito).join('');
  if (sinTelefono.length) {
    html += '<p style="font-size:13px;color:#374151;margin:6px 0 18px">' +
      (sinTelefono.length === 1 ? '1 más' : sinTelefono.length + ' más') + ' sin teléfono (no llegaron a escribirlo), por ' + pesos(totalSin) + ' en total.</p>';
  }
  html += '<a href="' + esc(linkPanel) + '" style="display:inline-block;background:#4f46e5;color:#fff;text-decoration:none;padding:10px 18px;border-radius:8px;font-size:14px;font-weight:600">Ver en el panel</a>' +
    '</div>';

  const texto = 'Pedidos sin terminar de hoy\n\n' +
    conTelefono.map(c => (c.cliente || c.codigoCliente || 'Sin nombre') + ' — ' + c.telefono + ' — ' + pesos(c.total) + '\n' +
      (c.items || []).map(i => '  ' + i.cantidad + ' × ' + i.nombre + (i.variante ? ' — ' + i.variante : '')).join('\n')).join('\n\n') +
    (sinTelefono.length ? '\n\n' + sinTelefono.length + ' más sin teléfono, por ' + pesos(totalSin) + '.' : '') +
    '\n\nVer en el panel: ' + linkPanel;
  return { asunto, html, texto };
}

/** Manda el resumen. Devuelve { ok, enviados, motivo }. Nunca tira. */
async function mandarResumen(carritos, pedidos, destinatarios, linkPanel) {
  const sel = elegir(carritos, pedidos, Date.now());
  const n = sel.conTelefono.length + sel.sinTelefono.length;
  if (!n) return { ok: true, enviados: 0, motivo: 'no hubo carritos sin terminar' };
  const a = String(destinatarios || '').split(/[,;\s]+/).map(x => x.trim()).filter(mailValido);
  if (!a.length) return { ok: false, motivo: 'sin destinatarios' };
  const { asunto, html, texto } = armar(sel, linkPanel);
  const r = await Promise.all(a.map(to => SES.mandarMail({ from: MAIL_FROM, to, subject: asunto, html, text: texto })));
  const mal = r.filter(x => !x.ok);
  return mal.length ? { ok: false, motivo: mal.map(x => x.motivo).join(' | ') } : { ok: true, enviados: n };
}

module.exports = { elegir, armar, mandarResumen };
