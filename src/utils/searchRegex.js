const SPECIAL_CHARS = /[.*+?^${}()|[\]\\]/g;

export const escapeRegex = (value = '') => String(value).replace(SPECIAL_CHARS, '\\$&');

export const buildSearchRegex = (value, options = 'i') => {
  const trimmed = String(value || '').trim();
  if (!trimmed) return null;
  return new RegExp(escapeRegex(trimmed), options);
};
