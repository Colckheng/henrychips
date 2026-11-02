import { FolderOpen } from 'lucide-react';
import type { FieldDefinition } from '../../contracts/tool.js';
import type { FormValues, PropertySchema } from '../form.js';

export function FormField({ field, schema, required, value, error, onChange }: {
  field: FieldDefinition; schema?: PropertySchema; required: boolean;
  value: FormValues[string]; error?: string; onChange: (value: FormValues[string]) => void;
}) {
  const id = `field-${field.name}`;
  const hintId = `${id}-hint`;
  const errorId = `${id}-error`;
  const hint = field.description ?? (field.type === 'relative-path' ? '相对于工作区的路径，例如 samples/sales.csv。' : undefined);
  const common = {
    id, name: field.name, required: required && field.type !== 'checkbox', 'aria-invalid': error ? true : undefined,
    'aria-describedby': [hint ? hintId : '', error ? errorId : ''].filter(Boolean).join(' ') || undefined,
  };
  const label = <label htmlFor={id}>{field.label}<span className={required ? 'field-required' : 'field-optional'}>{required ? '必填' : '选填'}</span></label>;
  let control;
  if (field.type === 'checkbox') {
    control = <div className="checkbox-field"><input {...common} type="checkbox" checked={value === true} onChange={event => onChange(event.target.checked)} />{label}</div>;
  } else if (field.type === 'textarea') {
    control = <>{label}<textarea {...common} rows={8} value={String(value ?? '')} placeholder={field.placeholder ?? '在这里输入内容…'} minLength={schema?.minLength} maxLength={schema?.maxLength} onChange={event => onChange(event.target.value)} /></>;
  } else if (field.type === 'select') {
    const options = field.options ?? schema?.enum?.map(option => ({ label: String(option), value: String(option) })) ?? [];
    control = <>{label}<select {...common} value={String(value ?? '')} onChange={event => onChange(event.target.value)}>
      <option value="">请选择{required ? '' : '（可留空）'}</option>{options.map(option => <option key={option.value} value={option.value}>{option.label}</option>)}
    </select></>;
  } else {
    control = <>{label}<div className={field.type === 'relative-path' ? 'path-input' : ''}>
      {field.type === 'relative-path' && <FolderOpen size={16} aria-hidden="true" />}
      <input {...common} type={field.type === 'number' ? 'number' : 'text'} value={String(value ?? '')} placeholder={field.placeholder}
        min={schema?.minimum} max={schema?.maximum} step={schema?.type === 'integer' ? 1 : 'any'} minLength={schema?.minLength} maxLength={schema?.maxLength}
        spellCheck={field.type === 'relative-path' ? false : undefined} onChange={event => onChange(event.target.value)} />
    </div></>;
  }
  return <div className={`form-field ${field.type === 'textarea' ? 'field-wide' : ''}`}>{control}
    {hint && <p className="field-hint" id={hintId}>{hint}</p>}{error && <p className="field-error" id={errorId}>{error}</p>}
  </div>;
}
