#!/usr/bin/env python3
# Helper root do Orion (orion-root.service, disparado por orion-root.path). Ver server/claude/rootTool.ts.
# Roda da cópia root /usr/local/lib/orion/root-run.py (instalada por build.sh), nunca de uma pasta do
# danilo, e só usa stdlib + docker/psql: nada que uma sessão consiga editar roda como root aqui.
# Para cada /srv/root/pedidos/*.json: consome UMA aprovação humana ('allow'/'allow_always', decided_by
# não nulo, < 30 min, used_at nulo) desta sessão para este comando exato. Sem ela, ainda passa se a
# sessão tem root liberado (um 'allow_always' humano de root < 8 h) e o comando não bate em
# root-perigo.json (cópia root ao lado deste script; sem o arquivo, tudo conta como perigoso).
import glob, json, os, re, subprocess, sys
from urllib.parse import urlparse

BASE = os.environ.get('ORION_ROOT_BASE', '/srv/root')
UUID = re.compile(r'[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}')

SQL = """UPDATE claude_approvals SET used_at = now() WHERE id = (
  SELECT id FROM claude_approvals
  WHERE session_id = :'sid' AND tool_name = 'mcp__orion-root__exec' AND input->>'command' = :'cmd'
    AND decision IN ('allow', 'allow_always') AND decided_by IS NOT NULL AND used_at IS NULL
    AND decided_at > now() - interval '30 minutes'
  ORDER BY decided_at DESC LIMIT 1 FOR UPDATE SKIP LOCKED
) RETURNING id;
"""


LIBERADO = """SELECT 1 FROM claude_approvals
  WHERE session_id = :'sid' AND tool_name = 'mcp__orion-root__exec' AND decision = 'allow_always'
    AND decided_by IS NOT NULL AND decided_at > now() - interval '8 hours'
  LIMIT 1;
"""


def perigoso(cmd, arq=os.path.join(os.path.dirname(os.path.abspath(__file__)), 'root-perigo.json')):
    try:
        with open(arq) as f:
            padroes = json.load(f)['padroes']
    except Exception:
        return 'lista de perigo ilegível'
    for re_, motivo in padroes:
        if re.search(re_, cmd, re.I):
            return motivo
    return None


def psql_base():
    env = {}
    for linha in open('/etc/orion/central.env'):
        if '=' in linha and not linha.lstrip().startswith('#'):
            k, v = linha.strip().split('=', 1)
            env[k] = v.strip('"\'')
    u = urlparse(env['DATABASE_URL'])
    return ['docker', 'exec', '-i', 'orion-postgres', 'psql', '-U', u.username, '-d', u.path.lstrip('/'), '-qAt', '-v', 'ON_ERROR_STOP=1']


def consulta(base, sql, **vars_):
    r = subprocess.run(base + [a for k, v in vars_.items() for a in ('-v', f'{k}={v}')], input=sql, capture_output=True, text=True, timeout=30)
    if r.returncode != 0:
        print('psql falhou:', r.stderr.strip(), file=sys.stderr)
        return ''
    return r.stdout


def aprovado(base, sid, cmd):
    if UUID.search(consulta(base, SQL, sid=sid, cmd=cmd)):
        return True
    return perigoso(cmd) is None and consulta(base, LIBERADO, sid=sid).strip() == '1'


def executar(cmd):
    try:
        r = subprocess.run(['bash', '-c', cmd], capture_output=True, text=True, errors='replace', timeout=600, stdin=subprocess.DEVNULL, cwd='/root')
        return r.returncode, r.stdout + r.stderr
    except subprocess.TimeoutExpired:
        return 124, 'cortado: passou de 10 minutos'


def responder(id_, code, out, dono):
    # O danilo escreve em respostas/: nunca seguir link. O_EXCL|O_NOFOLLOW no tmp, e rename troca o
    # nome (inclusive um link plantado) sem abrir o alvo.
    resp = f'{BASE}/respostas/{id_}.json'
    tmp = f'{BASE}/respostas/.{id_}.tmp'
    try:
        os.unlink(tmp)
    except FileNotFoundError:
        pass
    fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o640)
    with os.fdopen(fd, 'w') as f:
        json.dump({'code': code, 'out': out[-20000:]}, f, ensure_ascii=False)
        os.fchown(f.fileno(), dono.st_uid, dono.st_gid)
    os.rename(tmp, resp)


def main():
    dono = os.stat(f'{BASE}/pedidos')
    base = None
    for arq in sorted(glob.glob(f'{BASE}/pedidos/*.json')):
        try:
            with open(arq, 'rb') as f:
                p = json.loads(f.read(200_000))
        except Exception:
            p = {}
        os.unlink(arq)
        id_, sid, cmd = str(p.get('id', '')), str(p.get('session_id', '')), p.get('command')
        if not UUID.fullmatch(id_) or not isinstance(cmd, str) or not cmd:
            continue
        base = base or psql_base()
        if aprovado(base, sid, cmd):
            print(f'root exec sessão {sid}: {cmd[:200]!r}')
            code, out = executar(cmd)
        else:
            print(f'recusado sessão {sid}: {cmd[:200]!r}')
            code, out = 126, 'Recusado: não há aprovação humana válida no chat (Aprovar, menos de 30 min, uso único) para este comando exato.'
        responder(id_, code, out, dono)


if __name__ == '__main__':
    main()
