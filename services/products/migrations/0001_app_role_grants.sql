grant usage on schema public to products_app;
grant select, insert, update, delete on all tables in schema public to products_app;
alter default privileges in schema public grant select, insert, update, delete on tables to products_app;
alter default privileges in schema public grant usage, select on sequences to products_app;
