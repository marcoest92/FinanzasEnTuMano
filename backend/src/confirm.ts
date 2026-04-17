const YES = /^(sí|si|sí\.|si\.|ok|okay|confirmo|dale|listo|correcto|afirmativo)$/i;
const NO = /^(no|nop|no\.|negativo)$/i;
const CANCEL = /^(cancelar|cancela|cancel)$/i;

export function isConfirmYes(text: string): boolean {
  const t = text.trim();
  return YES.test(t);
}

export function isConfirmNo(text: string): boolean {
  const t = text.trim();
  return NO.test(t);
}

export function isCancel(text: string): boolean {
  const t = text.trim();
  return CANCEL.test(t);
}

export function isNoOrCancel(text: string): boolean {
  return isConfirmNo(text) || isCancel(text);
}
