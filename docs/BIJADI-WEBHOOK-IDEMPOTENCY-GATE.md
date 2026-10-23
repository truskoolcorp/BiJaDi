# BiJaDi webhook idempotency and recovery gate

Status: **design only, not deployed**. The production Supabase project is currently inactive.

## Required atomic contract

A Stripe webhook must **not** acknowledge success merely because a SQL update affected zero rows or because a duplicate event arrived. The backend must distinguish:

1. New event, matching order and session, transitioned to the expected state: commit receipt + order transition in **one database transaction**.
2. Duplicate event ID previously committed: return HTTP 200 without new side effects.
3. Valid signed event with order not yet visible: return retryable 5xx, unless an explicitly supported terminal reconciliation path exists.
4. Session ID mismatches the order: record a redacted security diagnostic, no mutation; escalate for reconciliation.
5. Expiration arrives after payment: retain paid state; event handling should be durably recorded, not reverse the payment.
6. Database error: return 5xx; allow Stripe retry.
7. Event unsupported by business logic: record safely, then acknowledge without mutations.

## Schema proposal (must be reviewed against the actual orders table before migration)

Use a dedicated ledger with provider + event_id unique, received_at, processed_at, status, event_type, order_id, and sanitized error category. Avoid storing raw payloads or payment secrets. A single SECURITY DEFINER database function with a locked-down search_path and explicit EXECUTE grants must:
- Insert/claim event uniquely.
- Atomically compare `orders.id`, `stripe_session_id`, and payment state.
- Transition pending -> paid/failed, record the receipt, and commit once.
- Guarantee concurrent deliveries produce one committed outcome.
- Fail the whole transaction if any step fails; never mark an event processed before payment state persists.
- Enforce Stripe event ID format and limit parameters; take identifiers only from successfully signature-verified webhook payloads.
- Keep irreversible fulfillment in a separate idempotent worker keyed by order ID.

**Do not deploy a partial receipt write followed by an unrelated order update:** concurrent retries could make a paid event disappear.

## Test matrix (non-production)
- Good Stripe HMAC + current timestamp -> authorized event accepted once.
- Invalid header, wrong HMAC, missing secret, stale timestamp -> reject, no database access.
- Duplicate delivery with same `evt_` ID -> same terminal receipt, no second mutation.
- Two simultaneous identical deliveries -> exactly one commit.
- Expired then completed; completed then expired -> correct terminal policy; never downgrade paid.
- Event references another order's checkout session -> zero mutation, security record.
- Unknown order; database unavailable; RPC permission error -> retryable failure.
- Missing metadata; unsupported event type -> defined receipt and response.
- Coinbase unsigned payload -> rejected; no data write.
- Storefront checkout and admin route smoke tests.

## Deployment gate
Source code in GitHub PR #1 is not automatically deployed to Supabase. Restore project only via permitted account workflow, inventory and back up its schema and secrets, implement the SQL migration + RPC, test isolated checkout/webhook fixtures, then deploy with rollback evidence. No payment events should be fabricated against live orders.
