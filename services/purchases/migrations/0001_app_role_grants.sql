grant usage on schema public to purchases_app;
grant select, insert, update, delete on all tables in schema public to purchases_app;
alter default privileges in schema public grant select, insert, update, delete on tables to purchases_app;
alter default privileges in schema public grant usage, select on sequences to purchases_app;
