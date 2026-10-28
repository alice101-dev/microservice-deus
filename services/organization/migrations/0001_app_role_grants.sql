grant usage on schema public to organization_app;
grant select, insert, update, delete on all tables in schema public to organization_app;
alter default privileges in schema public grant select, insert, update, delete on tables to organization_app;
alter default privileges in schema public grant usage, select on sequences to organization_app;
