# Submission checklist & form answers

Fill in the blanks marked ⟨…⟩. Verify every link in an incognito window before submitting.

## Form fields

| Field | Answer |
|---|---|
| Full name | Eslavath Kalyan |
| Registration number | 12302317 |
| University email | ⟨your LPU email⟩ |
| Internship role | Full-Stack Web Development |
| Assigned project title | Bus Booking Management System |
| Repository URL | ⟨https://github.com/…/safar-bus-booking⟩ (public, or add the reviewer as collaborator) |
| Primary branch | `main` |
| Final commit ID | ⟨output of `git rev-parse HEAD` after your last push⟩ |
| Video link (3–5 min) | ⟨Drive/YouTube unlisted link⟩ |
| Live demo URL | ⟨Render URL⟩ — or declare: "Local-only demo; exact steps in README (`docker compose up --build`)" |
| Technical report | `docs/TECHNICAL_REPORT.md` (link to it on GitHub) |
| Architecture / schema diagram | `docs/architecture.png`, `docs/er-diagram.svg` |
| API documentation | `/api/docs` on the live demo, and `docs/openapi.json` in the repo |
| Test/demo accounts | admin@safar.dev / Admin@12345 · ops.deccan@safar.dev / Operator@12345 · ravi@example.com / Passenger@12345 (all dummy) |
| Technology stack | React 18 + TypeScript + Vite + TanStack Query; Node.js + Express 5 + TypeScript + Zod; PostgreSQL 16; Vitest + Supertest; Docker; GitHub Actions |
| Setup notes | `npm install` → `cp .env.example server/.env` → `npm run db:reset` → `npm run dev`; or `docker compose up --build` |
| Known incomplete features / assumptions | Payments and refund payouts simulated; no email/SMS; IST only; lazy hold cleanup; route stops immutable after creation; in-memory rate limiting; no password reset (see README "Known limitations") |
| AI tools used & purpose | ⟨State truthfully, e.g. "Claude (Anthropic) — scaffolding, code generation, test and documentation drafts; I reviewed, ran, debugged and can explain all code."⟩ |
| Library / source attribution | Open-source libraries listed in README (MIT/ISC/Apache-2.0); Overpass font (OFL); no external datasets — all data fictional |

## Before you submit

- [ ] Read `docs/INTERVIEW_PREP.md` and practise the live changes
- [ ] `npm test` passes on your machine
- [ ] Push to GitHub; CI badge green (Actions tab)
- [ ] No `.env` committed (`git ls-files | grep .env` shows only `.env.example`)
- [ ] Deploy (optional): Neon free Postgres + Render free web service via `render.yaml`
- [ ] Record video using `docs/DEMO_VIDEO_SCRIPT.md`
- [ ] Open repo, report, video and demo links in incognito — all accessible
- [ ] Copy the final commit ID into the form
