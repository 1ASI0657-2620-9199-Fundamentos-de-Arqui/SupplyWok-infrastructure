#!/bin/bash
set -e

# Ensure database supplywok exists
if [ "$POSTGRES_DB" != "supplywok" ]; then
    psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" <<-EOSQL
        SELECT 'CREATE DATABASE supplywok'
        WHERE NOT EXISTS (SELECT FROM pg_database WHERE datname = 'supplywok')\gexec
EOSQL
fi

# Create roles and schemas in supplywok database
psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname "supplywok" <<-EOSQL
    DO \$\$
    BEGIN
        IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'iam_svc') THEN
            CREATE ROLE iam_svc LOGIN PASSWORD '${IAM_DB_PASSWORD}';
        ELSE
            ALTER ROLE iam_svc WITH PASSWORD '${IAM_DB_PASSWORD}';
        END IF;

        IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'inventory_svc') THEN
            CREATE ROLE inventory_svc LOGIN PASSWORD '${INVENTORY_DB_PASSWORD}';
        ELSE
            ALTER ROLE inventory_svc WITH PASSWORD '${INVENTORY_DB_PASSWORD}';
        END IF;

        IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'operations_svc') THEN
            CREATE ROLE operations_svc LOGIN PASSWORD '${OPERATIONS_DB_PASSWORD}';
        ELSE
            ALTER ROLE operations_svc WITH PASSWORD '${OPERATIONS_DB_PASSWORD}';
        END IF;

        IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'purchasing_svc') THEN
            CREATE ROLE purchasing_svc LOGIN PASSWORD '${PURCHASING_DB_PASSWORD}';
        ELSE
            ALTER ROLE purchasing_svc WITH PASSWORD '${PURCHASING_DB_PASSWORD}';
        END IF;
    END
    \$\$;

    CREATE SCHEMA IF NOT EXISTS iam AUTHORIZATION iam_svc;
    CREATE SCHEMA IF NOT EXISTS inventory AUTHORIZATION inventory_svc;
    CREATE SCHEMA IF NOT EXISTS operations AUTHORIZATION operations_svc;
    CREATE SCHEMA IF NOT EXISTS purchasing AUTHORIZATION purchasing_svc;

    GRANT ALL ON SCHEMA iam TO iam_svc;
    GRANT ALL ON SCHEMA inventory TO inventory_svc;
    GRANT ALL ON SCHEMA operations TO operations_svc;
    GRANT ALL ON SCHEMA purchasing TO purchasing_svc;
EOSQL
