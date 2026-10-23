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
      const event = JSON.parse(body);
      if (!event || typeof event.id !== "string" || !event.id.startsWith("evt_")) {
        return new Response("Malformed Stripe event", { status: 400 });
      }
      if (event.type === "checkout.session.completed" || event.type === "checkout.session.expired") {
        const session = event.data?.object;
        if (typeof session?.id !== "string" || !session.id.startsWith("cs_") || typeof session.metadata?.order_id !== "string" || !session.metadata.order_id) {
          // Authenticated event but no safely identifiable order: retry for investigation.
          return new Response("Checkout event missing required identifiers", { status: 500 });
        }
      }

      if (event.type === 'checkout.session.completed') {
        const session = event.data.object;
        const orderId = session.metadata?.order_id;
        if (orderId) {
          const { data: updated, error } = await supabase.from("orders").update({
            payment_status: 'paid',
            stripe_payment_intent: session.payment_intent,
            order_status: 'confirmed',
            updated_at: new Date().toISOString(),
          }).eq("id", orderId).eq("stripe_session_id", session.id).eq("payment_status", "pending").select("id");
          if (error) throw error;
          if (!updated?.length) {
            // Do not acknowledge an unknown/mismatched order until reconciliation.
            const { data: existing, error: lookupError } = await supabase.from("orders").select("id,payment_status,stripe_session_id").eq("id", orderId).maybeSingle();
            if (lookupError) throw lookupError;
            if (!existing || existing.stripe_session_id !== session.id || existing.payment_status !== "paid") {
              return new Response("Checkout order not reconciled", { status: 500 });
            }
          }
        }
      } else if (event.type === 'checkout.session.expired') {
        const session = event.data.object;
        const orderId = session.metadata?.order_id;
        if (orderId) {
          const { error } = await supabase.from("orders").update({
            payment_status: 'failed',
            updated_at: new Date().toISOString(),
          }).eq("id", orderId).eq("stripe_session_id", session.id).eq("payment_status", "pending");
          if (error) throw error;
        }
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
    console.error('Webhook error:', err);
    // Let providers retry transient processing errors; do not acknowledge unprocessed events.
    return new Response(JSON.stringify({ received: false }), {
      status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});