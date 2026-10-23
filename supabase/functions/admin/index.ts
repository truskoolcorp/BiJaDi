import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-admin-key",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
};

// Simple admin key check — set this in Supabase project secrets
function isAuthorized(req: Request): boolean {
  const key = req.headers.get("x-admin-key");
  const expected = Deno.env.get("ADMIN_KEY");
  return typeof expected === "string" && expected.length >= 32 && typeof key === "string" && key.length > 0 && key === expected;
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  if (!isAuthorized(req)) {
    return new Response(
      JSON.stringify({ error: "Unauthorized" }),
      { status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }

  const supabase = createClient(
    Deno.env.get("SUPABASE_URL") ?? "",
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? ""
  );

  const url = new URL(req.url);
  const action = url.searchParams.get("action");

  try {
    // ===== LIST GARMENTS =====
    if (req.method === "GET" && action === "list") {
      const { data, error } = await supabase
        .from("garments")
        .select("qr_code, product_name, size, color, edition_number, edition_total, referral_code, created_at")
        .order("created_at", { ascending: false });
      if (error) throw error;
      return new Response(
        JSON.stringify({ garments: data, count: data.length }),
        { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // ===== DASHBOARD STATS =====
    if (req.method === "GET" && action === "stats") {
      const [g, sc, sp, m, r] = await Promise.all([
        supabase.from("garments").select("id", { count: "exact", head: true }),
        supabase.from("scans").select("id", { count: "exact", head: true }),
        supabase.from("spins").select("id", { count: "exact", head: true }),
        supabase.from("memories").select("id", { count: "exact", head: true }),
        supabase.from("referrals").select("id", { count: "exact", head: true }),
      ]);
      return new Response(
        JSON.stringify({
          garments: g.count || 0,
          scans: sc.count || 0,
          spins: sp.count || 0,
          memories: m.count || 0,
          referrals: r.count || 0,
        }),
        { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // ===== REGISTER SINGLE GARMENT =====
    if (req.method === "POST" && action === "register") {
      const body = await req.json();
      const { sku, product_name, size, color, edition_number, edition_total } = body;

      if (!sku || !product_name || !size) {
        return new Response(
          JSON.stringify({ error: "Missing required fields: sku, product_name, size" }),
          { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
        );
      }

      // Auto-generate QR code and referral code
      const edNum = edition_number || Math.floor(Math.random() * 9000) + 1000;
      const qrCode = `LBE-${String(edNum).padStart(3, '0')}`;
      const suffix = Math.random().toString(36).substring(2, 6).toUpperCase();
      const referralCode = `LITTLEBE-FAM-${suffix}`;

      const { data, error } = await supabase.from("garments").insert({
        qr_code: qrCode,
        sku,
        product_name,
        size,
        color: color || "Cream",
        edition_number: edNum,
        edition_total: edition_total || 200,
        referral_code: referralCode,
      }).select().single();

      if (error) {
        return new Response(
          JSON.stringify({ error: error.message }),
          { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
        );
      }

      const appUrl = `${Deno.env.get("SUPABASE_URL")}/functions/v1/app?code=${qrCode}`;

      return new Response(
        JSON.stringify({
          success: true,
          garment: data,
          qr_url: appUrl,
        }),
        { status: 201, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // ===== REGISTER BATCH =====
    if (req.method === "POST" && action === "batch") {
      const body = await req.json();
      const { garments } = body;

      if (!garments || !Array.isArray(garments) || garments.length === 0) {
        return new Response(
          JSON.stringify({ error: "Provide an array of garments" }),
          { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
        );
      }

      const records = garments.map((g: any, idx: number) => {
        const edNum = g.edition_number || (1000 + idx);
        const qrCode = g.qr_code || `LBE-${String(edNum).padStart(3, '0')}`;
        const suffix = Math.random().toString(36).substring(2, 6).toUpperCase();
        return {
          qr_code: qrCode,
          sku: g.sku,
          product_name: g.product_name,
          size: g.size,
          color: g.color || "Cream",
          edition_number: edNum,
          edition_total: g.edition_total || 200,
          referral_code: `LITTLEBE-FAM-${suffix}`,
        };
      });

      const { data, error } = await supabase.from("garments").insert(records).select();

      if (error) {
        return new Response(
          JSON.stringify({ error: error.message }),
          { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
        );
      }

      const baseUrl = `${Deno.env.get("SUPABASE_URL")}/functions/v1/app`;
      const results = (data || []).map((g: any) => ({
        qr_code: g.qr_code,
        product_name: g.product_name,
        size: g.size,
        qr_url: `${baseUrl}?code=${g.qr_code}`,
      }));

      return new Response(
        JSON.stringify({ success: true, registered: results.length, garments: results }),
        { status: 201, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // ===== VIEW RECENT SCANS =====
    if (req.method === "GET" && action === "scans") {
      const { data, error } = await supabase
        .from("scans")
        .select("id, garment_id, ip_address, user_agent, scanned_at, garments(qr_code, product_name)")
        .order("scanned_at", { ascending: false })
        .limit(50);
      if (error) throw error;
      return new Response(
        JSON.stringify({ scans: data }),
        { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // ===== VIEW SPINS =====
    if (req.method === "GET" && action === "spins") {
      const { data, error } = await supabase
        .from("spins")
        .select("id, prize_label, discount_code, claimed_at, garments(qr_code, product_name)")
        .order("claimed_at", { ascending: false })
        .limit(50);
      if (error) throw error;
      return new Response(
        JSON.stringify({ spins: data }),
        { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // ===== VIEW MEMORIES =====
    if (req.method === "GET" && action === "memories") {
      const { data, error } = await supabase
        .from("memories")
        .select("id, type, child_name, moment_title, letter_to, letter_from, sealed_until, created_at, garments(qr_code, product_name)")
        .order("created_at", { ascending: false })
        .limit(50);
      if (error) throw error;
      return new Response(
        JSON.stringify({ memories: data }),
        { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    return new Response(
      JSON.stringify({ error: "Unknown action. Use: list, stats, register, batch, scans, spins, memories" }),
      { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );

  } catch (err) {
    return new Response(
      JSON.stringify({ error: "Internal server error" }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }
});