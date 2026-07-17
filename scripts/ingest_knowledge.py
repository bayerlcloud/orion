#!/usr/bin/env python3
"""
Ingere todo o conhecimento disponível no SQLite do Orion.

Fontes:
  1. Vault SilverBullet  → NOTES_DIR (default: /config/workspace/notes/)
  2. Memory files Claude → CLAUDE_MEM_DIR
  3. CLAUDE.md global   → CLAUDE_MD

Execução:
  python3 /config/workspace/orion/scripts/ingest_knowledge.py
  python3 /config/workspace/orion/scripts/ingest_knowledge.py --dry-run
"""

import sqlite3, os, re, sys, uuid
from pathlib import Path

WORKSPACE_DIR = Path(os.environ.get('WORKSPACE_DIR', '/config/workspace/orion'))
DB_PATH   = Path(os.environ.get('DB_PATH', str(WORKSPACE_DIR / 'data' / 'memory.db')))
DRY_RUN   = '--dry-run' in sys.argv

NOTES_DIR     = Path(os.environ.get('NOTES_DIR',     '/config/workspace/notes'))
CLAUDE_MEM_DIR = Path(os.environ.get('CLAUDE_MEM_DIR', '/config/.claude/projects/-config-workspace/memory'))
CLAUDE_MD     = Path(os.environ.get('CLAUDE_MD',     '/config/.claude/CLAUDE.md'))

SOURCES = [
    { 'path': NOTES_DIR,      'source': 'vault',      'type': 'semantic', 'confidence': 0.80 },
    { 'path': CLAUDE_MEM_DIR, 'source': 'claude_mem', 'type': 'semantic', 'confidence': 0.85 },
    { 'path': CLAUDE_MD,      'source': 'claude_md',  'type': 'semantic', 'confidence': 0.90 },
]

# ── helpers ─────────────────────────────────────────────────────────────────────────

def chunk_markdown(text: str, max_chars: int = 600) -> list[str]:
    """Divide um markdown em chunks por seção (##) ou por tamanho."""
    # Remover YAML frontmatter
    text = re.sub(r'^---\n.*?\n---\n', '', text, flags=re.DOTALL)

    chunks = []
    current = []
    current_len = 0

    for line in text.splitlines():
        # Nova seção = ponto de corte natural
        if re.match(r'^#{1,3} ', line) and current_len > 80:
            chunk = '\n'.join(current).strip()
            if len(chunk) > 30:
                chunks.append(chunk)
            current = []
            current_len = 0

        current.append(line)
        current_len += len(line)

        # Chunk muito grande → cortar na última linha vazia
        if current_len > max_chars:
            chunk = '\n'.join(current).strip()
            if len(chunk) > 30:
                chunks.append(chunk)
            current = []
            current_len = 0

    if current:
        chunk = '\n'.join(current).strip()
        if len(chunk) > 30:
            chunks.append(chunk)

    return chunks


def collect_files(source: dict) -> list[tuple[Path, str, float]]:
    """Retorna lista de (path, source_name, confidence) de arquivos markdown."""
    p = source['path']
    if p.is_file():
        return [(p, source['source'], source['confidence'])]
    if p.is_dir():
        files = []
        for md in p.rglob('*.md'):
            # Pular index sem conteúdo
            if md.stat().st_size < 20:
                continue
            files.append((md, source['source'], source['confidence']))
        return files
    return []


# ── main ─────────────────────────────────────────────────────────────────────────

def main():
    db = sqlite3.connect(DB_PATH)

    # Limpar memórias de ingestão anteriores (para re-ingerir atualizado)
    existing = db.execute("SELECT COUNT(*) FROM memories WHERE source IN ('vault','claude_mem','claude_md')").fetchone()[0]
    if existing > 0 and not DRY_RUN:
        db.execute("DELETE FROM memories WHERE source IN ('vault','claude_mem','claude_md')")
        db.execute("DELETE FROM memories_fts WHERE rowid NOT IN (SELECT rowid FROM memories)")
        db.commit()
        print(f'  limpou {existing} memórias antigas de ingestão')

    total_chunks = 0
    total_files  = 0

    for source in SOURCES:
        files = collect_files(source)
        for file_path, src_name, conf in files:
            try:
                text = file_path.read_text(encoding='utf-8', errors='ignore').strip()
                if not text or len(text) < 30:
                    continue

                rel = str(file_path)

                chunks = chunk_markdown(text)
                if not chunks:
                    continue

                for chunk in chunks:
                    content = f'[{rel}]\n{chunk}'

                    if not DRY_RUN:
                        mid = str(uuid.uuid4())
                        db.execute(
                            'INSERT INTO memories (id, type, content, source, confidence, metadata) VALUES (?,?,?,?,?,?)',
                            (mid, source['type'], content, src_name, conf, '{}')
                        )

                    total_chunks += 1

                total_files += 1
                print(f'  {src_name:12s} {len(chunks):3d} chunks  {rel}')

            except Exception as e:
                print(f'  ERRO {file_path}: {e}')

    if not DRY_RUN:
        db.commit()
        # Rebuild FTS
        db.execute("INSERT INTO memories_fts(memories_fts) VALUES('rebuild')")
        db.commit()

    db.close()

    mode = '[DRY RUN] ' if DRY_RUN else ''
    print(f'\n{mode}Ingestão concluída: {total_files} arquivos → {total_chunks} chunks no SQLite')


if __name__ == '__main__':
    main()
