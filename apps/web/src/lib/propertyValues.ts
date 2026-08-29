import type { WebEditorProperty } from "../types";

export function initialPropertyValues(properties: WebEditorProperty[]): Record<string, string> {
  const values: Record<string, string> = {};
  for (const property of properties) {
    values[property.key] = property.value;
  }
  return values;
}

export function withPropertyValue(
  values: Record<string, string>,
  key: string,
  value: string,
): Record<string, string> {
  return { ...values, [key]: value };
}

export function propertiesWithValues(
  properties: WebEditorProperty[],
  values: Record<string, string>,
): WebEditorProperty[] {
  return properties.map((property) => ({
    ...property,
    value: values[property.key] ?? property.value,
  }));
}
