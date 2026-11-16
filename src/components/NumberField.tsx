/**
 * A number the user can type freely. While the field has focus it keeps its
 * own draft (no clamping, no re-sync from the outside on every key); Enter or
 * leaving the field commits it, clamped. Escape puts the value back. The
 * arrow keys and the mouse wheel (while focused) step at once; Shift steps
 * ten times as far.
 */
import { useEffect, useRef, useState } from "react";
import { parseNum, showNum, stepNum } from "../lib/numdraft";

export interface NumberFieldProps {
  value: number;
  min: number;
  max: number;
  step: number;
  onChange: (v: number) => void;
  disabled?: boolean;
  /** Decimals shown. */
  digits?: number;
  className?: string;
  "aria-label"?: string;
  title?: string;
  testid?: string;
}

export default function NumberField({ value, min, max, step, onChange, disabled, digits = 2, className, title, testid, ...rest }: NumberFieldProps) {
  const [draft, setDraftState] = useState(showNum(value, digits));
  const draftRef = useRef(draft);
  const setDraft = (s: string) => {
    draftRef.current = s;
    setDraftState(s);
  };
  const editing = useRef(false);
  const latest = useRef({ value, onChange, min, max, step, digits, disabled });
  latest.current = { value, onChange, min, max, step, digits, disabled };

  // The outside value shows, except while the user is typing.
  useEffect(() => {
    if (!editing.current) setDraft(showNum(value, digits));
  }, [value, digits]);

  const commit = () => {
    const { value: v0, onChange: f, min: lo, max: hi, digits: d } = latest.current;
    const v = parseNum(draftRef.current, lo, hi);
    setDraft(showNum(v ?? v0, d));
    if (v !== null && v !== v0) f(v);
  };
  const nudge = (dir: 1 | -1, big: boolean) => {
    const { value: v0, onChange: f, min: lo, max: hi, step: st, digits: d } = latest.current;
    const base = parseNum(draftRef.current, lo, hi) ?? v0;
    const v = stepNum(base, big ? st * 10 : st, dir, lo, hi);
    setDraft(showNum(v, d));
    if (v !== v0) f(v);
  };
  const nudgeRef = useRef(nudge);
  nudgeRef.current = nudge;

  // The wheel steps while the field has focus (a non-passive listener, so the
  // page does not scroll instead).
  const input = useRef<HTMLInputElement | null>(null);
  useEffect(() => {
    const el = input.current;
    if (!el) return;
    const wheel = (e: WheelEvent) => {
      if (document.activeElement !== el || latest.current.disabled || !e.deltaY) return;
      e.preventDefault();
      nudgeRef.current(e.deltaY < 0 ? 1 : -1, e.shiftKey);
    };
    el.addEventListener("wheel", wheel, { passive: false });
    return () => el.removeEventListener("wheel", wheel);
  }, []);

  return (
    <input
      ref={input}
      type="text"
      inputMode="decimal"
      role="spinbutton"
      aria-valuemin={min}
      aria-valuemax={max}
      aria-valuenow={value}
      aria-label={rest["aria-label"]}
      title={title}
      data-testid={testid}
      value={draft}
      disabled={disabled}
      spellCheck={false}
      autoComplete="off"
      onFocus={() => (editing.current = true)}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={() => {
        editing.current = false;
        commit();
      }}
      onKeyDown={(e) => {
        if (e.key === "Enter") {
          e.preventDefault();
          commit();
        } else if (e.key === "Escape") {
          e.preventDefault();
          e.stopPropagation();
          setDraft(showNum(latest.current.value, latest.current.digits));
        } else if (e.key === "ArrowUp" || e.key === "ArrowDown") {
          e.preventDefault();
          nudge(e.key === "ArrowUp" ? 1 : -1, e.shiftKey);
        }
      }}
      className={className}
    />
  );
}
