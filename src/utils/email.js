// normalizeEmail options used for EVERY email field (register/login/reset/invite/
// customer). By default validator.js strips gmail dots and +subaddress, which rewrites
// the address the user typed (support.billji@ -> supportbillji@) and then breaks email
// delivery to that exact inbox. We keep the address as entered (only trimmed +
// lowercased by normalizeEmail's defaults). These options MUST be identical everywhere
// or a login won't match the email stored at registration.
export const EMAIL_NORMALIZE = { gmail_remove_dots: false, gmail_remove_subaddress: false };
