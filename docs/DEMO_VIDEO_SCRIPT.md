# 3–5 minute walkthrough video — shot list & script

Record at 1280×800 or 1920×1080, browser zoom 100%. Run `npm run db:reset` first so data is fresh. Keep a second browser window (incognito) logged in as `priya@example.com`.

| Time | Screen | Say (roughly) |
|---|---|---|
| 0:00–0:20 | README top / architecture diagram | "I'm Eslavath Kalyan. This is Safar, a bus booking system — React, Express with TypeScript, and PostgreSQL. The key idea: seats are booked stop to stop, and PostgreSQL itself guarantees no double booking." |
| 0:20–1:20 | Home → search Hyderabad→Vijayawada (tomorrow) → results → Choose seats | "Search shows boarding and drop points, duration and seats free *for my stretch*. Here L2 is booked Ameerpet→Vijayawada… if I switch to Vijayawada→Vizag, L2 shows as free again." (change drop point to Visakhapatnam / boarding to Vijayawada to show it) |
| 1:20–2:00 | Select 2 berths → log in (one-click Passenger) → Hold → checkout | "Holding seats gives me 10 minutes. In the other window Priya sees them as on hold." (switch to incognito, show striped seats) |
| 2:00–2:30 | Submit empty form → errors → fill → confirm → ticket | "Server-side validation. Confirming uses an idempotency key, so a double-click never books twice. Here's the PNR with passengers, route, date and seats." |
| 2:30–3:00 | Cancel one ticket → quote → confirm → seat map | "Cancellation follows the policy captured at booking time — 25 hours out gives 75%. The refund is pending and the seat is free again." |
| 3:00–3:50 | Log in as operator → Dashboard → trip → Manifest → Occupancy → Reconciliation → Refunds (mark paid) → Audit | "Operators see manifests, segment-wise occupancy and a reconciliation report that cross-checks manifest, occupancy, tickets and money. Refunds move through a state machine. Every action is in an append-only audit trail." |
| 3:50–4:30 | Terminal: `npm test` (62 passing) → `concurrency.test.ts` → `/api/docs` | "62 tests against a real database, including 20 users racing for one seat — exactly one wins — and a raw SQL insert being rejected by the exclusion constraint. API docs are generated from the same validation schemas." |
| 4:30–4:50 | README limitations section | "Payments are simulated; limitations are listed honestly in the README. Thanks for watching." |

Tips: hide bookmarks bar, close notifications, speak slowly, don't read code line by line. Upload to Google Drive / YouTube (unlisted) and **check the link in an incognito window** before submitting.
