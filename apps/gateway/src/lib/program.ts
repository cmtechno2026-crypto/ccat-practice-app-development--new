// Program dimension helper. CCAT and NGAT share the student pool and are distinguished
// by ccat.categories.program ('ccat' | 'ngat'). Math Olympiad adds a third program value
// ('math'); Math content also carries site_id='math' (D2). Every program-scoped query
// defaults to 'ccat', so mobile/older clients and all existing CCAT behaviour are unchanged.
export type Program = 'ccat' | 'ngat' | 'math';

export function parseProgram(q: unknown): Program {
  const p = (q as { program?: string } | undefined)?.program;
  return p === 'ngat' ? 'ngat' : p === 'math' ? 'math' : 'ccat';
}
