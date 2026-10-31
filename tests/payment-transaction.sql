BEGIN;
SET LOCAL ROLE service_role;
DO $test$
DECLARE oid uuid:=gen_random_uuid(); sid text:='cs_audit_'||replace(gen_random_uuid()::text,'-',''); eid text:='evt_audit_'||replace(gen_random_uuid()::text,'-',''); outcome text; saved_at timestamptz;
BEGIN
 INSERT INTO public.orders(id,order_number,email,name,items,subtotal_cents,total_cents,payment_method,payment_status,order_status,stripe_session_id)
 VALUES(oid,'AUDIT-'||oid::text,'audit@example.invalid','Rollback-only audit','[]',4500,4500,'stripe','pending','preorder',sid);
 SELECT public.process_verified_stripe_checkout_event(eid,'checkout.session.async_payment_succeeded',oid,sid,'pi_audit') INTO outcome;
 IF outcome <> 'applied' OR NOT EXISTS(SELECT 1 FROM public.orders WHERE id=oid AND payment_status='paid' AND order_status='confirmed') THEN RAISE EXCEPTION 'delayed success failed'; END IF;
 SELECT updated_at INTO saved_at FROM public.orders WHERE id=oid;
 SELECT public.process_verified_stripe_checkout_event(eid,'checkout.session.async_payment_succeeded',oid,sid,'pi_audit') INTO outcome;
 IF outcome <> 'duplicate' THEN RAISE EXCEPTION 'event replay failed'; END IF;
 PERFORM public.process_verified_stripe_checkout_event(eid||'_other','checkout.session.completed',oid,sid,'pi_audit');
 PERFORM public.process_verified_stripe_checkout_event(eid||'_expired','checkout.session.expired',oid,sid,null);
 IF NOT EXISTS(SELECT 1 FROM public.orders WHERE id=oid AND payment_status='paid' AND updated_at=saved_at) THEN RAISE EXCEPTION 'paid state replay changed'; END IF;
 UPDATE public.orders SET payment_status='refunded' WHERE id=oid;
 PERFORM public.process_verified_stripe_checkout_event(eid||'_refund_replay','checkout.session.completed',oid,sid,'pi_audit');
 IF NOT EXISTS(SELECT 1 FROM public.orders WHERE id=oid AND payment_status='refunded') THEN RAISE EXCEPTION 'refund reopened'; END IF;
 UPDATE public.orders SET payment_status='pending',order_status='cancelled' WHERE id=oid;
 PERFORM public.process_verified_stripe_checkout_event(eid||'_cancel_replay','checkout.session.completed',oid,sid,'pi_audit');
 IF NOT EXISTS(SELECT 1 FROM public.orders WHERE id=oid AND payment_status='pending' AND order_status='cancelled') THEN RAISE EXCEPTION 'cancelled order reopened'; END IF;
 UPDATE public.orders SET order_status='preorder' WHERE id=oid;
 PERFORM public.process_verified_stripe_checkout_event(eid||'_new_expiry','checkout.session.expired',oid,sid,null);
 IF NOT EXISTS(SELECT 1 FROM public.orders WHERE id=oid AND payment_status='failed') THEN RAISE EXCEPTION 'expiry failed'; END IF;
 BEGIN
  PERFORM public.process_verified_stripe_checkout_event(eid||'_bad_session','checkout.session.completed',oid,sid||'_wrong','pi_audit');
  RAISE EXCEPTION 'wrong session accepted';
 EXCEPTION WHEN raise_exception THEN
  IF SQLERRM <> 'order or session mismatch' THEN RAISE; END IF;
 END;
 IF (SELECT count(*) FROM public.payment_webhook_receipts WHERE event_id=eid)<>1 THEN RAISE EXCEPTION 'duplicate receipt'; END IF;
END $test$;
RESET ROLE;
DO $test$
BEGIN
 IF has_function_privilege('anon','public.process_verified_stripe_checkout_event(text,text,uuid,text,text)','EXECUTE') OR has_function_privilege('authenticated','public.process_verified_stripe_checkout_event(text,text,uuid,text,text)','EXECUTE') THEN RAISE EXCEPTION 'public execution exposed'; END IF;
 IF (SELECT prosecdef FROM pg_proc WHERE oid='public.process_verified_stripe_checkout_event(text,text,uuid,text,text)'::regprocedure) THEN RAISE EXCEPTION 'definer privilege retained'; END IF;
END $test$;
ROLLBACK;
