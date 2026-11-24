# GSASG Registry

Registry software for the **Global Spinal Arthroplasty Study Group**, coordinated by the Institute of Neuro Innovation. It records motion-preserving spine surgery (cervical and lumbar disc replacement, facet replacement, dynamic stabilization and hybrid constructs) and follows patients for ten years.

> **Demo data only.** The hosted site runs on Supabase's free plan, which is not covered by a HIPAA Business Associate Agreement. Do not enter real patient information until the backend moves to a plan with a signed BAA.

## How it is built

| Piece | What it is |
|---|---|
| `src/app.html` | The whole application: one HTML file, no framework |
| `vendor/supabase.bundle.js` | The Supabase client library (v2), bundled |
| `config.json` | The Supabase project URL and anon key. Both are public by design |
| `build.mjs` | Produces `index.html`: the live version when `config.json` is filled in, otherwise the demo |
| `index.html` | What GitHub Pages serves. Generated; edit `src/app.html` instead |
| `supabase/schema.sql` | Database tables, access rules and audit trail. Paste into Supabase → SQL Editor and run |

## Access model

Enforced by the database (row-level security), so it holds whatever the browser does:

- **INI administrators** read and write every site, approve accounts and invite people.
- **Site users** read and write only their own site's patients.
- **New sign-ups** wait with no access until INI approves them, unless their email was invited. The first account ever created becomes the first INI administrator.
- **The audit log** is written by the database on every change and cannot be edited or deleted by anyone.

## Updating the site

```sh
npm install
node build.mjs          # rebuild index.html
npm run test:db         # access rules, against a real Postgres (PGlite)
npm run test:smoke      # every screen renders
node build.mjs --mock && python3 test/live_e2e.py   # sign-in, saving and site scoping end to end
git add -A && git commit -m "..." && git push
```

GitHub Pages republishes within a minute or two of each push.

## Before real patients

1. Move Supabase to a plan with a signed BAA.
2. Turn email confirmation back on, with a proper email provider.
3. Remove the demo patients (Users & access → Demo patients).
4. Obtain IRB approval for the protocol and consent forms.
