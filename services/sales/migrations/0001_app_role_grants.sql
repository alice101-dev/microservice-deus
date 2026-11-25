grant usage on schema public to sales_app;
grant select, insert, update, delete on all tables in schema public to sales_app;
alter default privileges in schema public grant select, insert, update, delete on tables to sales_app;
alter default privileges in schema public grant usage, select on sequences to sales_app;
