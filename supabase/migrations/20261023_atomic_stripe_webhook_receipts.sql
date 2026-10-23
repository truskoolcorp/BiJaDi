-- BiJaDi Stripe event ledger. Captured from the recovery migration applied 2026-10-23.
-- Apply only after comparing against the destination database. Do not replay blindly.
CREATE TABLE IF NOT EXISTS public.payment_webhook_receipts (
  provider text NOT NULL CHECK (provider IN ('stripe')),
  event_id text NOT NULL,
  event_type text NOT NULL,
  order_id uuid,
  checkout_session_id text,
  outcome text NOT NULL CHECK (outcome IN ('applied','duplicate_state','ignored')),
  processed_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (provider,event_id)
);
ALTER TABLE public.payment_webhook_receipts ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.payment_webhook_receipts FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT ON public.payment_webhook_receipts TO service_role;

CREATE OR REPLACE FUNCTION public.process_verified_stripe_checkout_event(
  p_event_id text, p_event_type text, p_order_id uuid, p_session_id text, p_payment_intent text
) RETURNS text LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE existing_payment text; existing_session text; changed integer; previous_outcome text;
BEGIN
 IF current_user <> 'postgres' AND auth.role() IS DISTINCT FROM 'service_role' THEN RAISE EXCEPTION 'not authorized' USING ERRCODE='42501'; END IF;
 IF p_event_id !~ '^evt_[A-Za-z0-9_]+$' OR length(p_event_id)>255
 OR p_session_id !~ '^cs_[A-Za-z0-9_]+$' OR length(p_session_id)>255
 OR p_event_type NOT IN ('checkout.session.completed','checkout.session.expired') THEN
 RAISE EXCEPTION 'invalid event metadata';
 END IF;
 SELECT outcome INTO previous_outcome FROM public.payment_webhook_receipts WHERE provider='stripe' AND event_id=p_event_id;
 IF FOUND THEN RETURN 'duplicate'; END IF;
 SELECT payment_status,stripe_session_id INTO existing_payment,existing_session
 FROM public.orders WHERE id=p_order_id FOR UPDATE;
 IF NOT FOUND OR existing_session IS DISTINCT FROM p_session_id THEN
 RAISE EXCEPTION 'order or session mismatch';
 END IF;
 IF p_event_type='checkout.session.completed' AND existing_payment='pending' THEN
 UPDATE public.orders SET payment_status='paid', order_status='confirmed',
 stripe_payment_intent=p_payment_intent,updated_at=now() WHERE id=p_order_id; GET DIAGNOSTICS changed=ROW_COUNT;
 ELSIF p_event_type='checkout.session.expired' AND existing_payment='pending' THEN
 UPDATE public.orders SET payment_status='failed',updated_at=now() WHERE id=p_order_id; GET DIAGNOSTICS changed=ROW_COUNT;
 ELSE changed:=0;
 END IF;
 INSERT INTO public.payment_webhook_receipts(provider,event_id,event_type,order_id,checkout_session_id,outcome)
 VALUES ('stripe',p_event_id,p_event_type,p_order_id,p_session_id,CASE WHEN changed=1 THEN 'applied' ELSE 'duplicate_state' END);
 RETURN CASE WHEN changed=1 THEN 'applied' ELSE 'duplicate_state' END;
END $$;
REVOKE ALL ON FUNCTION public.process_verified_stripe_checkout_event(text,text,uuid,text,text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.process_verified_stripe_checkout_event(text,text,uuid,text,text) TO service_role;
