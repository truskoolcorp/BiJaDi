ALTER TABLE public.orders ADD COLUMN shipping_policy jsonb;
ALTER TABLE public.orders ADD COLUMN shipping_address_verified_at timestamptz;

CREATE FUNCTION public.guard_bijadi_shipping() RETURNS trigger
LANGUAGE plpgsql SECURITY INVOKER SET search_path='' AS $$
BEGIN
  IF TG_OP='UPDATE' AND (NEW.shipping_policy IS DISTINCT FROM OLD.shipping_policy
     OR (OLD.shipping_address_verified_at IS NOT NULL AND
       (NEW.shipping_address IS DISTINCT FROM OLD.shipping_address OR NEW.shipping_address_verified_at IS DISTINCT FROM OLD.shipping_address_verified_at))) THEN
    RAISE EXCEPTION 'Shipping promise and verified address are immutable' USING ERRCODE='22023';
  END IF;
  IF NEW.shipping_policy IS NOT NULL THEN
    IF jsonb_typeof(NEW.shipping_policy) IS DISTINCT FROM 'object'
       OR NEW.shipping_policy->>'version' IS DISTINCT FROM '1'
       OR jsonb_typeof(NEW.shipping_policy->'countries') IS DISTINCT FROM 'array'
       OR jsonb_array_length(NEW.shipping_policy->'countries') NOT BETWEEN 1 AND 50
       OR nullif(btrim(NEW.shipping_policy->>'dispatch_estimate'),'') IS NULL
       OR length(NEW.shipping_policy->>'dispatch_estimate') > 200
       OR (NEW.shipping_policy->>'amount_cents')::integer IS DISTINCT FROM NEW.shipping_cents
       OR coalesce(NEW.shipping_cents,-1) < 0 THEN
      RAISE EXCEPTION 'Invalid shipping policy' USING ERRCODE='22023';
    END IF;
    IF NEW.payment_status='paid' AND (NEW.shipping_address_verified_at IS NULL OR NEW.shipping_address IS NULL) THEN
      RAISE EXCEPTION 'Verified shipping address required' USING ERRCODE='22023';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION public.guard_bijadi_shipping() FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.guard_bijadi_shipping() TO service_role;
CREATE TRIGGER guard_bijadi_shipping BEFORE INSERT OR UPDATE ON public.orders FOR EACH ROW EXECUTE FUNCTION public.guard_bijadi_shipping();

CREATE FUNCTION public.process_verified_bijadi_shipping_event(
  p_event_id text,p_event_type text,p_order_id uuid,p_session_id text,p_payment_intent text,p_shipping_address jsonb
) RETURNS text LANGUAGE plpgsql SECURITY INVOKER SET search_path='' AS $$
DECLARE target public.orders%ROWTYPE; field_name text;
BEGIN
  IF current_user NOT IN ('postgres','service_role') THEN RAISE EXCEPTION 'not authorized' USING ERRCODE='42501'; END IF;
  IF p_event_id IS NULL OR p_event_id !~ '^evt_[A-Za-z0-9_]+$' OR length(p_event_id)>255 THEN RAISE EXCEPTION 'invalid event metadata'; END IF;
  -- Preserve the existing payment RPC's advisory-before-order lock order.
  PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('stripe:'||p_event_id,0));
  SELECT * INTO target FROM public.orders WHERE id=p_order_id FOR UPDATE;
  IF NOT FOUND OR target.stripe_session_id IS DISTINCT FROM p_session_id THEN RAISE EXCEPTION 'order or session mismatch'; END IF;
  IF target.shipping_policy IS NOT NULL AND p_event_type IN ('checkout.session.completed','checkout.session.async_payment_succeeded')
     AND target.payment_status='pending' AND target.order_status <> 'cancelled' THEN
    IF jsonb_typeof(p_shipping_address) IS DISTINCT FROM 'object' OR jsonb_typeof(p_shipping_address->'address') IS DISTINCT FROM 'object' THEN RAISE EXCEPTION 'Verified address required'; END IF;
    FOREACH field_name IN ARRAY ARRAY['line1','city','country'] LOOP
      IF jsonb_typeof(p_shipping_address->'address'->field_name) IS DISTINCT FROM 'string'
         OR nullif(btrim(p_shipping_address->'address'->>field_name),'') IS NULL
         OR length(p_shipping_address->'address'->>field_name)>200 THEN RAISE EXCEPTION 'Invalid shipping address'; END IF;
    END LOOP;
    IF jsonb_typeof(p_shipping_address->'name') IS DISTINCT FROM 'string' OR nullif(btrim(p_shipping_address->>'name'),'') IS NULL OR length(p_shipping_address->>'name')>200
       OR NOT (target.shipping_policy->'countries' ? (p_shipping_address->'address'->>'country')) THEN RAISE EXCEPTION 'Invalid shipping destination'; END IF;
    IF p_shipping_address->'address'->>'country' IN ('US','CA','GB','DE','ES','FR','IT','AU','NZ')
       AND nullif(btrim(p_shipping_address->'address'->>'postal_code'),'') IS NULL THEN RAISE EXCEPTION 'Postal code required'; END IF;
    IF p_shipping_address->'address'->>'country' IN ('US','CA','AU')
       AND nullif(btrim(p_shipping_address->'address'->>'state'),'') IS NULL THEN RAISE EXCEPTION 'State required'; END IF;
    IF length(p_shipping_address::text)>3000 THEN RAISE EXCEPTION 'Shipping address too large'; END IF;
    UPDATE public.orders SET shipping_address=p_shipping_address,shipping_address_verified_at=clock_timestamp() WHERE id=p_order_id;
  END IF;
  RETURN public.process_verified_stripe_checkout_event(p_event_id,p_event_type,p_order_id,p_session_id,p_payment_intent);
END;
$$;
REVOKE ALL ON FUNCTION public.process_verified_bijadi_shipping_event(text,text,uuid,text,text,jsonb) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.process_verified_bijadi_shipping_event(text,text,uuid,text,text,jsonb) TO service_role;
