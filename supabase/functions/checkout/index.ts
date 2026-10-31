import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type", "Access-Control-Allow-Methods": "POST, OPTIONS" };
const SUPABASE_URL = Deno.env.get("SUPABASE_URL") ?? "";
const APP_URL = SUPABASE_URL + "/functions/v1";

class InputError extends Error {}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });
  if (req.method !== "POST") return new Response(JSON.stringify({ error: "POST only" }), { status: 405, headers: { ...corsHeaders, "Content-Type": "application/json" } });

  try {
    let body;
    try { body = await req.json(); } catch { return new Response(JSON.stringify({error:"Invalid JSON"}), {status:400,headers:{...corsHeaders,"Content-Type":"application/json"}}); }
    if (!body || typeof body !== 'object' || Array.isArray(body)) throw new InputError("Invalid request");
    const { items, customer, payment_method, discount_code, return_url } = body;
    if (!Array.isArray(items) || !items.length || items.length > 50) throw new InputError("Cart must contain 1 to 50 selections");
    if (payment_method !== 'stripe') throw new InputError("Only card checkout is available");
    if (!customer || typeof customer.name !== 'string' || !customer.name.trim() || customer.name.length > 200 || typeof customer.email !== 'string' || customer.email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(customer.email)) throw new InputError("Valid customer name and email required");
    if (discount_code != null && (typeof discount_code !== 'string' || discount_code.length > 100)) throw new InputError("Invalid discount code");
    // The legacy hosted confirmation page remains canonical. Never redirect buyers to arbitrary request URLs.
    if (return_url != null && return_url !== APP_URL + '/order-confirmation') throw new InputError("Invalid return URL");
    for (const item of items) {
      if (!item || typeof item.slug !== 'string' || !item.slug || !Number.isInteger(item.quantity) || item.quantity < 1 || item.quantity > 10) throw new InputError("Invalid item or quantity");
    }
    // Do not accept a new payment while verified order updates are unconfigured.
    if (!Deno.env.get('STRIPE_SECRET_KEY') || !Deno.env.get('STRIPE_WEBHOOK_SECRET')) {
      return new Response(JSON.stringify({error:'Card checkout is being connected. Contact truskoolcorp@truskool.net for current availability and dispatch details.'}), {status:503,headers:{...corsHeaders,'Content-Type':'application/json'}});
    }
    const supabase = createClient(SUPABASE_URL, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "");
    const slugs = [...new Set(items.map((i: any) => i.slug))];
    const { data: products, error: productError } = await supabase.from("products").select("*").in("slug", slugs).neq("status", "draft");
    if (productError) throw new Error("Catalog lookup failed");
    const productMap = new Map((products || []).map((p: any) => [p.slug, p]));
    const cartItems: any[] = []; let subtotal = 0;
    const quantities = new Map<string,number>();
    for (const item of items) {
      const product: any = productMap.get(item.slug);
      if (!product || !['preorder','active','published'].includes(product.status)) throw new InputError("A selected product is unavailable");
      if (!Number.isSafeInteger(product.price_cents) || product.price_cents < 0 || product.currency?.toLowerCase() !== 'usd') throw new Error("Invalid catalog price");
      for (const [field, options] of [['size',product.sizes],['color',product.colors]] as const) {
        if (!Array.isArray(options)) throw new Error("Invalid catalog options");
        if (options.length ? !options.includes(item[field]) : item[field] != null && item[field] !== '') throw new InputError("Choose a current product size and color");
      }
      const qty = item.quantity;
      const totalQty = (quantities.get(item.slug) || 0) + qty;
      const limit = product.max_quantity == null ? 10 : Math.min(10,product.max_quantity);
      if (totalQty > limit) throw new InputError("Product quantity limit exceeded");
      quantities.set(item.slug,totalQty);
      subtotal += product.price_cents * qty;
      if (!Number.isSafeInteger(subtotal)) throw new Error("Invalid catalog total");
      cartItems.push({ product_id: product.id, slug: product.slug, name: product.name, size: item.size || null, color: item.color || null, quantity: qty, price_cents: product.price_cents, line_total_cents: product.price_cents * qty });
    }

    let discountCents = 0, appliedCode = null;
    if (discount_code) {
      const { data: dc } = await supabase.from("discount_codes").select("*").eq("code", discount_code.toUpperCase()).eq("active", true).single();
      if (dc && (!dc.expires_at || new Date(dc.expires_at) > new Date()) && (!dc.max_uses || dc.used_count < dc.max_uses) && subtotal >= dc.min_order_cents) {
        discountCents = dc.type === 'percent' ? Math.round(subtotal * dc.value / 100) : Math.min(dc.value, subtotal);
        appliedCode = dc.code;
        await supabase.from("discount_codes").update({ used_count: dc.used_count + 1 }).eq("id", dc.id);
      }
    }

    const totalCents = Math.max(subtotal - discountCents, 0);
    const totalDollars = (totalCents / 100).toFixed(2);

    const { data: order, error: oErr } = await supabase.from("orders").insert({ order_number: '', email: customer.email, name: customer.name, phone: customer.phone || null, shipping_address: customer.address || null, items: cartItems, subtotal_cents: subtotal, shipping_cents: 0, discount_cents: discountCents, discount_code: appliedCode, total_cents: totalCents, payment_method, payment_status: 'pending', order_status: 'preorder' }).select().single();
    if (oErr || !order) return new Response(JSON.stringify({ error: "Order failed",  }), { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } });

    const successUrl = (APP_URL + '/order-confirmation') + '?order=' + order.id;
    const cancelUrl = 'https://www.bijadi.net/shop.html?cancelled=true';

    // STRIPE
    if (payment_method === 'stripe') {
      const sk = Deno.env.get("STRIPE_SECRET_KEY"); if (!sk) return new Response(JSON.stringify({ error: "Stripe not configured" }), { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } });
      const expireUnsharedSession = async (id: string) => {
        try {
          const expired = await fetch('https://api.stripe.com/v1/checkout/sessions/'+encodeURIComponent(id)+'/expire', {
            method:'POST',headers:{'Authorization':`Bearer ${sk}`,'Content-Type':'application/x-www-form-urlencoded'},
          });
          if (!expired.ok) console.error('Unshared checkout session needs reconciliation');
        } catch { console.error('Unshared checkout session needs reconciliation'); }
      };
      const p = new URLSearchParams(); p.append('mode','payment'); p.append('success_url',successUrl); p.append('cancel_url',cancelUrl); p.append('customer_email',customer.email); p.append('metadata[order_id]',order.id); p.append('metadata[order_number]',order.order_number); p.append('payment_method_types[0]','card');
      cartItems.forEach((it: any, i: number) => { const l = it.name + (it.size ? ` (${it.size})` : '') + (it.color ? ` / ${it.color}` : ''); p.append(`line_items[${i}][price_data][currency]`,'usd'); p.append(`line_items[${i}][price_data][product_data][name]`,l); p.append(`line_items[${i}][price_data][unit_amount]`,String(it.price_cents)); p.append(`line_items[${i}][quantity]`,String(it.quantity)); });
      if (discountCents > 0) {
        const cp = new URLSearchParams();
        cp.append('amount_off',String(discountCents)); cp.append('currency','usd'); cp.append('duration','once');
        cp.append('max_redemptions','1'); cp.append('name',`BiJaDi ${appliedCode}`.slice(0,40));
        const cr = await fetch('https://api.stripe.com/v1/coupons',{
          method:'POST',headers:{'Authorization':`Bearer ${sk}`,'Content-Type':'application/x-www-form-urlencoded','Idempotency-Key':`bijadi-coupon/${order.id}`},body:cp.toString()
        });
        const coupon = await cr.json();
        if (!cr.ok || typeof coupon.id !== 'string' || !coupon.id || coupon.valid !== true ||
            coupon.amount_off !== discountCents || coupon.currency !== 'usd') throw new Error('Discount provider unavailable');
        p.append('discounts[0][coupon]',coupon.id);
      }
      const sr = await fetch('https://api.stripe.com/v1/checkout/sessions',{
        method:'POST',headers:{'Authorization':`Bearer ${sk}`,'Content-Type':'application/x-www-form-urlencoded','Idempotency-Key':`bijadi-checkout/${order.id}`},body:p.toString()
      });
      const session = await sr.json();
      if (!sr.ok || typeof session.id !== 'string' || !session.id.startsWith('cs_')) throw new Error('Checkout provider unavailable');
      let trustedUrl = false;
      try { const checkoutUrl = new URL(session.url); trustedUrl = checkoutUrl.protocol === 'https:' && checkoutUrl.hostname === 'checkout.stripe.com' && !checkoutUrl.username && !checkoutUrl.password; } catch {}
      if (!trustedUrl || session.amount_total !== totalCents || session.currency !== 'usd' || session.status !== 'open') {
        await expireUnsharedSession(session.id);
        throw new Error('Checkout response mismatch');
      }
      const { data: savedOrder, error: saveError } = await supabase.from("orders")
        .update({stripe_session_id:session.id}).eq("id",order.id).select("id").single();
      if (saveError || !savedOrder) {
        await expireUnsharedSession(session.id);
        throw new Error('Checkout order tracking unavailable');
      }
      return new Response(JSON.stringify({success:true,payment_method:'stripe',checkout_url:session.url,order_id:order.id,order_number:order.order_number,total:totalDollars}),{status:200,headers:{...corsHeaders,"Content-Type":"application/json"}});
    }

  } catch (err: any) {
    return new Response(JSON.stringify({ error: err instanceof InputError ? err.message : "Checkout unavailable. Please try again." }), { status: err instanceof InputError ? 400 : 500, headers: { ...corsHeaders, "Content-Type": "application/json" } });
  }
});
