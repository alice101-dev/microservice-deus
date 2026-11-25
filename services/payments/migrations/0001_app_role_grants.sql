grant usage on schema public to payments_app;
grant select, insert, update, delete on all tables in schema public to payments_app;
alter default privileges in schema public grant select, insert, update, delete on tables to payments_app;
alter default privileges in schema public grant usage, select on sequences to payments_app;
