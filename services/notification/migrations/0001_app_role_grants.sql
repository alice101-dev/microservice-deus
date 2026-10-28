grant usage on schema public to notification_app;
grant select, insert, update, delete on all tables in schema public to notification_app;
alter default privileges in schema public grant select, insert, update, delete on tables to notification_app;
alter default privileges in schema public grant usage, select on sequences to notification_app;
