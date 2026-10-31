import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type", "Access-Control-Allow-Methods": "POST, OPTIONS" };
const SUPABASE_URL = Deno.env.get("SUPABASE_URL") ?? "";
const APP_URL = SUPABASE_URL + "/functions/v1";

class InputError extends Error {}

type ShippingPolicy = {version:1; countries:string[]; amount_cents:number; dispatch_estimate:string};
function configuredShipping(): ShippingPolicy | null {
  try {
    const value = JSON.parse(Deno.env.get('BIJADI_SHIPPING_CONFIG') || 'null');
    const unsupported = new Set('AS CX CC CU HM IR KP MH FM NF MP PW SD SY UM VI'.split(' '));
    const regions = new Intl.DisplayNames(['en'], {type:'region'});
    if (!value || value.version !== 1 || !Array.isArray(value.countries) || !value.countries.length || value.countries.length > 50 ||
        new Set(value.countries).size !== value.countries.length || value.countries.some((c: unknown) => typeof c !== 'string' || !/^[A-Z]{2}$/.test(c) || unsupported.has(c) || regions.of(c) === c || regions.of(c) === 'Unknown Region') ||
        !Number.isSafeInteger(value.amount_cents) || value.amount_cents < 0 || value.amount_cents > 100000 ||
        typeof value.dispatch_estimate !== 'string' || !value.dispatch_estimate.trim() || value.dispatch_estimate.length > 200) return null;
    return {version:1,countries:value.countries,amount_cents:value.amount_cents,dispatch_estimate:value.dispatch_estimate.trim()};
  } catch { return null; }
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });
  if (req.method !== "POST") return new Response(JSON.stringify({ error: "POST only" }), { status: 405, headers: { ...corsHeaders, "Content-Type": "application/json" } });

  let cleanupClient: ReturnType<typeof createClient> | null = null;
  let reservedOrderId: string | null = null;
  let safeToRelease = false;
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
    const shipping = configuredShipping();
    if (!shipping) return new Response(JSON.stringify({error:'Shipping and dispatch details are being confirmed. Contact truskoolcorp@truskool.net for current availability.'}), {status:503,headers:{...corsHeaders,'Content-Type':'application/json'}});
    const supabase = createClient(SUPABASE_URL, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "");
    cleanupClient = supabase;
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
      const code = discount_code.trim().toUpperCase();
      if (!code) throw new InputError("Discount code is unavailable.");
      const { data: dc, error: discountError } = await supabase.from("discount_codes")
        .select("*").eq("code",code).eq("active",true).maybeSingle();
      if (discountError) throw new Error("Discount verification unavailable");
      if (!dc || dc.type === 'shipping') throw new InputError("Discount code is unavailable.");
      const minimum = dc.min_order_cents ?? 0;
      if (!['percent','fixed'].includes(dc.type) || !Number.isFinite(dc.value) || dc.value <= 0 ||
          (dc.type === 'percent' ? dc.value > 100 : !Number.isSafeInteger(dc.value)) ||
          !Number.isSafeInteger(minimum) || minimum < 0 ||
          !Number.isSafeInteger(dc.used_count) || dc.used_count < 0 ||
          (dc.max_uses != null && (!Number.isSafeInteger(dc.max_uses) || dc.max_uses < 0))) throw new Error("Discount configuration unavailable");
      const expiry = dc.expires_at ? Date.parse(dc.expires_at) : null;
      if ((expiry !== null && (!Number.isFinite(expiry) || expiry <= Date.now())) ||
          (dc.max_uses != null && dc.used_count >= dc.max_uses) || subtotal < minimum) throw new InputError("Discount code is unavailable.");
      discountCents = dc.type === 'percent' ? Math.round(subtotal * dc.value / 100) : Math.min(dc.value,subtotal);
      appliedCode = dc.code;
      // The order insert atomically reserves capacity; verified payment redeems it.
    }

    const totalCents = Math.max(subtotal - discountCents, 0) + shipping.amount_cents;
    const totalDollars = (totalCents / 100).toFixed(2);

    const { data: order, error: oErr } = await supabase.from("orders").insert({ order_number: '', email: customer.email, name: customer.name, phone: customer.phone || null, shipping_address: null, shipping_policy: shipping, items: cartItems, subtotal_cents: subtotal, shipping_cents: shipping.amount_cents, discount_cents: discountCents, discount_code: appliedCode, total_cents: totalCents, payment_method, payment_status: 'pending', order_status: 'preorder' }).select().single();
    if (oErr?.code === "22023") throw new InputError("Discount code is unavailable.");
    if (oErr || !order) throw new Error("Order failed");
    reservedOrderId = order.id;
    safeToRelease = true;

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
          const result = await expired.json();
          if (expired.ok && result.id === id && result.status === "expired") return true;
          console.error("Unshared checkout session needs reconciliation");
        } catch { console.error('Unshared checkout session needs reconciliation'); }
        return false;
      };
      const p = new URLSearchParams(); p.append('mode','payment'); p.append('success_url',successUrl); p.append('cancel_url',cancelUrl); p.append('customer_email',customer.email); p.append('metadata[order_id]',order.id); p.append('metadata[order_number]',order.order_number); p.append('payment_method_types[0]','card');
      p.append('metadata[brand]','bijadi');
      p.append('metadata[shipping_policy_version]','1');
      shipping.countries.forEach((country,i)=>p.append(`shipping_address_collection[allowed_countries][${i}]`,country));
      p.append('shipping_options[0][shipping_rate_data][type]','fixed_amount');
      p.append('shipping_options[0][shipping_rate_data][fixed_amount][amount]',String(shipping.amount_cents));
      p.append('shipping_options[0][shipping_rate_data][fixed_amount][currency]','usd');
      p.append('shipping_options[0][shipping_rate_data][display_name]','Delivery');
      p.append('custom_text[shipping_address][message]',shipping.dispatch_estimate);
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
      // A timeout or server error may still have created a payable session. Retain its hold.
      safeToRelease = false;
      const sr = await fetch('https://api.stripe.com/v1/checkout/sessions',{
        method:'POST',headers:{'Authorization':`Bearer ${sk}`,'Content-Type':'application/x-www-form-urlencoded','Idempotency-Key':`bijadi-checkout/${order.id}`},body:p.toString()
      });
      // Stripe 4xx rejects this request; ambiguous 5xx/network outcomes require reconciliation.
      if (sr.status >= 400 && sr.status < 500 && sr.status !== 409) safeToRelease = true;
      const session = await sr.json();
      if (!sr.ok || typeof session.id !== 'string' || !session.id.startsWith('cs_')) throw new Error('Checkout provider unavailable');
      let trustedUrl = false;
      try { const checkoutUrl = new URL(session.url); trustedUrl = checkoutUrl.protocol === 'https:' && checkoutUrl.hostname === 'checkout.stripe.com' && !checkoutUrl.username && !checkoutUrl.password; } catch {}
      // Hosted Checkout may not add shipping until the buyer supplies an address.
      // Only the configured fixed-rate option is offered; payment verifies final totals again.
      const pendingShipping = session.shipping_cost == null && session.amount_total === totalCents - shipping.amount_cents;
      const completeShipping = session.amount_total === totalCents && session.shipping_cost?.amount_total === shipping.amount_cents;
      if (!trustedUrl || (!pendingShipping && !completeShipping) || session.currency !== 'usd' || session.status !== 'open') {
        safeToRelease = await expireUnsharedSession(session.id);
        throw new Error('Checkout response mismatch');
      }
      const { data: savedOrder, error: saveError } = await supabase.from("orders")
        .update({stripe_session_id:session.id}).eq("id",order.id).select("id").single();
      if (saveError || !savedOrder) {
        safeToRelease = await expireUnsharedSession(session.id);
        throw new Error('Checkout order tracking unavailable');
      }
      return new Response(JSON.stringify({success:true,payment_method:'stripe',checkout_url:session.url,order_id:order.id,order_number:order.order_number,total:totalDollars}),{status:200,headers:{...corsHeaders,"Content-Type":"application/json"}});
    }

  } catch (err: any) {
    if (safeToRelease && reservedOrderId && cleanupClient) {
      try {
        const { error } = await cleanupClient.from("orders")
          .update({payment_status:"failed",order_status:"cancelled"})
          .eq("id",reservedOrderId).eq("payment_status","pending");
        if (error) console.error("Unpaid checkout reservation needs reconciliation");
      } catch { console.error("Unpaid checkout reservation needs reconciliation"); }
    }
    return new Response(JSON.stringify({ error: err instanceof InputError ? err.message : "Checkout unavailable. Please try again." }), { status: err instanceof InputError ? 400 : 500, headers: { ...corsHeaders, "Content-Type": "application/json" } });
  }
});
