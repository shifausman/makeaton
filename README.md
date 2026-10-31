# Brightloop subscription management demo

A local, dependency-free hackathon app for three roles: admin, staff, and customer. It uses Python's standard library, SQLite, and a responsive HTML/CSS/JavaScript interface.

## Run

```powershell
python app.py
```

Open **http://127.0.0.1:8000/**. The database is created automatically in `data/brightloop.db` on first run.

### Demo accounts

| Role | Email | Password |
| --- | --- | --- |
| Admin | `admin@brightloop.test` | `Admin@123!` |
| Staff | `staff@brightloop.test` | `Staff@123!` |
| Customer | `asha@demo.test` | `Customer@123!` |

The sign-in screen has one-click buttons for these accounts. The starter data includes a product, variant, add-on, monthly and yearly plans, a tax rule, a discount, a quotation template, and one active customer subscription due for billing today.

## Demo story

1. Sign in as **Admin** and inspect **Catalog & rules**. Create a product, plan, tax, discount, or staff account.
2. Sign in as **Staff** and create a quotation from **Quote templates** or **Subscriptions**. Confirm and activate it.
3. Open **Renewals**. The calendar places each active subscription on its next billing date. Select an event to show the customer, plan, date, and estimated amount. Review **Upcoming renewals** (next 7 days) and **Overdue renewals** separately.
4. Press **Run billing**. Due active subscriptions produce Draft invoices with line items, eligible discounts, and taxes. The calendar then shows the period under **Already billed**. A unique database constraint prevents two invoices for the same subscription and billing period.
5. Confirm an invoice and record a full or partial payment. A fully paid invoice becomes **Paid**.
6. Sign in as **Customer** and open **My renewals** to see only that customer's dates and amounts. The customer can also see their own subscriptions and invoices. Plan rules govern pause, resume, close, and renew actions.

## What is implemented

- Email/password registration, role-based access, sessions, and password reset tokens.
- Admin catalog: products, variants, plans, taxes, discounts, staff accounts.
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

The tests use a temporary database and check role permissions, the quotation-to-payment flow, invoice totals, duplicate billing prevention, renewal alerts, billed periods, and customer isolation.

## Demo boundaries

This app runs on `127.0.0.1` and uses fictional INR amounts. **Run billing** represents the scheduled billing job so judges can trigger it on demand. **Mark sent** records a send timestamp; it does not email an invoice. Password-reset links are shown locally because no email service is configured. Payments are recorded against invoices; no bank or card gateway is connected. These integrations should be added before a production deployment.

The seeded passwords and local reset links are for the hackathon demo only. Do not expose this server to the internet with the demo accounts enabled.
