/**
 * A short list of good values, plus "Custom…" one click away: picking it (or
 * a stored value that is not on the list) shows a typed number field next to
 * the list. Simple first, any value possible.
 */
import { useState } from "react";
import NumberField from "./NumberField";

export interface PresetOrCustomProps {
  value: number;
  presets: { value: number; label: string }[];
  onChange: (v: number) => void;
  /** The typed field's range and step, in field units (value / scale). */
  min: number;
  max: number;
  step: number;
  /** Field units per value: 1000 shows milliseconds as seconds. */
  scale?: number;
  digits?: number;
  unit?: string;
  disabled?: boolean;
  /** Fill the row (the list grows, the field keeps its size). */
  wide?: boolean;
  className?: string;
  fieldClassName?: string;
  "aria-label"?: string;
  testid?: string;
}

export const CUSTOM = "custom";

/** The list's selected entry: a preset's value, or "custom". */
export function presetPick(value: number, presets: { value: number }[], custom: boolean): string {
  return !custom && presets.some((p) => p.value === value) ? String(value) : CUSTOM;
}

export default function PresetOrCustom({
  value,
  presets,
  onChange,
  min,
  max,
  step,
  scale = 1,
  digits = 0,
  unit,
  disabled,
  wide,
  className,
  fieldClassName,
  testid,
  ...rest
}: PresetOrCustomProps) {
  const [custom, setCustom] = useState(false);
  const pick = presetPick(value, presets, custom);
  const label = rest["aria-label"];
  return (
    <span className={wide ? "flex w-full min-w-0 items-center gap-1.5" : "inline-flex min-w-0 items-center gap-1.5"}>
      <select
        value={pick}
        disabled={disabled}
        aria-label={label}
        data-testid={testid}
        onChange={(e) => {
          if (e.target.value === CUSTOM) return setCustom(true);
          setCustom(false);
          onChange(Number(e.target.value));
        }}
        className={className}
      >
        {presets.map((p) => (
          <option key={p.value} value={p.value}>
            {p.label}
          </option>
        ))}
        <option value={CUSTOM}>Custom…</option>
      </select>
      {pick === CUSTOM && (
        <span className="inline-flex shrink-0 items-center gap-1">
          <NumberField
            value={value / scale}
            min={min}
            max={max}
            step={step}
            digits={digits}
            disabled={disabled}
            onChange={(v) => onChange(Math.round(v * scale))}
            aria-label={label ? `${label}, custom value` : undefined}
            testid={testid ? `${testid}-custom` : undefined}
            className={fieldClassName}
          />
          {unit && <span className="text-ink-3">{unit}</span>}
        </span>
      )}
    </span>
  );
}
