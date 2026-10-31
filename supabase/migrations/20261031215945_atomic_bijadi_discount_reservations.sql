-- Reserve scarce promotion capacity with the order; redeem only on verified payment.
CREATE TABLE public.discount_reservations (
  order_id uuid PRIMARY KEY REFERENCES public.orders(id) ON DELETE RESTRICT,
  discount_id uuid NOT NULL REFERENCES public.discount_codes(id) ON DELETE RESTRICT,
  state text NOT NULL DEFAULT 'reserved' CHECK (state IN ('reserved','redeemed','released')),
  amount_cents integer NOT NULL CHECK (amount_cents > 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  redeemed_at timestamptz,
  released_at timestamptz
);
CREATE INDEX discount_reservations_capacity_idx ON public.discount_reservations(discount_id,state);
ALTER TABLE public.discount_reservations ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.discount_reservations FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE ON public.discount_reservations TO service_role;

CREATE FUNCTION public.reserve_order_discount() RETURNS trigger
LANGUAGE plpgsql SECURITY INVOKER SET search_path = '' AS $$
DECLARE
  promotion public.discount_codes%ROWTYPE;
  held bigint;
  expected_amount bigint;
BEGIN
  IF coalesce(NEW.discount_cents,0) = 0 AND NEW.discount_code IS NULL THEN RETURN NEW; END IF;
  IF NEW.discount_code IS NULL OR coalesce(NEW.discount_cents,0) <= 0
     OR NEW.payment_method <> 'stripe' OR NEW.payment_status IS DISTINCT FROM 'pending'
     OR NEW.order_status IS NOT DISTINCT FROM 'cancelled' THEN
    RAISE EXCEPTION 'Discount unavailable' USING ERRCODE = '22023';
  END IF;
  -- All reservations for a code serialize on this row, including redemption/release.
  SELECT * INTO promotion FROM public.discount_codes WHERE code = NEW.discount_code FOR UPDATE;
  IF NOT FOUND OR promotion.active IS DISTINCT FROM true
     OR promotion.type NOT IN ('percent','fixed') OR promotion.value <= 0
     OR (promotion.type = 'percent' AND promotion.value > 100)
     OR coalesce(promotion.min_order_cents,0) < 0 OR coalesce(promotion.used_count,0) < 0
     OR (promotion.expires_at IS NOT NULL AND promotion.expires_at <= clock_timestamp())
     OR NEW.subtotal_cents < coalesce(promotion.min_order_cents,0)
     OR NEW.subtotal_cents <= 0 OR coalesce(NEW.shipping_cents,0) < 0 THEN
    RAISE EXCEPTION 'Discount unavailable' USING ERRCODE = '22023';
  END IF;
  expected_amount := CASE WHEN promotion.type = 'percent'
    THEN round(NEW.subtotal_cents::numeric * promotion.value / 100)::bigint
    ELSE least(promotion.value,NEW.subtotal_cents)::bigint END;
  IF expected_amount <= 0 OR NEW.discount_cents <> expected_amount
     OR NEW.total_cents::bigint <> NEW.subtotal_cents::bigint + coalesce(NEW.shipping_cents,0) - expected_amount THEN
    RAISE EXCEPTION 'Discount unavailable' USING ERRCODE = '22023';
  END IF;
  SELECT count(*) INTO held FROM public.discount_reservations WHERE discount_id = promotion.id AND state = 'reserved';
  IF promotion.max_uses IS NOT NULL AND coalesce(promotion.used_count,0)::bigint + held >= promotion.max_uses THEN
    RAISE EXCEPTION 'Discount unavailable' USING ERRCODE = '22023';
  END IF;
  INSERT INTO public.discount_reservations(order_id,discount_id,amount_cents)
    VALUES (NEW.id,promotion.id,NEW.discount_cents);
  RETURN NEW;
END;
$$;

CREATE FUNCTION public.settle_order_discount() RETURNS trigger
LANGUAGE plpgsql SECURITY INVOKER SET search_path = '' AS $$
DECLARE
  reservation public.discount_reservations%ROWTYPE;
BEGIN
  SELECT * INTO reservation FROM public.discount_reservations WHERE order_id = NEW.id;
  IF NOT FOUND THEN
    IF NEW.discount_code IS DISTINCT FROM OLD.discount_code OR NEW.discount_cents IS DISTINCT FROM OLD.discount_cents THEN
      RAISE EXCEPTION 'Order discount is immutable' USING ERRCODE = '22023';
    END IF;
    RETURN NEW;
  END IF;
  IF NEW.discount_code IS DISTINCT FROM OLD.discount_code
     OR NEW.discount_cents IS DISTINCT FROM OLD.discount_cents
     OR NEW.subtotal_cents IS DISTINCT FROM OLD.subtotal_cents
     OR NEW.shipping_cents IS DISTINCT FROM OLD.shipping_cents
     OR NEW.total_cents IS DISTINCT FROM OLD.total_cents
     OR NEW.payment_method IS DISTINCT FROM OLD.payment_method THEN
    RAISE EXCEPTION 'Order discount is immutable' USING ERRCODE = '22023';
  END IF;
  PERFORM 1 FROM public.discount_codes WHERE id = reservation.discount_id FOR UPDATE;
  SELECT * INTO reservation FROM public.discount_reservations WHERE order_id = NEW.id FOR UPDATE;
  IF NEW.payment_status = 'paid' AND reservation.state = 'released' THEN
    RAISE EXCEPTION 'Released discount requires reconciliation' USING ERRCODE = '22023';
  ELSIF NEW.payment_status = 'paid' AND reservation.state = 'reserved' THEN
    UPDATE public.discount_codes SET used_count = coalesce(used_count,0) + 1 WHERE id = reservation.discount_id;
    UPDATE public.discount_reservations SET state = 'redeemed', redeemed_at = now() WHERE order_id = NEW.id;
  ELSIF reservation.state = 'reserved' AND (NEW.payment_status = 'failed' OR NEW.order_status = 'cancelled') THEN
    UPDATE public.discount_reservations SET state = 'released', released_at = now() WHERE order_id = NEW.id;
  END IF;
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION public.reserve_order_discount() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.settle_order_discount() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.reserve_order_discount(), public.settle_order_discount() TO service_role;
CREATE TRIGGER reserve_order_discount AFTER INSERT ON public.orders FOR EACH ROW EXECUTE FUNCTION public.reserve_order_discount();
CREATE TRIGGER settle_order_discount AFTER UPDATE ON public.orders FOR EACH ROW EXECUTE FUNCTION public.settle_order_discount();
