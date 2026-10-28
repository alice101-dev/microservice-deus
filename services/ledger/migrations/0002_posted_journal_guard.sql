create function ledger_guard_journal() returns trigger language plpgsql as $$
begin
  if old.status = 'posted' then
    raise exception 'journal % is posted and cannot be changed', old.id using errcode = 'P0001';
  end if;
  return case when tg_op = 'DELETE' then old else new end;
end;
$$;

create function ledger_guard_line() returns trigger language plpgsql as $$
declare
  target uuid := case when tg_op = 'DELETE' then old.journal_id else new.journal_id end;
begin
  if exists (select 1 from journals where id = target and status = 'posted') then
    raise exception 'journal % is posted and its lines cannot be changed', target using errcode = 'P0001';
  end if;
  if tg_op = 'UPDATE' and old.journal_id <> new.journal_id
    and exists (select 1 from journals where id = old.journal_id and status = 'posted') then
    raise exception 'journal % is posted and its lines cannot be changed', old.journal_id using errcode = 'P0001';
  end if;
  return case when tg_op = 'DELETE' then old else new end;
end;
$$;

create trigger journals_posted_guard before update or delete on journals
  for each row execute function ledger_guard_journal();

create trigger journal_lines_posted_guard before insert or update or delete on journal_lines
  for each row execute function ledger_guard_line();
