"""Copy the current Brightloop SQLite data into an empty PostgreSQL database."""

import sqlite3

import app


TABLES = (
    "users", "sessions", "password_resets", "taxes", "products", "variants",
    "plans", "discounts", "templates", "subscriptions", "subscription_items",
    "invoices", "invoice_lines", "payments",
)
ID_TABLES = set(TABLES) - {"sessions", "password_resets"}


def main():
    if not app.DB_PATH.exists():
        raise SystemExit("SQLite source database was not found; nothing was migrated.")
    app.load_local_database_url()
    cloud_url = app.DATABASE_URL
    if not cloud_url:
        raise SystemExit("Set BRIGHTLOOP_DATABASE_URL or add it to an untracked .env file first.")

    # Upgrade the local schema without adding demo data, then create cloud tables.
    app.DATABASE_URL = ""
    app.init_db(seed=False)
    app.DATABASE_URL = cloud_url
    try:
        target = app.connect()
    except Exception:
        raise SystemExit("Could not connect to PostgreSQL. Check the pooler host and network access.") from None
    try:
        for table in TABLES:
            exists = app.one(target, "SELECT to_regclass(?) AS table_name", (f"public.{table}",))["table_name"]
            if exists and app.one(target, f"SELECT COUNT(*) AS n FROM {table}")["n"]:
                raise SystemExit("PostgreSQL already contains Brightloop data. Migration stopped without changing it.")
    finally:
        target.close()
    app.init_db(seed=False)
    target = app.connect()

    source = sqlite3.connect(app.DB_PATH, isolation_level=None)
    source.row_factory = sqlite3.Row
    try:
        if any(app.one(target, f"SELECT COUNT(*) AS n FROM {table}")["n"] for table in TABLES):
            raise SystemExit("PostgreSQL already contains Brightloop data. Migration stopped without changing it.")
        source.execute("BEGIN")
        target.execute("BEGIN")
        counts = {}
        try:
            for table in TABLES:
                columns = [row["name"] for row in source.execute(f"PRAGMA table_info({table})")]
                names = ",".join(columns)
                marks = ",".join("?" for _ in columns)
                rows = source.execute(f"SELECT {names} FROM {table}").fetchall()
                for row in rows:
                    target.execute(f"INSERT INTO {table}({names}) VALUES({marks})", tuple(row))
                counts[table] = len(rows)
                if table in ID_TABLES:
                    next_id = app.one(target, f"SELECT COALESCE(MAX(id),0)+1 AS n FROM {table}")["n"]
                    target.execute(f"ALTER TABLE {table} ALTER COLUMN id RESTART WITH {next_id}")
            target.execute("COMMIT")
            source.execute("COMMIT")
        except Exception:
            target.execute("ROLLBACK")
            source.execute("ROLLBACK")
            raise
        print("Migrated Brightloop records to PostgreSQL:")
        for table, count in counts.items():
            print(f"  {table}: {count}")
    finally:
        source.close()
        target.close()


if __name__ == "__main__":
    main()
