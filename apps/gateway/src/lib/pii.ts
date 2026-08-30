export function maskEmail(value: string | null | undefined): string | null {
  if (!value) return null;
  const at = value.indexOf('@');
  if (at < 1) return '***';
  const local = value.slice(0, at);
  return `${local.slice(0, 1)}${'*'.repeat(Math.max(3, Math.min(local.length - 1, 8)))}${value.slice(at)}`;
}

export function maskPhone(value: string | null | undefined): string | null {
  if (!value) return null;
  const digits = value.replace(/\D/g, '');
  const tail = digits.slice(-2);
  return `${value.startsWith('+') ? '+' : ''}${'*'.repeat(Math.max(4, digits.length - 2))}${tail}`;
}
