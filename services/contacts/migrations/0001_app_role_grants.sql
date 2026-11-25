grant usage on schema public to contacts_app;
grant select, insert, update, delete on all tables in schema public to contacts_app;
alter default privileges in schema public grant select, insert, update, delete on tables to contacts_app;
alter default privileges in schema public grant usage, select on sequences to contacts_app;
