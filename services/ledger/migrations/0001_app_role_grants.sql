grant usage on schema public to ledger_app;
grant select, insert, update, delete on all tables in schema public to ledger_app;
alter default privileges in schema public grant select, insert, update, delete on tables to ledger_app;
alter default privileges in schema public grant usage, select on sequences to ledger_app;
