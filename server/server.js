require('dotenv').config();
const express = require('express');
const cors    = require('cors');
const path    = require('path');
const stripe  = require('stripe')(process.env.STRIPE_SECRET_KEY);

const app = express();

const SUPABASE_URL         = 'https://jnztchhwexxfjlrfgcvy.supabase.co';
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;

const ROLE_DISCOUNTS = {
  'colaborador': 5,
  'profesional': 10,
  'distribuidor': 15,
  'cliente20':   20,
  'cliente25':   25,
  'cliente30':   30
};

// ── Helpers Supabase ─────────────────────────────────────────────────

async function sbInsert(table, data) {
  if (!SUPABASE_SERVICE_KEY) return null;
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${table}`, {
    method: 'POST',
    headers: {
      'apikey':        SUPABASE_SERVICE_KEY,
      'Authorization': 'Bearer ' + SUPABASE_SERVICE_KEY,
      'Content-Type':  'application/json',
      'Prefer':        'return=representation'
    },
    body: JSON.stringify(data)
  });
  if (!res.ok) throw new Error('Supabase INSERT ' + table + ': ' + await res.text());
  return res.json();
}

async function sbPatch(table, id, data) {
  if (!SUPABASE_SERVICE_KEY) return;
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${table}?id=eq.${id}`, {
    method: 'PATCH',
    headers: {
      'apikey':        SUPABASE_SERVICE_KEY,
      'Authorization': 'Bearer ' + SUPABASE_SERVICE_KEY,
      'Content-Type':  'application/json',
      'Prefer':        'return=minimal'
    },
    body: JSON.stringify(data)
  });
  if (!res.ok) throw new Error('Supabase PATCH ' + table + ': ' + await res.text());
}

async function sbGetUserRole(userId) {
  if (!SUPABASE_SERVICE_KEY || !userId) return '';
  try {
    const res = await fetch(`${SUPABASE_URL}/rest/v1/profiles?id=eq.${userId}&select=role&limit=1`, {
      headers: {
        'apikey':        SUPABASE_SERVICE_KEY,
        'Authorization': 'Bearer ' + SUPABASE_SERVICE_KEY
      }
    });
    if (!res.ok) return '';
    const rows = await res.json();
    return rows?.[0]?.role || '';
  } catch(e) { return ''; }
}

// ── Stripe webhook (raw body — DEBE ir antes de express.json()) ──────

app.post('/webhook', express.raw({ type: 'application/json' }), async (req, res) => {
  const sig           = req.headers['stripe-signature'];
  const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET;

  let event;
  try {
    event = stripe.webhooks.constructEvent(req.body, sig, webhookSecret);
  } catch (err) {
    console.error('Webhook signature error:', err.message);
    return res.status(400).send('Webhook Error: ' + err.message);
  }

  if (event.type === 'checkout.session.completed') {
    const session = event.data.object;
    const orderId = parseInt(session.metadata?.order_id);

    console.log('✅ Pago completado. Stripe session:', session.id, '| Order ID:', orderId);

    if (orderId && SUPABASE_SERVICE_KEY) {
      try {
        await sbPatch('orders', orderId, { status: 'processing' });
        console.log('✅ Pedido #' + orderId + ' actualizado a "processing" en Supabase');
      } catch (e) {
        console.error('Error actualizando pedido en Supabase:', e.message);
      }
    }
  }

  res.json({ received: true });
});

// ── Middlewares generales ────────────────────────────────────────────

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, '../Nueva carpeta')));

// ── Helpers ──────────────────────────────────────────────────────────

function generateOrderRef() {
  const year   = new Date().getFullYear();
  const suffix = Date.now().toString(36).toUpperCase().slice(-6);
  return `LPT-${year}-${suffix}`;
}

// ── Convertidores de precio ──────────────────────────────────────────

function parsePriceToCents(str) {
  if (!str) return 0;
  const num = parseFloat(str.replace(/\./g, '').replace(',', '.').replace(/[^0-9.]/g, ''));
  return Math.round(num * 100);
}

function parsePriceToEuros(str) {
  if (!str) return 0;
  return parseFloat(str.replace(/\./g, '').replace(',', '.').replace(/[^0-9.]/g, '')) || 0;
}

// ── POST /create-checkout-session ───────────────────────────────────

app.post('/create-checkout-session', async (req, res) => {
  try {
    const { items, customerEmail, customerName, customerPhone, shippingCost, userId, notes } = req.body;

    if (!items || items.length === 0) {
      return res.status(400).json({ error: 'El carrito está vacío' });
    }

    // Descuento por rol
    const userRole   = await sbGetUserRole(userId);
    const discountPct = ROLE_DISCOUNTS[userRole] || 0;
    const discountMultiplier = 1 - discountPct / 100;

    // 1. Guardar pedido pendiente en Supabase
    let orderId = null;
    const subtotal    = items.reduce((sum, i) => {
      const price = parsePriceToEuros(i.price);
      return sum + Math.round(price * discountMultiplier * 100) / 100 * (i.qty || 1);
    }, 0);
    const shippingAmt = shippingCost || 0;
    const total       = Math.round((subtotal + shippingAmt) * 100) / 100;

    if (SUPABASE_SERVICE_KEY) {
      try {
        const orderData = {
          order_reference: generateOrderRef(),
          user_id:         userId        || null,
          customer_name:   customerName  || 'Cliente',
          customer_email:  customerEmail || null,
          customer_phone:  customerPhone || null,
          status:          'pending',
          subtotal:        Math.round(subtotal * 100) / 100,
          shipping_cost:   shippingAmt,
          total,
          currency:        'EUR',
          notes:           notes         || null,
        };
        console.log('orderData', orderData);

        const orderRows = await sbInsert('orders', orderData);
        console.log('order insert result', orderRows);
        orderId = orderRows?.[0]?.id || null;

        if (orderId && items.length) {
          await sbInsert('order_items', items.map(item => {
            const unitPrice = Math.round(parsePriceToEuros(item.price) * discountMultiplier * 100) / 100;
            const qty       = item.qty || 1;
            return {
              order_id:      orderId,
              product_id:    item.id || null,
              product_title: item.title,
              variant_label: item.options?.map(o => `${o.label}: ${o.value}`).join(' | ') || null,
              quantity:      qty,
              unit_price:    unitPrice,
              total_price:   Math.round(unitPrice * qty * 100) / 100
            };
          }));
        }

        console.log('📦 Pedido #' + orderId + ' (' + orderData.order_reference + ') guardado en Supabase' + (discountPct ? ` [descuento ${discountPct}% — ${userRole}]` : ''));

        const enrichedItems = items.map(item => {
          const unitPrice = Math.round(parsePriceToEuros(item.price) * discountMultiplier * 100) / 100;
          return {
            product_title: item.title,
            variant_label: item.options?.map(o => `${o.label}: ${o.value}`).join(' | ') || null,
            quantity:      item.qty || 1,
            unit_price:    unitPrice,
            total_price:   Math.round(unitPrice * (item.qty || 1) * 100) / 100
          };
        });
        const enrichedOrder = { ...orderData, id: orderId };

        // Notificar a la empresa del nuevo pedido
        sendNewOrderNotification(enrichedOrder, enrichedItems)
          .catch(e => console.error('Error enviando notificación a empresa:', e.message));

        // Confirmación de pedido al cliente
        if (customerEmail) {
          sendOrderConfirmationToCustomer(enrichedOrder, enrichedItems)
            .catch(e => console.error('Error enviando confirmación al cliente:', e.message));
        }

      } catch (e) {
        console.error('order insert error', e.message);
        // Continuamos igualmente — el pago no debe bloquearse por un error de BD
      }
    } else {
      console.warn('⚠️  SUPABASE_SERVICE_KEY no configurada — el pedido no se guardará en la BD');
    }

    // 2. Construir líneas de Stripe
    const lineItems = items.map(item => {
      const unitAmount  = Math.round(parsePriceToCents(item.price) * discountMultiplier);
      const description = item.options?.length
        ? item.options.map(o => `${o.label}: ${o.value}`).join(' | ')
        : undefined;
      return {
        price_data: {
          currency:     'eur',
          product_data: {
            name: item.title.length > 100 ? item.title.slice(0, 97) + '...' : item.title,
            ...(description && { description })
          },
          unit_amount: unitAmount
        },
        quantity: item.qty || 1
      };
    });

    if (shippingCost && shippingCost > 0) {
      lineItems.push({
        price_data: {
          currency:     'eur',
          product_data: { name: 'Envío express' },
          unit_amount:  Math.round(shippingCost * 100)
        },
        quantity: 1
      });
    }

    const frontendUrl = process.env.FRONTEND_URL || 'http://localhost:3000';

    // 3. Crear sesión de Stripe pasando el order_id como metadata
    const session = await stripe.checkout.sessions.create({
      payment_method_types: ['card'],
      line_items:           lineItems,
      mode:                 'payment',
      customer_email:       customerEmail || undefined,
      metadata:             { order_id: String(orderId || '') },
      success_url:          `${frontendUrl}/success.html?session_id={CHECKOUT_SESSION_ID}`,
      cancel_url:           `${frontendUrl}/checkout.html`
    });

    res.json({ url: session.url });

  } catch (err) {
    console.error('Error Stripe:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── Notificación de nuevo pedido a la empresa ────────────────────────

async function sendNewOrderNotification(order, items) {
  if (!process.env.RESEND_API_KEY || !process.env.ADMIN_ORDERS_EMAIL) {
    console.warn('⚠️  ADMIN_ORDERS_EMAIL o RESEND_API_KEY no configurados — no se enviará aviso a la empresa');
    return;
  }

  const adminUrl = `${process.env.FRONTEND_URL || 'http://localhost:3000'}/admin/order-detail.html?id=${order.id}`;

  const itemRows = items.map(i => `
    <tr>
      <td style="padding:9px 14px;border-bottom:1px solid #e2e8f0;color:#2d3748">
        <strong>${i.product_title}</strong>
        ${i.variant_label ? `<div style="font-size:0.8rem;color:#718096;margin-top:2px">${i.variant_label}</div>` : ''}
      </td>
      <td style="padding:9px 14px;border-bottom:1px solid #e2e8f0;text-align:center;color:#2d3748">${i.quantity}</td>
      <td style="padding:9px 14px;border-bottom:1px solid #e2e8f0;text-align:right;color:#2d3748">${Number(i.unit_price).toFixed(2)} €</td>
      <td style="padding:9px 14px;border-bottom:1px solid #e2e8f0;text-align:right;font-weight:700;color:#2d3748">${Number(i.total_price || i.unit_price * i.quantity).toFixed(2)} €</td>
    </tr>`).join('');

  const emailHtml = `<!DOCTYPE html>
<html lang="es">
<head><meta charset="UTF-8"/></head>
<body style="margin:0;padding:0;background:#f7fafc;font-family:Inter,Arial,sans-serif">
  <div style="max-width:600px;margin:32px auto;background:#ffffff;border-radius:12px;overflow:hidden;box-shadow:0 4px 24px rgba(0,0,0,0.08)">

    <div style="background:linear-gradient(135deg,#0066ff,#00d4ff);padding:28px 36px">
      <h1 style="margin:0;color:#fff;font-size:1.3rem;font-weight:800">🛒 Nuevo pedido recibido</h1>
      <p style="margin:6px 0 0;color:rgba(255,255,255,0.85);font-size:0.9rem">Se ha creado un pedido nuevo en la tienda</p>
    </div>

    <div style="padding:32px 36px">

      <!-- Referencia y total -->
      <div style="display:flex;justify-content:space-between;align-items:center;background:#f7fafc;border:1px solid #e2e8f0;border-radius:8px;padding:16px 20px;margin-bottom:24px">
        <div>
          <div style="font-size:0.73rem;color:#718096;text-transform:uppercase;letter-spacing:0.06em;font-weight:700;margin-bottom:3px">Referencia</div>
          <div style="font-size:1.1rem;font-weight:800;color:#0066ff">${order.order_reference}</div>
        </div>
        <div style="text-align:right">
          <div style="font-size:0.73rem;color:#718096;text-transform:uppercase;letter-spacing:0.06em;font-weight:700;margin-bottom:3px">Total</div>
          <div style="font-size:1.2rem;font-weight:800;color:#2d3748">${Number(order.total).toFixed(2)} €</div>
        </div>
      </div>

      <!-- Datos del cliente -->
      <div style="margin-bottom:24px">
        <div style="font-size:0.73rem;color:#718096;text-transform:uppercase;letter-spacing:0.06em;font-weight:700;margin-bottom:10px">Cliente</div>
        <table style="width:100%;border-collapse:collapse;font-size:0.9rem">
          <tr><td style="padding:4px 0;color:#718096;width:140px">Nombre</td><td style="padding:4px 0;color:#2d3748;font-weight:600">${order.customer_name || '—'}</td></tr>
          <tr><td style="padding:4px 0;color:#718096">Email</td><td style="padding:4px 0;color:#2d3748">${order.customer_email || '—'}</td></tr>
          <tr><td style="padding:4px 0;color:#718096">Teléfono</td><td style="padding:4px 0;color:#2d3748">${order.customer_phone || '—'}</td></tr>
        </table>
      </div>

      <!-- Productos -->
      <div style="margin-bottom:28px">
        <div style="font-size:0.73rem;color:#718096;text-transform:uppercase;letter-spacing:0.06em;font-weight:700;margin-bottom:10px">Productos</div>
        <table style="width:100%;border-collapse:collapse;font-size:0.88rem">
          <thead>
            <tr style="background:#f7fafc">
              <th style="padding:8px 14px;text-align:left;color:#718096;font-weight:600;font-size:0.78rem;border-bottom:2px solid #e2e8f0">Producto</th>
              <th style="padding:8px 14px;text-align:center;color:#718096;font-weight:600;font-size:0.78rem;border-bottom:2px solid #e2e8f0">Cant.</th>
              <th style="padding:8px 14px;text-align:right;color:#718096;font-weight:600;font-size:0.78rem;border-bottom:2px solid #e2e8f0">P. unit.</th>
              <th style="padding:8px 14px;text-align:right;color:#718096;font-weight:600;font-size:0.78rem;border-bottom:2px solid #e2e8f0">Total</th>
            </tr>
          </thead>
          <tbody>${itemRows}</tbody>
          <tfoot>
            ${order.shipping_cost > 0 ? `<tr><td colspan="3" style="padding:8px 14px;text-align:right;color:#718096;font-size:0.83rem">Envío</td><td style="padding:8px 14px;text-align:right;color:#2d3748">${Number(order.shipping_cost).toFixed(2)} €</td></tr>` : ''}
            <tr style="background:#f7fafc">
              <td colspan="3" style="padding:10px 14px;text-align:right;font-weight:700;color:#2d3748">TOTAL</td>
              <td style="padding:10px 14px;text-align:right;font-weight:800;font-size:1rem;color:#0066ff">${Number(order.total).toFixed(2)} €</td>
            </tr>
          </tfoot>
        </table>
      </div>

      <!-- CTA -->
      <div style="text-align:center">
        <a href="${adminUrl}" style="display:inline-block;background:linear-gradient(135deg,#0066ff,#00d4ff);color:#fff;text-decoration:none;padding:13px 28px;border-radius:8px;font-weight:700;font-size:0.95rem">Ver pedido en el panel admin</a>
      </div>

    </div>

    <div style="background:#f7fafc;border-top:1px solid #e2e8f0;padding:14px 36px;text-align:center;font-size:0.77rem;color:#a0aec0">
      Notificación automática — Panel de administración Letreros Programables
    </div>
  </div>
</body>
</html>`;

  const emailRes = await fetch('https://api.resend.com/emails', {
    method:  'POST',
    headers: { 'Authorization': 'Bearer ' + process.env.RESEND_API_KEY, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      from:    process.env.EMAIL_FROM || 'onboarding@resend.dev',
      to:      [process.env.ADMIN_ORDERS_EMAIL],
      subject: `🛒 Nuevo pedido ${order.order_reference} — ${Number(order.total).toFixed(2)} €`,
      html:    emailHtml
    })
  });

  if (!emailRes.ok) {
    const err = await emailRes.json().catch(() => ({}));
    throw new Error(err.message || JSON.stringify(err));
  }
  console.log('✅ Notificación de nuevo pedido enviada a ' + process.env.ADMIN_ORDERS_EMAIL);
}

// ── Confirmación de pedido al cliente ───────────────────────────────

async function sendOrderConfirmationToCustomer(order, items) {
  if (!process.env.RESEND_API_KEY || !order.customer_email) return;

  const itemRows = items.map(i => `
    <tr>
      <td style="padding:9px 14px;border-bottom:1px solid #e2e8f0;color:#2d3748">
        <strong>${i.product_title}</strong>
        ${i.variant_label ? `<div style="font-size:0.78rem;color:#718096;margin-top:2px">${i.variant_label}</div>` : ''}
      </td>
      <td style="padding:9px 14px;border-bottom:1px solid #e2e8f0;text-align:center;color:#2d3748">${i.quantity}</td>
      <td style="padding:9px 14px;border-bottom:1px solid #e2e8f0;text-align:right;font-weight:700;color:#2d3748">${Number(i.total_price || i.unit_price * i.quantity).toFixed(2)} €</td>
    </tr>`).join('');

  const shippingRow = order.shipping_cost > 0
    ? `<tr><td colspan="2" style="padding:8px 14px;text-align:right;color:#718096;font-size:0.83rem">Envío</td><td style="padding:8px 14px;text-align:right;color:#2d3748">${Number(order.shipping_cost).toFixed(2)} €</td></tr>`
    : `<tr><td colspan="2" style="padding:8px 14px;text-align:right;color:#718096;font-size:0.83rem">Envío</td><td style="padding:8px 14px;text-align:right;color:#22c55e;font-weight:600">Gratis</td></tr>`;

  const emailHtml = `<!DOCTYPE html>
<html lang="es">
<head><meta charset="UTF-8"/><meta name="viewport" content="width=device-width,initial-scale=1"/></head>
<body style="margin:0;padding:0;background:#f7fafc;font-family:Inter,Arial,sans-serif">
  <div style="max-width:600px;margin:40px auto;background:#ffffff;border-radius:12px;overflow:hidden;box-shadow:0 4px 24px rgba(0,0,0,0.08)">

    <!-- Cabecera -->
    <div style="background:linear-gradient(135deg,#0066ff,#00d4ff);padding:36px 40px;text-align:center">
      <div style="width:56px;height:56px;background:rgba(255,255,255,0.2);border-radius:50%;margin:0 auto 16px;display:flex;align-items:center;justify-content:center;font-size:1.6rem">✓</div>
      <h1 style="margin:0;color:#ffffff;font-size:1.5rem;font-weight:800;letter-spacing:-0.02em">Pedido confirmado</h1>
      <p style="margin:8px 0 0;color:rgba(255,255,255,0.85);font-size:0.95rem">Hemos recibido tu pedido correctamente</p>
    </div>

    <!-- Cuerpo -->
    <div style="padding:36px 40px">

      <p style="margin:0 0 8px;color:#2d3748;font-size:1rem">Estimado/a${order.customer_name ? ' <strong>' + order.customer_name + '</strong>' : ''},</p>
      <p style="margin:0 0 24px;color:#4a5568;line-height:1.7">Nos complace confirmarle que hemos recibido su pedido y que nuestro equipo ya está trabajando en su preparación. En breve recibirá una nueva notificación cuando su pedido sea enviado junto con los datos de seguimiento.</p>

      <!-- Referencia -->
      <div style="background:#f0f7ff;border:1px solid #bfdbfe;border-radius:8px;padding:16px 20px;margin-bottom:28px;display:flex;justify-content:space-between;align-items:center">
        <div>
          <div style="font-size:0.72rem;color:#3b82f6;text-transform:uppercase;letter-spacing:0.06em;font-weight:700;margin-bottom:3px">Número de pedido</div>
          <div style="font-size:1.15rem;font-weight:800;color:#1e40af">${order.order_reference}</div>
        </div>
        <div style="text-align:right">
          <div style="font-size:0.72rem;color:#3b82f6;text-transform:uppercase;letter-spacing:0.06em;font-weight:700;margin-bottom:3px">Total</div>
          <div style="font-size:1.15rem;font-weight:800;color:#1e40af">${Number(order.total).toFixed(2)} €</div>
        </div>
      </div>

      <!-- Resumen de productos -->
      <div style="margin-bottom:28px">
        <div style="font-size:0.72rem;color:#718096;text-transform:uppercase;letter-spacing:0.06em;font-weight:700;margin-bottom:10px">Resumen del pedido</div>
        <table style="width:100%;border-collapse:collapse;font-size:0.88rem">
          <thead>
            <tr style="background:#f7fafc">
              <th style="padding:8px 14px;text-align:left;color:#718096;font-weight:600;font-size:0.78rem;border-bottom:2px solid #e2e8f0">Producto</th>
              <th style="padding:8px 14px;text-align:center;color:#718096;font-weight:600;font-size:0.78rem;border-bottom:2px solid #e2e8f0">Cant.</th>
              <th style="padding:8px 14px;text-align:right;color:#718096;font-weight:600;font-size:0.78rem;border-bottom:2px solid #e2e8f0">Total</th>
            </tr>
          </thead>
          <tbody>${itemRows}</tbody>
          <tfoot>
            ${shippingRow}
            <tr style="background:#f7fafc">
              <td colspan="2" style="padding:10px 14px;text-align:right;font-weight:700;color:#2d3748">TOTAL</td>
              <td style="padding:10px 14px;text-align:right;font-weight:800;font-size:1rem;color:#0066ff">${Number(order.total).toFixed(2)} €</td>
            </tr>
          </tfoot>
        </table>
      </div>

      <!-- Mensaje final -->
      <p style="margin:0 0 6px;color:#4a5568;font-size:0.9rem;line-height:1.7">Si tiene alguna pregunta sobre su pedido, no dude en ponerse en contacto con nosotros respondiendo a este correo.</p>
      <p style="margin:24px 0 0;color:#2d3748;font-size:0.95rem">Gracias por su compra.<br><br>Un cordial saludo,<br><strong>Letreros Programables</strong></p>

    </div>

    <!-- Pie -->
    <div style="background:#f7fafc;border-top:1px solid #e2e8f0;padding:16px 40px;text-align:center;font-size:0.77rem;color:#a0aec0">
      Este correo es una confirmación automática de su pedido. Por favor, consérvelo como justificante.
    </div>
  </div>
</body>
</html>`;

  const emailRes = await fetch('https://api.resend.com/emails', {
    method:  'POST',
    headers: { 'Authorization': 'Bearer ' + process.env.RESEND_API_KEY, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      from:    process.env.EMAIL_FROM || 'Letreros Programables <onboarding@resend.dev>',
      to:      [order.customer_email],
      subject: `Confirmación de pedido ${order.order_reference} — Letreros Programables`,
      html:    emailHtml
    })
  });

  if (!emailRes.ok) {
    const err = await emailRes.json().catch(() => ({}));
    throw new Error(err.message || JSON.stringify(err));
  }
  console.log('✅ Confirmación de pedido enviada a ' + order.customer_email);
}

// ── GET /api/order-items/:orderId ────────────────────────────────────

app.get('/api/order-items/:orderId', async (req, res) => {
  const token = (req.headers.authorization || '').replace('Bearer ', '').trim();
  if (!token) return res.status(401).json({ error: 'No autorizado' });

  // Verificar que el usuario es admin usando su JWT
  if (SUPABASE_SERVICE_KEY) {
    try {
      const profileRes = await fetch(`${SUPABASE_URL}/rest/v1/profiles?select=role&limit=1`, {
        headers: { 'apikey': SUPABASE_SERVICE_KEY, 'Authorization': 'Bearer ' + token }
      });
      const profiles = profileRes.ok ? await profileRes.json() : [];
      if (!profiles.length || profiles[0].role !== 'admin') {
        return res.status(403).json({ error: 'Solo admins pueden ver los productos del pedido' });
      }
    } catch (e) {
      return res.status(500).json({ error: 'Error al verificar permisos: ' + e.message });
    }
  }

  // Obtener los items con la clave de servicio (bypassa RLS)
  try {
    const itemsRes = await fetch(
      `${SUPABASE_URL}/rest/v1/order_items?order_id=eq.${req.params.orderId}&select=*&order=id.asc`,
      {
        headers: {
          'apikey':        SUPABASE_SERVICE_KEY,
          'Authorization': 'Bearer ' + SUPABASE_SERVICE_KEY,
          'Content-Type':  'application/json'
        }
      }
    );
    const items = itemsRes.ok ? await itemsRes.json() : [];
    res.json(items);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── POST /admin/send-tracking-email ─────────────────────────────────

app.post('/admin/send-tracking-email', async (req, res) => {
  // Verificar que el usuario es admin
  const authHeader = req.headers.authorization || '';
  const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : null;
  if (!token) return res.status(401).json({ error: 'No autorizado' });

  if (SUPABASE_SERVICE_KEY) {
    try {
      const profileRes = await fetch(`${SUPABASE_URL}/rest/v1/profiles?select=role&limit=1`, {
        headers: {
          'apikey':        SUPABASE_SERVICE_KEY,
          'Authorization': 'Bearer ' + token
        }
      });
      const profiles = profileRes.ok ? await profileRes.json() : [];
      if (!profiles.length || profiles[0].role !== 'admin') {
        return res.status(403).json({ error: 'Solo los administradores pueden enviar correos de seguimiento' });
      }
    } catch(e) {
      return res.status(500).json({ error: 'Error al verificar permisos: ' + e.message });
    }
  }

  const { to, customerName, orderReference, carrier, trackingNumber, trackingUrl, message, orderId } = req.body;

  if (!to || !orderReference || !carrier || !trackingNumber) {
    return res.status(400).json({ error: 'Faltan campos obligatorios (to, orderReference, carrier, trackingNumber)' });
  }

  if (!process.env.RESEND_API_KEY) {
    return res.status(503).json({
      error: 'Servicio de email no configurado. Añade RESEND_API_KEY=re_xxxx en server/.env (obtén la clave en resend.com)'
    });
  }

  // ── Construir el HTML del email ──────────────────────────────────
  const trackingLink = trackingUrl
    ? `<a href="${trackingUrl}" style="color:#0066ff;font-weight:600">${trackingUrl}</a>`
    : trackingNumber;

  const extraMsg = message
    ? `<p style="margin:16px 0;color:#4a5568">${message}</p>`
    : '';

  const emailHtml = `<!DOCTYPE html>
<html lang="es">
<head><meta charset="UTF-8"/><meta name="viewport" content="width=device-width,initial-scale=1"/></head>
<body style="margin:0;padding:0;background:#f7fafc;font-family:Inter,Arial,sans-serif">
  <div style="max-width:560px;margin:40px auto;background:#ffffff;border-radius:12px;overflow:hidden;box-shadow:0 4px 24px rgba(0,0,0,0.08)">
    <div style="background:linear-gradient(135deg,#0066ff,#00d4ff);padding:32px 40px;text-align:center">
      <h1 style="margin:0;color:#ffffff;font-size:1.4rem;font-weight:800">Tu pedido está en camino</h1>
    </div>
    <div style="padding:36px 40px">
      <p style="margin:0 0 20px;color:#2d3748;font-size:1rem">Hola${customerName ? ' <strong>' + customerName + '</strong>' : ''},</p>
      <p style="margin:0 0 20px;color:#4a5568">Queremos informarte de que tu pedido <strong>${orderReference}</strong> ya ha sido preparado y enviado.</p>
      <div style="background:#f7fafc;border:1px solid #e2e8f0;border-radius:8px;padding:20px 24px;margin:24px 0">
        <p style="margin:0 0 10px;font-size:0.85rem;color:#718096;text-transform:uppercase;letter-spacing:0.06em;font-weight:700">Datos de seguimiento</p>
        <table style="width:100%;border-collapse:collapse;font-size:0.93rem">
          <tr>
            <td style="padding:6px 0;color:#718096;width:160px">Empresa de transporte</td>
            <td style="padding:6px 0;color:#2d3748;font-weight:600">${carrier}</td>
          </tr>
          <tr>
            <td style="padding:6px 0;color:#718096">Número de seguimiento</td>
            <td style="padding:6px 0;color:#2d3748;font-weight:600;font-family:monospace">${trackingNumber}</td>
          </tr>
          ${trackingUrl ? `<tr>
            <td style="padding:6px 0;color:#718096">Enlace de seguimiento</td>
            <td style="padding:6px 0">${trackingLink}</td>
          </tr>` : ''}
        </table>
      </div>
      ${trackingUrl ? `<div style="text-align:center;margin:28px 0">
        <a href="${trackingUrl}" style="display:inline-block;background:linear-gradient(135deg,#0066ff,#00d4ff);color:#ffffff;text-decoration:none;padding:14px 32px;border-radius:8px;font-weight:700;font-size:0.95rem">Rastrear mi pedido</a>
      </div>` : ''}
      ${extraMsg}
      <p style="margin:20px 0;color:#4a5568;font-size:0.9rem">Puedes consultar el estado de tu paquete desde el enlace anterior. Ten en cuenta que, en algunos casos, la información de seguimiento puede tardar unas horas en actualizarse desde que el pedido sale de nuestras instalaciones.</p>
      <p style="margin:28px 0 0;color:#2d3748">Muchas gracias por confiar en nosotros.<br><br>Un saludo,<br><strong>Letreros Programables</strong></p>
    </div>
    <div style="background:#f7fafc;border-top:1px solid #e2e8f0;padding:16px 40px;text-align:center;font-size:0.78rem;color:#a0aec0">
      Este es un email automático. Por favor no respondas a este mensaje.
    </div>
  </div>
</body>
</html>`;

  // ── Enviar con Resend ────────────────────────────────────────────
  try {
    const emailRes = await fetch('https://api.resend.com/emails', {
      method:  'POST',
      headers: {
        'Authorization': 'Bearer ' + process.env.RESEND_API_KEY,
        'Content-Type':  'application/json'
      },
      body: JSON.stringify({
        from:    process.env.EMAIL_FROM || 'Letreros Programables <onboarding@resend.dev>',
        to:      [to],
        subject: `Tu pedido ${orderReference} ya está en camino`,
        html:    emailHtml
      })
    });

    const emailData = await emailRes.json();
    if (!emailRes.ok) throw new Error(emailData.message || JSON.stringify(emailData));

    // Marcar tracking_email_sent en shipments
    if (orderId && SUPABASE_SERVICE_KEY) {
      fetch(`${SUPABASE_URL}/rest/v1/shipments?order_id=eq.${orderId}`, {
        method:  'PATCH',
        headers: {
          'apikey':        SUPABASE_SERVICE_KEY,
          'Authorization': 'Bearer ' + SUPABASE_SERVICE_KEY,
          'Content-Type':  'application/json',
          'Prefer':        'return=minimal'
        },
        body: JSON.stringify({ tracking_email_sent: true, tracking_email_sent_at: new Date().toISOString() })
      }).catch(e => console.error('Error actualizando tracking_email_sent:', e.message));
    }

    console.log(`✅ Email de seguimiento enviado a ${to} para pedido ${orderReference}`);
    res.json({ ok: true, emailId: emailData.id });

  } catch(err) {
    console.error('Error enviando email de seguimiento:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── PATCH /admin/update-product/:id ─────────────────────────────────

app.patch('/admin/update-product/:id', async (req, res) => {
  const authHeader = req.headers.authorization || '';
  const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : null;
  if (!token) return res.status(401).json({ error: 'No autorizado' });

  if (!SUPABASE_SERVICE_KEY) {
    return res.status(503).json({ error: 'SUPABASE_SERVICE_KEY no configurada en el servidor' });
  }

  // Verificar que el usuario es admin
  try {
    const profileRes = await fetch(`${SUPABASE_URL}/rest/v1/profiles?select=role&limit=1`, {
      headers: {
        'apikey':        SUPABASE_SERVICE_KEY,
        'Authorization': 'Bearer ' + token
      }
    });
    const profiles = profileRes.ok ? await profileRes.json() : [];
    if (!profiles.length || profiles[0].role !== 'admin') {
      return res.status(403).json({ error: 'Solo los administradores pueden editar productos' });
    }
  } catch(e) {
    return res.status(500).json({ error: 'Error verificando permisos: ' + e.message });
  }

  const id = parseInt(req.params.id);
  const fields = req.body;

  try {
    const upRes = await fetch(`${SUPABASE_URL}/rest/v1/products?id=eq.${id}`, {
      method: 'PATCH',
      headers: {
        'apikey':        SUPABASE_SERVICE_KEY,
        'Authorization': 'Bearer ' + SUPABASE_SERVICE_KEY,
        'Content-Type':  'application/json',
        'Prefer':        'return=representation'
      },
      body: JSON.stringify(fields)
    });
    if (!upRes.ok) throw new Error('Supabase: ' + await upRes.text());
    const updated = await upRes.json();
    res.json({ ok: true, product: updated[0] || null });
  } catch(e) {
    console.error('Error actualizando producto:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ── GET /test-email (diagnóstico) ────────────────────────────────────

app.get('/test-email', async (req, res) => {
  const to = req.query.to || process.env.ADMIN_ORDERS_EMAIL;
  if (!to) return res.status(400).json({ error: 'Indica ?to=email@ejemplo.com' });

  if (!process.env.RESEND_API_KEY) {
    return res.status(503).json({ error: 'RESEND_API_KEY no está en .env' });
  }

  try {
    const r = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { 'Authorization': 'Bearer ' + process.env.RESEND_API_KEY, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        from:    process.env.EMAIL_FROM || 'onboarding@resend.dev',
        to:      [to],
        subject: 'Test de email — Letreros Programables',
        html:    '<p>Este es un email de prueba. Si lo recibes, el sistema de correo funciona correctamente.</p>'
      })
    });
    const data = await r.json();
    if (!r.ok) {
      console.error('❌ Test email fallido:', JSON.stringify(data));
      return res.status(r.status).json({ error: data.message || data.name || JSON.stringify(data), resend: data });
    }
    console.log('✅ Test email enviado a', to, '| ID:', data.id);
    res.json({ ok: true, emailId: data.id, to, from: process.env.EMAIL_FROM || 'onboarding@resend.dev' });
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

// ── Arrancar servidor ────────────────────────────────────────────────

const PORT = process.env.PORT || 3000;
if (process.env.NODE_ENV !== 'production') {
  app.listen(PORT, () => {
    console.log(`✅ Servidor corriendo en http://localhost:${PORT}`);
    if (!process.env.STRIPE_SECRET_KEY)   console.warn('⚠️  STRIPE_SECRET_KEY no configurada');
    if (!process.env.STRIPE_WEBHOOK_SECRET) console.warn('⚠️  STRIPE_WEBHOOK_SECRET no configurada');
    if (!SUPABASE_SERVICE_KEY)            console.warn('⚠️  SUPABASE_SERVICE_KEY no configurada');
  });
}

module.exports = app;
