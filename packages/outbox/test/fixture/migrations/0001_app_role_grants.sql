grant usage on schema public to outbox_app;
grant select, insert, update, delete on all tables in schema public to outbox_app;
alter default privileges in schema public grant select, insert, update, delete on tables to outbox_app;
alter default privileges in schema public grant usage, select on sequences to outbox_app;
