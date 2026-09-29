import { describe, it, expect } from 'vitest';
import { RESUME_PROMPT, shouldResume } from '../server/routes/claude';

describe('retomada pós-restart', () => {
  const now = new Date('2026-09-29T04:00:00Z');
  it('retoma turno normal cortado', () => expect(shouldResume('[Danilo] faz tudo', new Date(now.getTime() - 60_000), now)).toBe(true));
  it('não retoma de novo uma retomada recente (loop de restart)', () => expect(shouldResume(`[Orion] ${RESUME_PROMPT}`, new Date(now.getTime() - 60_000), now)).toBe(false));
  it('retomada antiga pode retomar outra vez', () => expect(shouldResume(`[Orion] ${RESUME_PROMPT}`, new Date(now.getTime() - 11 * 60_000), now)).toBe(true));
});
