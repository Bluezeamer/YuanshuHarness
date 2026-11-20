export type ClassValue = string | false | null | undefined;

export const cx = (...parts: ClassValue[]): string =>
  parts.filter(Boolean).join(" ");
