# Retailer Email Coverage Matrix (Issue #227)

Per-retailer Gmail bill-delivery coverage, as of 2026-07-15. Drives the
domain-seeding in migration `0017_retailer_email_domains.sql` and documents
which retailers are **PDF-attached** (ingested today) vs **link-only**
(blocked-on #114 email-fallback).

| Retailer | PDF attached? | Link-only? | Sender domain(s) | Sample subject | Source |
|----------|:---:|:---:|---|---|---|
| Contact Energy | Yes | — | `contactenergy.co.nz` | "Your monthly bill is ready" | [contact.co.nz](https://contact.co.nz/) — public support address `help@contactenergy.co.nz`; billing sender domain confirmed |
| Mercury | Yes | — | `mercury.co.nz` | "Your Mercury invoice" | [mercury.co.nz](https://www.mercury.co.nz/) — `customerservice@mercury.co.nz`; bill-by-email FAQ |
| Genesis Energy | Yes | — | `genesisenergy.co.nz` | "Your Genesis bill is ready to view" | [Genesis help FAQ](https://www.genesisenergy.co.nz/help/faqs/receiving-my-bill) — explicitly names `noreply@billing.genesisenergy.co.nz` (subdomain) |
| Meridian Energy | Yes | — | `meridianenergy.co.nz`, `meridian.co.nz` | "Your Meridian Energy statement" | [Meridian contact](https://www.meridianenergy.co.nz/for-home/contact-us) — bills now sent from `hello@hub.meridian.co.nz`; both root domains used historically |
| Trustpower | Yes | — | `trustpower.co.nz` | "Your Trustpower account statement" | [Powerswitch NZ](https://www.powerswitch.org.nz/retailers/trustpower) — brand absorbed by Mercury; legacy accounts still on trustpower.co.nz domain |
| Nova Energy | Yes | — | `novaenergy.co.nz` | "Your Nova Energy bill" | [novaenergy.co.nz](https://www.novaenergy.co.nz/help-advice/billing-payments/what-are-the-different-ways-i-can-receive-my-bills) — E-bill via email; `info@novaenergy.co.nz` |
| Electric Kiwi | — | Yes (blocked-on #114) | `electrickiwi.co.nz` | "Your Electric Kiwi bill is ready" | [electrickiwi.co.nz FAQ](https://www.electrickiwi.co.nz/faqs/all-services) — bills emailed with a "view your bill" login link; no PDF attachment |
| Powershop | — | Yes (blocked-on #114) | `powershop.co.nz`, `team.powershop.co.nz` | "Your Powershop bill is ready to view" | [powershop.co.nz](https://www.powershop.co.nz/contact-us/) — `hello@team.powershop.co.nz`; bill-ready notifications link to the app, no PDF |
| Flick Electric | Yes | — | `flickelectric.co.nz` | "Your Flick weekly bill" | [Flick Customer Care Policy (PDF)](https://assets.ctfassets.net/6tcv807rkpv1/6OeTy5kvat5WXOSO8Garak/c4ebdddbd379ed3c8ed6292bc62f8274/FLICK0125_FLICK_Customer_Care_Policy_FA_JUNE_2024_FA.pdf) — "We use email to send out all billing"; brand absorbed by Meridian, domain still in use for legacy accounts |
| Pulse Energy | Yes | — | `pulseenergy.co.nz` | "Your Pulse Energy invoice" | [pulseenergy.co.nz](https://pulseenergy.co.nz/contact-us/) — `customer.care@pulseenergy.co.nz` |

## How this matrix is used

- **Sender domains** are seeded into `retailers.email_domains` (migration
  `0017`) and unioned with retailer name keywords in
  `emailPoller.buildSearchQuery`, so a bill from any of these domains is
  caught by the Gmail `from:` search regardless of the display name.
- **PDF-attached** retailers (8 of 10) are fully ingested today: the poller
  downloads the PDF, stores it in R2, creates a `bills` row, and enqueues a
  PARSE_QUEUE job.
- **Link-only** retailers (Electric Kiwi, Powershop) email a "view your bill"
  link rather than attaching a PDF. They are matched by sender domain and
  logged, but no bill is ingested until the HTML-body / link-following
  fallback lands (**blocked-on #114**). The `has:attachment` clause in the
  Gmail search currently suppresses these entirely — the domain match exists
  so #114 can drop `has:attachment` for these two retailers without further
  schema work.

## Research notes / uncertainty

- **Subdomain matching**: Genesis bills from `billing.genesisenergy.co.nz` and
  Meridian from `hub.meridian.co.nz`. We store the bare root domain because
  Gmail's `from:` operator matches on substring (`from:genesisenergy.co.nz`
  matches any subdomain).
- **Brand migrations**: Trustpower → Mercury and Flick → Meridian are in
  progress. Legacy accounts still receive mail from the absorbed-brand domain;
  both are retained so historical bills are not missed. Once migrations
  complete these rows can be dropped.
- **Trustpower `domain` column**: migration `0002` seeded `trustpower.co.nz`
  as the website `domain`; this matches the billing sender domain, so no
  divergence there (unlike Contact Energy, whose website domain is
  `contact.co.nz` but whose billing sender domain is `contactenergy.co.nz`).
