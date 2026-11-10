# GS Call Scheduler

Monthly call-schedule builder for a General Surgery residency. The PGY-4 schedulers build it, PGY-5 chiefs review, the program director approves. Rules: v1.2 (v1.1 approved Nov 5, 2026).

**No resident names or data live in this repo.** This repo is public on purpose; keep it that way. The roster, call history and schedules are in the Supabase database. An admin uploads the setup bundle once.

## Pieces
| Part | Where | What |
|---|---|---|
| Website | Vercel (auto-deploys from `main`) | `index.html`, `styles.css`, `app.js` (screens), `auth.js` (sign-in), `engine.js` (rules + solver), `build-input.js` |
| Database + logins | Supabase project `gs-call-scheduler` | SQL in `supabase/*.sql`, row-level security on every table |
| Server functions | Supabase Edge Functions | `login` (username sign-in, JWT check OFF), `admin-users` (accounts), `interpret-notes` (Claude) |
| Keep-alive | `.github/workflows/keepalive.yml` | Pings twice a week so the free database never pauses |

## Roles
- `scheduler` (PGY-4s): build and edit, send to PD.
- `chief` (PGY-5s): swaps, own call picks, two-person exceptions (H3).
- `pd`: approve or send back.
- `resident`: view.
- `is_admin`: add people, set roles, turn accounts off. Schedulers, chiefs, the PD and the project owner are admins during the pilot.

## Secrets (never in this repo)
- Supabase: Edge Functions > Secrets > `ANTHROPIC_API_KEY` (optional `ANTHROPIC_MODEL`).
- The database password and the Supabase secret key stay in the Supabase dashboard.

## Handoff checklist
1. GitHub organization: add the new owner, remove the old one.
2. Supabase org and Vercel team: invite the new owner, transfer, leave.
3. Replace the Anthropic API key with the program's own key.
4. In the app, People tab: remove the old admin.

## New academic year
Update the setup bundle (`pgy`, `rotations` per month, `holidays`) and re-upload it from the app (admins). Add holiday dates in `build-input.js` (`HOLIDAYS`) and names in `app.js` (`HOLNAMES`).

## Tests

`node tests/rules-test.js <setup bundle .json>` builds December and January with the engine and checks the rules
(hard rules, holiday trios, T/EGS always two rounders, one team per holiday from that holiday's call pool, GS1 + GS2
sharing, off weekends, no roster names in this public repo). Read-only: it never touches the site or the database.
The roster bundle is private and is not in this repo. Run it after every change to `engine.js` or the rounding code.
