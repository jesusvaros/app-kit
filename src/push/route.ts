// Where a tapped notification may take the user: only internal paths that
// start with one of the allowed prefixes. Anything else (full URLs, `//host`,
// `javascript:`, paths with `..`) is ignored.

export const routeFromData = (
  data: Record<string, unknown> | null | undefined,
  allowedPrefixes: readonly string[],
  key = 'route',
): string | null => {
  const value = data?.[key];
  if (typeof value !== 'string') return null;
  const route = value.trim();
  if (!route.startsWith('/') || route.startsWith('//') || route.includes('\\')) return null;
  if (/[\u0000-\u001f]/.test(route)) return null;
  const path = route.split(/[?#]/, 1)[0] ?? '';
  if (path.split('/').some(part => part === '..' || part === '.')) return null;
  return allowedPrefixes.some(prefix => path.startsWith(prefix)) ? route : null;
};
