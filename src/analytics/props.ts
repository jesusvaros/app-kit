// Event names and props as the database accepts them (track_events in
// Lanuki's migration 20261114180000_events.sql): the same name regex as the
// table's check, and props kept well under `pg_column_size(props) < 2048`.

export type AnalyticsValue = string | number | boolean | null;
export type AnalyticsProps = Record<string, AnalyticsValue>;

/** Same pattern as the `name` check in the events table and in track_events. */
export const EVENT_NAME = /^[a-z][a-z0-9_]{0,59}$/;

export const isValidEventName = (name: unknown): name is string => typeof name === 'string' && EVENT_NAME.test(name);

/** Text size of the props, in UTF-8 bytes. jsonb is a bit larger, hence the margin in the default limit. */
export const propsBytes = (props: AnalyticsProps) => new TextEncoder().encode(JSON.stringify(props)).length;

const MAX_KEY = 60;
const MAX_STRING = 300;

/**
 * Only flat primitives survive: strings are cut to 300 characters, keys to 60,
 * NaN/Infinity become null, objects/arrays/functions/undefined are dropped.
 * Then, while the JSON is over `maxBytes`, the longest string is halved and,
 * once strings are short, the last keys are dropped.
 */
export const trimProps = (input: unknown, maxBytes: number): AnalyticsProps => {
  const out: AnalyticsProps = {};
  if (!input || typeof input !== 'object' || Array.isArray(input)) return out;
  for (const [rawKey, value] of Object.entries(input as Record<string, unknown>)) {
    const key = rawKey.slice(0, MAX_KEY);
    if (!key) continue;
    if (typeof value === 'string') out[key] = value.slice(0, MAX_STRING);
    else if (typeof value === 'number') out[key] = Number.isFinite(value) ? value : null;
    else if (typeof value === 'boolean' || value === null) out[key] = value;
  }
  while (Object.keys(out).length && propsBytes(out) > maxBytes) {
    let longest: string | null = null;
    for (const [key, value] of Object.entries(out)) {
      if (typeof value === 'string' && value.length > 20 && (longest === null || value.length > (out[longest] as string).length)) longest = key;
    }
    if (longest !== null) {
      const value = out[longest] as string;
      out[longest] = value.slice(0, Math.floor(value.length / 2));
    } else {
      const keys = Object.keys(out);
      delete out[keys[keys.length - 1]!];
    }
  }
  return out;
};
