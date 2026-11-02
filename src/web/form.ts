import type { ToolDescription } from '../contracts/tool.js';

export type FormValues = Record<string, string | number | boolean>;
export type PropertySchema = {
  type?: string; default?: unknown; minimum?: number; maximum?: number;
  minLength?: number; maxLength?: number; enum?: unknown[];
};

export function propertiesOf(tool: ToolDescription): Record<string, PropertySchema> {
  const properties = tool.inputSchema.properties;
  return properties && typeof properties === 'object' && !Array.isArray(properties)
    ? properties as Record<string, PropertySchema> : {};
}

export function requiredFields(tool: ToolDescription): string[] {
  return Array.isArray(tool.inputSchema.required)
    ? tool.inputSchema.required.filter((value): value is string => typeof value === 'string') : [];
}

export function initialValues(tool: ToolDescription, example?: Record<string, unknown>): FormValues {
  const properties = propertiesOf(tool);
  return Object.fromEntries(tool.fields.map(field => {
    const value = example?.[field.name] ?? properties[field.name]?.default;
    const scalar = typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean';
    return [field.name, scalar ? value : field.type === 'checkbox' ? false : ''];
  }));
}

export function serializeInput(tool: ToolDescription, values: FormValues): Record<string, unknown> {
  const required = new Set(requiredFields(tool));
  const input: Record<string, unknown> = {};
  for (const field of tool.fields) {
    const value = values[field.name];
    const blank = value === undefined || (typeof value === 'string' && !value.trim());
    if (blank && !required.has(field.name)) continue;
    input[field.name] = field.type === 'number' && !blank ? Number(value) : value ?? '';
  }
  return input;
}
