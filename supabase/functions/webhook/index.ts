import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, stripe-signature, x-cc-webhook-signature",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};


// Validate Stripe's signed raw payload before any payment-state mutation.
async function verifyStripeSignature(raw: string, header: string | null, secret: string): Promise<boolean> {
  if (!secret || !header) return false;
  const elements = header.split(",").map(part => part.trim().split("="));
  const timestamp = elements.find(pair => pair[0] === "t")?.[1];
  const signatures = elements.filter(pair => pair[0] === "v1").map(pair => pair[1]);
  if (!timestamp || !/^\d+$/.test(timestamp) || !signatures.length) return false;
  if (Math.abs(Date.now() / 1000 - Number(timestamp)) > 300) return false;
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const digest = new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(timestamp + "." + raw)));
  const expected = Array.from(digest, b => b.toString(16).padStart(2, "0")).join("");
  return signatures.some(sig => {
    if (!/^[a-f0-9]{64}$/i.test(sig)) return false;
    let diff = 0;
    for (let i = 0; i < expected.length; i++) diff |= expected.charCodeAt(i) ^ sig.toLowerCase().charCodeAt(i);
    return diff === 0;
  });
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  if (req.method !== "POST") return new Response("POST only", {status:405,headers:{Allow:"POST, OPTIONS"}});

  const supabase = createClient(
    Deno.env.get("SUPABASE_URL") ?? "",
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? ""
  );

  const url = new URL(req.url);
  const provider = url.searchParams.get("provider");

  try {
    // ============================================================
    // STRIPE WEBHOOK
    // ============================================================
    if (provider === 'stripe') {
      const body = await req.text();
      const secret = Deno.env.get('STRIPE_WEBHOOK_SECRET') ?? '';
      if (!secret) return new Response('Webhook unavailable', { status: 503 });
      if (!await verifyStripeSignature(body, req.headers.get('stripe-signature'), secret)) return new Response('Invalid webhook signature', { status: 400 });
      let event;
      try { event = JSON.parse(body); } catch { return new Response("Malformed Stripe event", {status:400}); }
      if (!event || typeof event.id !== "string" || !/^evt_[A-Za-z0-9_]+$/.test(event.id) || event.id.length > 255) {
        return new Response("Malformed Stripe event", { status: 400 });
      }
      const paidEvents = ['checkout.session.completed', 'checkout.session.async_payment_succeeded'];
      if (paidEvents.includes(event.type) || event.type === 'checkout.session.expired') {
        const reported = event.data?.object;
        // This Stripe account also serves other brands. A dedicated endpoint receives their events too.
        const isBiJaDi = reported?.metadata?.brand === 'bijadi' ||
          typeof reported?.metadata?.order_number === 'string' && /^BIJADI-\d+$/.test(reported.metadata.order_number);
        if (!isBiJaDi) return new Response(JSON.stringify({received:true,ignored:true}), {status:200,headers:{...corsHeaders,'Content-Type':'application/json'}});
        if (typeof reported?.id !== "string" || !/^cs_[A-Za-z0-9_]+$/.test(reported.id) || reported.id.length > 255 ||
            typeof reported.metadata?.order_id !== "string" || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(reported.metadata.order_id)) {
          return new Response("Checkout event missing required identifiers", { status: 500 });
        }
        const stripeKey = Deno.env.get('STRIPE_SECRET_KEY');
        if (!stripeKey) return new Response('Payment verification unavailable', {status:503});
        // A signed event authenticates the sender, but an old event is not current payment state.
        const response = await fetch('https://api.stripe.com/v1/checkout/sessions/' + encodeURIComponent(reported.id), {
          headers: {Authorization: 'Bearer ' + stripeKey}, signal: AbortSignal.timeout(10000),
        });
        if (!response.ok) throw new Error('Stripe session lookup failed');
        const session = await response.json();
        if (session.id !== reported.id || session.mode !== 'payment' ||
            typeof session.livemode !== 'boolean' || session.livemode !== event.livemode ||
            session.metadata?.order_id !== reported.metadata.order_id) throw new Error('Stripe session identity mismatch');
        const {data: order, error: lookupError} = await supabase.from('orders')
          .select('id,stripe_session_id,payment_method,total_cents,payment_status')
          .eq('id', session.metadata.order_id).maybeSingle();
        if (lookupError || !order || order.stripe_session_id !== session.id || order.payment_method !== 'stripe') throw new Error('Order lookup or identity mismatch');
        if (!Number.isSafeInteger(order.total_cents) || order.total_cents < 0 ||
            !Number.isSafeInteger(session.amount_total) || session.amount_total !== order.total_cents || session.currency !== 'usd') throw new Error('Payment total or currency mismatch');
        const paid = session.status === 'complete' && (session.payment_status === 'paid' ||
          session.payment_status === 'no_payment_required' && session.amount_total === 0);
        if (paidEvents.includes(event.type) && !paid) {
          // Do not consume the event receipt or mutate the order; a later paid event can apply.
          return new Response(JSON.stringify({received:true,payment_pending:true}), {status:200,headers:{...corsHeaders,'Content-Type':'application/json'}});
        }
        if (event.type === 'checkout.session.expired' && (session.status !== 'expired' || session.payment_status !== 'unpaid')) {
          return new Response(JSON.stringify({received:true,ignored:true}), {status:200,headers:{...corsHeaders,'Content-Type':'application/json'}});
        }
        const intent = typeof session.payment_intent === 'string' && /^pi_[A-Za-z0-9_]+$/.test(session.payment_intent) ? session.payment_intent : null;
        if (paid && session.amount_total > 0 && !intent) throw new Error('Paid session missing payment intent');
        const { error } = await supabase.rpc('process_verified_stripe_checkout_event', {
          p_event_id: event.id,
          p_event_type: event.type,
          p_order_id: session.metadata.order_id,
          p_session_id: session.id,
          p_payment_intent: intent,
        });
        if (error) throw new Error('Payment state transaction failed');
      }

      return new Response(JSON.stringify({ received: true }), {
        status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // ============================================================
    // COINBASE BUSINESS WEBHOOK (new Payment Link API)
    // Handles both legacy Commerce and new Business event formats
    // ============================================================
    if (provider === 'coinbase') {
      // No provider-specific signature verification has yet been validated.
      // Keep order updates disabled; 503 allows a configured provider to retry.
      return new Response('Coinbase webhook verification not configured', { status: 503 });
    }

    return new Response(JSON.stringify({ error: "Specify ?provider=stripe or ?provider=coinbase" }), {
      status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" },
    });

  } catch (err) {
    console.error('Webhook verification or processing failed');
    // Let providers retry transient processing errors; do not acknowledge unprocessed events.
    return new Response(JSON.stringify({ received: false }), {
      status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
