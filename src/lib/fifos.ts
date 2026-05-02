import { RESERVED_SLUGS } from "./constants.js";

/** Slugify a fifo name: lowercase, hyphenated, alnum + dot + dash. */
export function toSlug(name: string): string {
  return name
    .trim()
    .toLowerCase()
    .replace(/[\s_]+/g, "-")
    .replace(/[^a-z0-9.-]/g, "")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
}

export function isReservedSlug(slug: string): boolean {
  return RESERVED_SLUGS.has(slug);
}

/** Returns null if valid, or an error message. */
export function validateFifoName(name: string): string | null {
  if (!name || name.trim().length === 0) return "Name is required";
  if (name.length > 100) return "Name is too long";
  const slug = toSlug(name);
  if (!slug) return "Name must contain at least one letter or number";
  if (isReservedSlug(slug)) return `"${name}" is a reserved name`;
  return null;
}
