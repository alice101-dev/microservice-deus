grant usage on schema public to banking_app;
grant select, insert, update, delete on all tables in schema public to banking_app;
alter default privileges in schema public grant select, insert, update, delete on tables to banking_app;
alter default privileges in schema public grant usage, select on sequences to banking_app;
