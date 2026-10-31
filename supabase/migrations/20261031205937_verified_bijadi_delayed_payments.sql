-- Stripe is verified by the webhook before this server-only transaction.
-- Keep the existing signature and receipt ledger; accept the original delayed-success event type.
CREATE OR REPLACE FUNCTION public.process_verified_stripe_checkout_event(
 p_event_id text,p_event_type text,p_order_id uuid,p_session_id text,p_payment_intent text
) RETURNS text LANGUAGE plpgsql SECURITY INVOKER SET search_path TO '' AS $function$
DECLARE existing_payment text; existing_session text; existing_order_status text;
 changed integer; previous_receipt public.payment_webhook_receipts%ROWTYPE;
BEGIN
 IF current_user NOT IN ('postgres','service_role') THEN
  RAISE EXCEPTION 'not authorized' USING ERRCODE='42501';
 END IF;
 IF p_event_id IS NULL OR p_session_id IS NULL OR p_order_id IS NULL OR p_event_type IS NULL
 OR p_event_id !~ '^evt_[A-Za-z0-9_]+$' OR length(p_event_id)>255
 OR p_session_id !~ '^cs_[A-Za-z0-9_]+$' OR length(p_session_id)>255
 OR p_event_type NOT IN ('checkout.session.completed','checkout.session.async_payment_succeeded','checkout.session.expired') THEN
  RAISE EXCEPTION 'invalid event metadata';
 END IF;
 PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('stripe:' || p_event_id,0));
 SELECT * INTO previous_receipt FROM public.payment_webhook_receipts WHERE provider='stripe' AND event_id=p_event_id;
 IF FOUND THEN
  IF previous_receipt.order_id IS DISTINCT FROM p_order_id OR previous_receipt.checkout_session_id IS DISTINCT FROM p_session_id THEN
   RAISE EXCEPTION 'receipt identity mismatch';
  END IF;
  RETURN 'duplicate';
 END IF;
 SELECT payment_status,stripe_session_id,order_status INTO existing_payment,existing_session,existing_order_status
 FROM public.orders WHERE id=p_order_id FOR UPDATE;
 IF NOT FOUND OR existing_session IS DISTINCT FROM p_session_id THEN RAISE EXCEPTION 'order or session mismatch'; END IF;
 IF p_event_type IN ('checkout.session.completed','checkout.session.async_payment_succeeded')
 AND existing_payment='pending' AND existing_order_status <> 'cancelled' THEN
  UPDATE public.orders SET payment_status='paid',order_status='confirmed',stripe_payment_intent=p_payment_intent,updated_at=pg_catalog.now() WHERE id=p_order_id;
  GET DIAGNOSTICS changed=ROW_COUNT;
 ELSIF p_event_type='checkout.session.expired' AND existing_payment='pending' THEN
  UPDATE public.orders SET payment_status='failed',updated_at=pg_catalog.now() WHERE id=p_order_id;
  GET DIAGNOSTICS changed=ROW_COUNT;
 ELSE changed:=0;
 END IF;
 INSERT INTO public.payment_webhook_receipts(provider,event_id,event_type,order_id,checkout_session_id,outcome)
 VALUES('stripe',p_event_id,p_event_type,p_order_id,p_session_id,CASE WHEN changed=1 THEN 'applied' ELSE 'duplicate_state' END);
 RETURN CASE WHEN changed=1 THEN 'applied' ELSE 'duplicate_state' END;
END $function$;
REVOKE ALL ON FUNCTION public.process_verified_stripe_checkout_event(text,text,uuid,text,text) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.process_verified_stripe_checkout_event(text,text,uuid,text,text) TO service_role;
