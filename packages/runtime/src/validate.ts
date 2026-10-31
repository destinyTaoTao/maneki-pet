/**
 * 手写请求校验（CSP 安全先例，architecture §6.1）：限制未知字段、
 * 长度、枚举与数值范围；所有入口共享，不只在 UI 禁用。
 */
export type FieldSpec =
  | { type: "string"; required: true; maxLength: number; enumValues?: readonly string[] }
  | { type: "string"; required: false; maxLength: number; enumValues?: readonly string[]; default?: string }
  | { type: "number"; required: true; min?: number; max?: number }
  | { type: "number"; required: false; min?: number; max?: number; default?: number }
  | { type: "boolean"; required: true }
  | { type: "boolean"; required: false; default?: boolean };

export type ObjectSpec = Record<string, FieldSpec>;

export type ValidateResult<T> = { ok: true; value: T } | { ok: false; reason: string };

export function validateObject<T extends Record<string, unknown>>(
  body: unknown,
  spec: ObjectSpec,
): ValidateResult<T> {
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    return { ok: false, reason: "request body must be a JSON object" };
  }
  const input = body as Record<string, unknown>;
  const result: Record<string, unknown> = {};
  for (const key of Object.keys(input)) {
    if (!(key in spec)) {
      return { ok: false, reason: `unknown field "${key}"` };
    }
  }
  for (const [key, fieldSpec] of Object.entries(spec)) {
    const present = key in input;
    if (!present) {
      if (fieldSpec.required) {
        return { ok: false, reason: `missing required field "${key}"` };
      }
      if (!fieldSpec.required && "default" in fieldSpec && fieldSpec.default !== undefined) {
        result[key] = (fieldSpec as { default: unknown }).default;
      }
      continue;
    }
    const value = input[key];
    const checked = checkField(key, value, fieldSpec);
    if (!checked.ok) {
      return checked;
    }
    result[key] = value;
  }
  return { ok: true, value: result as T };
}

function checkField(key: string, value: unknown, spec: FieldSpec): ValidateResult<unknown> {
  if (spec.type === "string") {
    if (typeof value !== "string") {
      return { ok: false, reason: `field "${key}" must be a string` };
    }
    if (value.length > spec.maxLength) {
      return { ok: false, reason: `field "${key}" exceeds max length ${spec.maxLength}` };
    }
    if (spec.enumValues && !spec.enumValues.includes(value)) {
      return { ok: false, reason: `field "${key}" must be one of ${spec.enumValues.join("|")}` };
    }
    return { ok: true, value };
  }
  if (spec.type === "number") {
    if (typeof value !== "number" || !Number.isFinite(value)) {
      return { ok: false, reason: `field "${key}" must be a finite number` };
    }
    if (spec.min !== undefined && value < spec.min) {
      return { ok: false, reason: `field "${key}" must be >= ${spec.min}` };
    }
    if (spec.max !== undefined && value > spec.max) {
      return { ok: false, reason: `field "${key}" must be <= ${spec.max}` };
    }
    return { ok: true, value };
  }
  if (typeof value !== "boolean") {
    return { ok: false, reason: `field "${key}" must be a boolean` };
  }
  return { ok: true, value };
}
