BEGIN;
SET LOCAL ROLE service_role;
DO $test$
DECLARE
  oid uuid:=gen_random_uuid(); sid text:='cs_audit_'||replace(gen_random_uuid()::text,'-','');
  eid text:='evt_audit_'||replace(gen_random_uuid()::text,'-',''); expired_oid uuid:=gen_random_uuid();
  address jsonb:='{"name":"Synthetic recipient","address":{"line1":"1 Example Way","line2":null,"city":"Example","state":"TX","postal_code":"00000","country":"US"}}';
  policy jsonb:='{"version":1,"countries":["US"],"amount_cents":700,"dispatch_estimate":"Synthetic fixture only"}';
  first_verified_at timestamptz;
BEGIN
  INSERT INTO public.orders(id,order_number,email,name,items,subtotal_cents,shipping_cents,total_cents,payment_method,payment_status,order_status,stripe_session_id,shipping_policy)
    VALUES(oid,'AUDIT-'||oid,'audit@example.invalid','Rollback only','[]',4500,700,5200,'stripe','pending','preorder',sid,policy);
  BEGIN
    PERFORM public.process_verified_stripe_checkout_event(eid,'checkout.session.completed',oid,sid,'pi_audit');
    RAISE EXCEPTION 'Legacy RPC bypassed shipping';
  EXCEPTION WHEN invalid_parameter_value THEN NULL;
  END;
  IF EXISTS(SELECT 1 FROM public.payment_webhook_receipts WHERE event_id=eid) THEN RAISE EXCEPTION 'Failed payment retained receipt'; END IF;
  BEGIN
    PERFORM public.process_verified_bijadi_shipping_event(eid,'checkout.session.completed',oid,sid,'pi_audit',null);
    RAISE EXCEPTION 'Missing address accepted';
  EXCEPTION WHEN raise_exception THEN IF SQLERRM <> 'Verified address required' THEN RAISE; END IF; END;
  BEGIN
    PERFORM public.process_verified_bijadi_shipping_event(eid,'checkout.session.completed',oid,sid,'pi_audit',jsonb_set(address,'{address,country}','"DE"'));
    RAISE EXCEPTION 'Unsupported country accepted';
  EXCEPTION WHEN raise_exception THEN IF SQLERRM <> 'Invalid shipping destination' THEN RAISE; END IF; END;
  BEGIN
    UPDATE public.orders SET shipping_policy=jsonb_set(policy,'{amount_cents}','0') WHERE id=oid;
    RAISE EXCEPTION 'Shipping promise changed';
  EXCEPTION WHEN invalid_parameter_value THEN NULL; END;
  -- Session identity must match before any address mutation.
  BEGIN
    PERFORM public.process_verified_bijadi_shipping_event(eid,'checkout.session.completed',oid,'cs_wrong','pi_audit',address);
    RAISE EXCEPTION 'Wrong session accepted';
  EXCEPTION WHEN raise_exception THEN IF SQLERRM <> 'order or session mismatch' THEN RAISE; END IF; END;
  IF EXISTS(SELECT 1 FROM public.orders WHERE id=oid AND shipping_address_verified_at IS NOT NULL) THEN RAISE EXCEPTION 'Failed transaction retained address'; END IF;
  -- Force failure in the nested payment RPC after the wrapper writes the address.
  BEGIN
    INSERT INTO public.payment_webhook_receipts(provider,event_id,event_type,order_id,checkout_session_id,outcome)
      VALUES('stripe',eid,'checkout.session.completed',oid,sid||'_conflict','duplicate_state');
    PERFORM public.process_verified_bijadi_shipping_event(eid,'checkout.session.completed',oid,sid,'pi_audit',address);
    RAISE EXCEPTION 'Receipt mismatch accepted';
  EXCEPTION WHEN raise_exception THEN IF SQLERRM <> 'receipt identity mismatch' THEN RAISE; END IF; END;
  IF EXISTS(SELECT 1 FROM public.orders WHERE id=oid AND (shipping_address_verified_at IS NOT NULL OR payment_status <> 'pending')) THEN RAISE EXCEPTION 'Address not rolled back with failed payment'; END IF;
  PERFORM public.process_verified_bijadi_shipping_event(eid,'checkout.session.completed',oid,sid,'pi_audit',address);
  SELECT shipping_address_verified_at INTO first_verified_at FROM public.orders WHERE id=oid;
  IF first_verified_at IS NULL OR NOT EXISTS(SELECT 1 FROM public.orders WHERE id=oid AND payment_status='paid' AND shipping_address=address) THEN RAISE EXCEPTION 'Payment and address not saved'; END IF;
  PERFORM public.process_verified_bijadi_shipping_event(eid,'checkout.session.completed',oid,sid,'pi_audit',jsonb_set(address,'{name}','"Changed replay"'));
  IF NOT EXISTS(SELECT 1 FROM public.orders WHERE id=oid AND shipping_address=address AND shipping_address_verified_at=first_verified_at) THEN RAISE EXCEPTION 'Replay changed verified address'; END IF;
  BEGIN
    UPDATE public.orders SET shipping_address=jsonb_set(address,'{name}','"Changed"') WHERE id=oid;
    RAISE EXCEPTION 'Verified address changed';
  EXCEPTION WHEN invalid_parameter_value THEN NULL; END;
  INSERT INTO public.orders(id,order_number,email,name,items,subtotal_cents,shipping_cents,total_cents,payment_method,payment_status,order_status,stripe_session_id,shipping_policy)
    VALUES(expired_oid,'AUDIT-'||expired_oid,'audit@example.invalid','Rollback only','[]',4500,700,5200,'stripe','pending','preorder',sid||'_expired',policy);
  PERFORM public.process_verified_bijadi_shipping_event(eid||'_expired','checkout.session.expired',expired_oid,sid||'_expired',null,null);
  IF NOT EXISTS(SELECT 1 FROM public.orders WHERE id=expired_oid AND payment_status='failed' AND shipping_address_verified_at IS NULL) THEN RAISE EXCEPTION 'Expiry requires address'; END IF;
END $test$;
RESET ROLE;
DO $test$
BEGIN
  IF has_function_privilege('anon','public.process_verified_bijadi_shipping_event(text,text,uuid,text,text,jsonb)','EXECUTE')
     OR has_function_privilege('authenticated','public.process_verified_bijadi_shipping_event(text,text,uuid,text,text,jsonb)','EXECUTE') THEN RAISE EXCEPTION 'Public shipping mutation'; END IF;
END $test$;
ROLLBACK;
SELECT 'shipping transaction rollback checks passed' AS result;
