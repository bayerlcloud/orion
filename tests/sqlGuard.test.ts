import { describe, it, expect } from 'vitest';
import { sqlDestrutivo, tabelaAlvo } from '../server/claude/sqlGuard';

describe('sqlDestrutivo', () => {
  it('pega destrutivo', () => {
    for (const s of ['DROP TABLE pacientes', 'drop table if exists x', 'TRUNCATE agenda', 'alter table p drop column nome',
      'ALTER TABLE p RENAME COLUMN a TO b', 'alter table p rename to q', 'DELETE FROM p', 'delete from p;',
      'UPDATE p SET ativo = false', 'select 1; drop table x', 'DROP SCHEMA s CASCADE', 'drop function f'])
      expect(sqlDestrutivo(s), s).not.toBeNull();
  });
  it('deixa passar o comum', () => {
    for (const s of ['select * from p', "insert into log values ('drop table x')", '-- drop table x\nselect 1',
      '/* truncate */ select 1', 'delete from p where id = 3', 'DELETE FROM p\n  WHERE criado < now()',
      'update p set a = 1 where id = 2', 'create table t (id int)', 'alter table p add column x int', 'create or replace function f() returns int as $$ select 1 $$ language sql'])
      expect(sqlDestrutivo(s), s).toBeNull();
  });
  it('tabelaAlvo', () => {
    expect(tabelaAlvo('drop table public.pacientes')).toBe('public.pacientes');
    expect(tabelaAlvo('select 1; delete from agenda')).toBe('agenda');
    expect(tabelaAlvo('drop schema s')).toBeNull();
  });
});
