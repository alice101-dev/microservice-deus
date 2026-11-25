grant usage on schema public to accounts_app;
grant select, insert, update, delete on all tables in schema public to accounts_app;
alter default privileges in schema public grant select, insert, update, delete on tables to accounts_app;
alter default privileges in schema public grant usage, select on sequences to accounts_app;
