// Email format accepted at sign-up.
export const EMAIL_PATTERN = /^(?!.*\.\.)[^.\s@][^\s@]*@[^\s@.]+(\.[^\s@.]+)*\.[^\s@.]{2,}$/;

export const isValidEmail = (email) => EMAIL_PATTERN.test(String(email || '').trim());
