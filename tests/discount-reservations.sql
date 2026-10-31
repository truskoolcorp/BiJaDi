BEGIN;
SET LOCAL ROLE service_role;
DO $test$
DECLARE
  cid uuid := gen_random_uuid();
  promo text := 'AUDIT-' || cid::text;
  first_id uuid := gen_random_uuid();
  rejected_id uuid := gen_random_uuid();
  paid_id uuid := gen_random_uuid();
  expired_id uuid := gen_random_uuid();
  sid text := 'cs_audit_' || replace(gen_random_uuid()::text,'-','');
  eid text := 'evt_audit_' || replace(gen_random_uuid()::text,'-','');
BEGIN
  INSERT INTO public.discount_codes(id,code,type,value,max_uses,used_count,active)
    VALUES(cid,promo,'percent',10,1,0,true);
  INSERT INTO public.orders(id,order_number,email,name,items,subtotal_cents,discount_cents,discount_code,total_cents,payment_method,payment_status,order_status)
    VALUES(first_id,'AUDIT-'||first_id,'audit@example.invalid','Rollback only','[]',4500,450,promo,4050,'stripe','pending','preorder');
  IF (SELECT used_count FROM public.discount_codes WHERE id=cid) <> 0
     OR NOT EXISTS(SELECT 1 FROM public.discount_reservations WHERE order_id=first_id AND state='reserved') THEN
    RAISE EXCEPTION 'Reservation counted as paid';
  END IF;
  BEGIN
    INSERT INTO public.orders(id,order_number,email,name,items,subtotal_cents,discount_cents,discount_code,total_cents,payment_method,payment_status,order_status)
      VALUES(rejected_id,'AUDIT-'||rejected_id,'audit@example.invalid','Rollback only','[]',4500,450,promo,4050,'stripe','pending','preorder');
    RAISE EXCEPTION 'Capacity oversubscribed';
  EXCEPTION WHEN invalid_parameter_value THEN NULL;
  END;
  IF EXISTS(SELECT 1 FROM public.orders WHERE id=rejected_id) THEN RAISE EXCEPTION 'Rejected order persisted'; END IF;
  UPDATE public.orders SET payment_status='failed',order_status='cancelled' WHERE id=first_id;
  IF NOT EXISTS(SELECT 1 FROM public.discount_reservations WHERE order_id=first_id AND state='released') THEN RAISE EXCEPTION 'Cancel did not release'; END IF;
  INSERT INTO public.orders(id,order_number,email,name,items,subtotal_cents,discount_cents,discount_code,total_cents,payment_method,payment_status,order_status,stripe_session_id)
    VALUES(paid_id,'AUDIT-'||paid_id,'audit@example.invalid','Rollback only','[]',4500,450,promo,4050,'stripe','pending','preorder',sid);
  PERFORM public.process_verified_stripe_checkout_event(eid,'checkout.session.completed',paid_id,sid,'pi_audit');
  PERFORM public.process_verified_stripe_checkout_event(eid,'checkout.session.completed',paid_id,sid,'pi_audit');
  PERFORM public.process_verified_stripe_checkout_event(eid||'_async','checkout.session.async_payment_succeeded',paid_id,sid,'pi_audit');
  PERFORM public.process_verified_stripe_checkout_event(eid||'_expiry','checkout.session.expired',paid_id,sid,null);
  IF (SELECT used_count FROM public.discount_codes WHERE id=cid) <> 1
     OR NOT EXISTS(SELECT 1 FROM public.discount_reservations WHERE order_id=paid_id AND state='redeemed') THEN
    RAISE EXCEPTION 'Payment did not redeem exactly once';
  END IF;
  UPDATE public.orders SET payment_status='refunded' WHERE id=paid_id;
  PERFORM public.process_verified_stripe_checkout_event(eid||'_refund','checkout.session.completed',paid_id,sid,'pi_audit');
  IF (SELECT used_count FROM public.discount_codes WHERE id=cid) <> 1
     OR NOT EXISTS(SELECT 1 FROM public.orders WHERE id=paid_id AND payment_status='refunded') THEN RAISE EXCEPTION 'Refund reopened or use lost'; END IF;
  UPDATE public.discount_codes SET max_uses=2 WHERE id=cid;
  INSERT INTO public.orders(id,order_number,email,name,items,subtotal_cents,discount_cents,discount_code,total_cents,payment_method,payment_status,order_status,stripe_session_id)
    VALUES(expired_id,'AUDIT-'||expired_id,'audit@example.invalid','Rollback only','[]',4500,450,promo,4050,'stripe','pending','preorder',sid||'_expire');
  PERFORM public.process_verified_stripe_checkout_event(eid||'_unpaidexpiry','checkout.session.expired',expired_id,sid||'_expire',null);
  PERFORM public.process_verified_stripe_checkout_event(eid||'_latepaid','checkout.session.completed',expired_id,sid||'_expire','pi_audit');
  IF NOT EXISTS(SELECT 1 FROM public.discount_reservations WHERE order_id=expired_id AND state='released')
     OR NOT EXISTS(SELECT 1 FROM public.orders WHERE id=expired_id AND payment_status='failed') THEN RAISE EXCEPTION 'Expired order reopened'; END IF;
  BEGIN
    UPDATE public.orders SET payment_status='paid' WHERE id=expired_id;
    RAISE EXCEPTION 'Released order paid without reconciliation';
  EXCEPTION WHEN invalid_parameter_value THEN NULL;
  END;
  BEGIN
    INSERT INTO public.orders(id,order_number,email,name,items,subtotal_cents,discount_cents,discount_code,total_cents,payment_method,payment_status,order_status)
      VALUES(rejected_id,'AUDIT-'||rejected_id,'audit@example.invalid','Rollback only','[]',4500,451,promo,4049,'stripe','pending','preorder');
    RAISE EXCEPTION 'Incorrect amount accepted';
  EXCEPTION WHEN invalid_parameter_value THEN NULL;
  END;
  BEGIN
    UPDATE public.orders SET total_cents=1 WHERE id=paid_id;
    RAISE EXCEPTION 'Discounted total changed';
  EXCEPTION WHEN invalid_parameter_value THEN NULL;
  END;
END $test$;
RESET ROLE;
DO $test$
BEGIN
  IF has_table_privilege('anon','public.discount_reservations','SELECT')
     OR has_table_privilege('authenticated','public.discount_reservations','SELECT')
     OR has_function_privilege('anon','public.reserve_order_discount()','EXECUTE')
     OR has_function_privilege('authenticated','public.settle_order_discount()','EXECUTE') THEN RAISE EXCEPTION 'Public reservation access'; END IF;
  IF EXISTS(SELECT 1 FROM pg_proc WHERE oid IN ('public.reserve_order_discount()'::regprocedure,'public.settle_order_discount()'::regprocedure) AND prosecdef) THEN RAISE EXCEPTION 'Definer privileges'; END IF;
END $test$;
ROLLBACK;
SELECT 'discount reservation rollback checks passed' AS result;
