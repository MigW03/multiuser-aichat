#!/usr/bin/env bash
# Applies every migration to a throwaway database and runs the SQL tests in this folder.
# Needs a running Postgres 15+ (PGHOST/PGPORT/PGUSER as for psql). Example:
#   PGHOST=/var/tmp/pgtest PGPORT=54329 PGUSER=postgres supabase/tests/run.sh
set -euo pipefail
cd "$(dirname "$0")"
DB="mc_test_$$"
psql -v ON_ERROR_STOP=1 -q -d postgres -c "create database $DB"
trap 'psql -q -d postgres -c "drop database if exists $DB" >/dev/null' EXIT
# roles are cluster-wide: create them once
psql -q -d postgres -tAc "select 1 from pg_roles where rolname = 'anon'" | grep -q 1 && SKIP_ROLES=1 || SKIP_ROLES=0
if [ "$SKIP_ROLES" = 1 ]; then
  sed -e '/^create role/d' bootstrap.sql | psql -v ON_ERROR_STOP=1 -q -d "$DB"
else
  psql -v ON_ERROR_STOP=1 -q -d "$DB" -f bootstrap.sql
fi
for f in ../migrations/*.sql; do
  echo "migration $(basename "$f")"
  psql -v ON_ERROR_STOP=1 -q -d "$DB" -f "$f"
done
for t in test_*.sql; do
  echo "== $t"
  psql -v ON_ERROR_STOP=1 -q -d "$DB" -f "$t"
done
echo "all tests passed"
