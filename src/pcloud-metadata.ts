export type PublicPCloudSize = number | string;

type PCloudIdPrefix = "d" | "f";

const UNSIGNED_DECIMAL_PATTERN = /^(?:0|[1-9]\d*)$/;
export const PCLOUD_ID_MAX_DECIMAL_DIGITS = 128;

function exactUnsignedDecimal(value: unknown): string | undefined {
  return typeof value === "string" &&
    value.length <= PCLOUD_ID_MAX_DECIMAL_DIGITS &&
    UNSIGNED_DECIMAL_PATTERN.test(value)
    ? value
    : undefined;
}

export function optionalPCloudId(
  value: unknown,
  canonicalId: unknown,
  prefix: PCloudIdPrefix,
): string | undefined {
  const exactValue = exactUnsignedDecimal(value);
  if (exactValue !== undefined) {
    return exactValue;
  }

  if (
    typeof value === "number" &&
    Number.isSafeInteger(value) &&
    value >= 0
  ) {
    return String(value);
  }

  if (
    typeof canonicalId === "string" &&
    canonicalId.startsWith(prefix)
  ) {
    return exactUnsignedDecimal(canonicalId.slice(1));
  }

  return undefined;
}

export function optionalPCloudSize(
  value: unknown,
): PublicPCloudSize | undefined {
  const exactValue = exactUnsignedDecimal(value);
  if (exactValue !== undefined) {
    return exactValue;
  }

  return typeof value === "number" &&
    Number.isSafeInteger(value) &&
    value >= 0
    ? value
    : undefined;
}

export function safePCloudSizeNumber(value: unknown): number | undefined {
  if (
    typeof value === "number" &&
    Number.isSafeInteger(value) &&
    value >= 0
  ) {
    return value;
  }

  const exactValue = exactUnsignedDecimal(value);
  if (exactValue === undefined) {
    return undefined;
  }

  const parsed = Number(exactValue);
  return Number.isSafeInteger(parsed) ? parsed : undefined;
}
