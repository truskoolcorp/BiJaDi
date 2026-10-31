# BiJaDi shipping launch inputs

Checkout requires both the existing Stripe signing configuration and an explicitly confirmed `BIJADI_SHIPPING_CONFIG` environment value. Missing or malformed shipping configuration returns 503 before any catalog lookup, order or provider write.

The JSON object must contain:

| Field | Requirement |
|---|---|
| `version` | Integer `1` |
| `countries` | 1–50 unique supported uppercase two-letter country codes |
| `amount_cents` | Integer 0–100000, in USD cents, per entire order; zero explicitly means free shipping |
| `dispatch_estimate` | Confirmed customer-facing dispatch wording, 1–200 characters |

No production policy value is supplied in this repository. Confirm destinations, the flat per-order charge, customs/duties treatment and current dispatch commitment before configuring it. The same charge applies to every listed country and cart size. Use a different shipping implementation if that does not match the approved offer. This change does not calculate tax or customs/duties.

The policy is snapshotted onto each order and shown through the hosted Checkout shipping option/address message. Merchandise discounts do not discount shipping. The cart displays a subtotal; the final hosted checkout confirms shipping and discounts before payment.

Stripe collects the shipping recipient/address. Signed payment handling retrieves the current session, verifies totals and country against the order policy, normalizes only the necessary address fields, and saves the address atomically with the existing payment/receipt/discount transaction. Legacy orders without a policy retain the existing RPC path. Verified addresses and policy snapshots are immutable; corrections require a deliberate future support workflow.

Keep the dedicated webhook endpoint disabled until the signing secret is installed and verified. Do not treat deployment, mocked tests or a missing-configuration rejection as live paid/refund/fulfillment acceptance. Reconcile ambiguous sessions before releasing their discount reservations.

Validation:

- `node --test tests/checkout.test.cjs tests/webhook.test.cjs`
- `tests/shipping-transaction.sql` uses a rollback-only service-role transaction; no synthetic records should remain.
- `tests/payment-transaction.sql` and `tests/discount-reservations.sql` cover preserved legacy/payment and discount behavior.
