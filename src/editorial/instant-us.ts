export type InstantUs = string & { readonly __instantUs: unique symbol };

const INSTANT_US = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/;

export function instantUsFromDate(date: Date): InstantUs {
  if (!Number.isFinite(date.getTime())) throw new RangeError("Invalid instant");
  const iso = date.toISOString();
  if (!/^\d{4}-/.test(iso) || iso.startsWith("0000-"))
    throw new RangeError("Instant outside supported year range");
  return `${iso.slice(0, -1)}000Z` as InstantUs;
}

export function parseInstantUs(value: string): InstantUs {
  if (!INSTANT_US.test(value))
    throw new RangeError("Invalid microsecond instant format");
  if (value.startsWith("0000-"))
    throw new RangeError("Instant outside supported year range");
  const milliseconds = `${value.slice(0, -4)}Z`;
  const date = new Date(milliseconds);
  if (!Number.isFinite(date.getTime()) || date.toISOString() !== milliseconds) {
    throw new RangeError("Invalid microsecond instant");
  }
  return value as InstantUs;
}
