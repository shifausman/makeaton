# Brightloop subscription management demo

A hackathon app for three roles: admin, staff, and customer. It uses Python's standard library, SQLite for local development, optional PostgreSQL for a shared deployment, and a responsive HTML/CSS/JavaScript interface.

## Run

```powershell
python app.py
```

Open **http://127.0.0.1:8000/**. The database is created automatically in `data/brightloop.db` on first run.

### Connect Supabase PostgreSQL

1. Install the PostgreSQL driver: `python -m pip install -r requirements.txt`.
2. In Supabase, open **Connect → Session pooler** and copy its PostgreSQL connection string (port `5432`). The direct `db.PROJECT_REF.supabase.co` host requires IPv6; the Session pooler works on IPv4 networks.
3. Copy `.env.example` to `.env`, replace the placeholder with that connection string, and keep `.env` private. It is excluded from Git.
4. Stop the app, run `python migrate_to_postgres.py` once to copy the existing SQLite data into an **empty** PostgreSQL database, then run `python app.py` again. The app reads `.env` when launched directly and all roles use that one PostgreSQL database.

The migration stops if Brightloop tables in PostgreSQL already contain records. The SQLite file remains as a local backup.

### Demo accounts

| Role | Email | Password |
| --- | --- | --- |
| Admin | `admin@brightloop.test` | `Admin@123!` |
| Staff | `staff@brightloop.test` | `Staff@123!` |
| Customer | `asha@demo.test` | `Customer@123!` |

Sign in with one of these demo accounts. The starter data includes a product, variant, add-on, monthly and yearly plans, a tax rule, a discount, a quotation template, and one active customer subscription due for billing today.

## Demo story

1. Sign in as **Admin** and open **Catalog & rules**. Create a billing plan with its description, price, cycle, and included features. Use **Edit** to change it or **Deactivate** to hide it from new signups.
2. Sign in as **Staff** and open **Available Plans**. Select **Use for quotation** on an active plan. Staff can also create a quotation from **Quote templates** or **Subscriptions**.
3. Sign in as **Customer** and open **Explore Plans**. Select an active plan, set the quantity, and submit a request. It appears under **My subscriptions** as a Draft and in the staff subscription pipeline. Staff can **Send to quote**, **Confirm**, and **Activate** it.
4. Open **Renewals**. The calendar places each active subscription on its next billing date. Select an event to show the customer, plan, date, and estimated amount. Review **Upcoming renewals** (next 7 days) and **Overdue renewals** separately.
5. Press **Run billing**. Due active subscriptions produce Draft invoices with line items, eligible discounts, and taxes. The calendar then shows the period under **Already billed**. A unique database constraint prevents two invoices for the same subscription and billing period.
6. Confirm an invoice and record a full or partial payment. A fully paid invoice becomes **Paid**. Customers see only their own subscriptions and invoices.

## What is implemented

- Email/password registration, role-based access, sessions, and password reset tokens.
- Admin catalog: products, variants, plans, taxes, discounts, staff accounts. Plans can be created, edited, activated, and deactivated.
- Staff and customer plan catalogues load active plans from `/api/plans`. The UI checks for changes every 20 seconds and when the catalogue is opened or the tab becomes visible. Customer requests create Draft subscriptions through `/api/plan-requests`.
- Each subscription saves its plan name, description, features, billing cycle, and lifecycle rules when created. Later plan edits or deactivation do not change the existing subscription or its saved line price.
- Quotation templates, subscription product lines and status transitions.
- Daily, weekly, monthly, and yearly billing cycles; due-date processing; invoice calculation and duplicate protection.
- Invoice confirmation, cancellation, print view, demo send status, and payment recording.
- Role-specific dashboards, customer portal, invoice balances, overdue counts, and a summary report. The monthly equivalent metric is gross recurring line value before discounts and tax.
- Monthly renewal calendar for admin, staff, and customers; customer data is restricted to their own subscriptions. Upcoming and overdue alerts show estimated amounts using the same pricing rules as billing, without consuming discounts. Billed periods use actual invoice amounts.
- Paginated API lists (25 records by default, maximum 100) and indexes for common billing queries.

## Test

```powershell
python -m unittest discover -s tests -v
```

The tests use a temporary database and check role permissions, plan updates and visibility, customer plan requests, saved subscription terms, the quotation-to-payment flow, invoice totals, duplicate billing prevention, renewal alerts, billed periods, and customer isolation.

## Demo boundaries

This app runs on `127.0.0.1` and uses fictional INR amounts. **Run billing** represents the scheduled billing job so judges can trigger it on demand. **Mark sent** records a send timestamp; it does not email an invoice. Password-reset links are shown locally because no email service is configured. Payments are recorded against invoices; no bank or card gateway is connected. These integrations should be added before a production deployment.

All roles on one local server use the same `data/brightloop.db` file. Existing databases are upgraded automatically on startup. When `BRIGHTLOOP_DATABASE_URL` is configured, the backend uses shared PostgreSQL instead, including the existing role and customer data checks.

The seeded passwords and local reset links are for the hackathon demo only. Do not expose this server to the internet with the demo accounts enabled.
