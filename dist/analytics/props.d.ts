export type AnalyticsValue = string | number | boolean | null;
export type AnalyticsProps = Record<string, AnalyticsValue>;
/** Same pattern as the `name` check in the events table and in track_events. */
export declare const EVENT_NAME: RegExp;
export declare const isValidEventName: (name: unknown) => name is string;
/** Text size of the props, in UTF-8 bytes. jsonb is a bit larger, hence the margin in the default limit. */
export declare const propsBytes: (props: AnalyticsProps) => number;
/**
 * Only flat primitives survive: strings are cut to 300 characters, keys to 60,
 * NaN/Infinity become null, objects/arrays/functions/undefined are dropped.
 * Then, while the JSON is over `maxBytes`, the longest string is halved and,
 * once strings are short, the last keys are dropped.
 */
export declare const trimProps: (input: unknown, maxBytes: number) => AnalyticsProps;
