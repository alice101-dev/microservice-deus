grant usage on schema public to reporting_app;
grant select, insert, update, delete on all tables in schema public to reporting_app;
alter default privileges in schema public grant select, insert, update, delete on tables to reporting_app;
alter default privileges in schema public grant usage, select on sequences to reporting_app;
