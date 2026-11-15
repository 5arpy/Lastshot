import { useEffect, useState } from "react";
import { lastshot } from "../lib/bridge";
import type { AppAudio } from "../lib/types";

/** Short text for an AppAudio choice ("Everything", "Only Roblox"...). */
export function appAudioLabel(v: AppAudio | undefined): string {
  if (!v || v.kind === "all") return "Everything";
  const name = v.exe.replace(/\.exe$/i, "");
  return v.kind === "only" ? `Only ${name}` : `Everything except ${name}`;
}

/**
 * Whose sound "PC sound" records: everything, only one app (the game), or
 * everything except one app (a voice chat). `windowExe` is the app being
 * recorded, offered first for "Only".
 */
export default function AppAudioPicker({
  value,
  onChange,
  disabled,
  windowExe,
  className,
}: {
  value: AppAudio | undefined;
  onChange: (v: AppAudio) => void;
  disabled?: boolean;
  windowExe?: string;
  className?: string;
}) {
  const cur: AppAudio = value ?? { kind: "all" };
  const [apps, setApps] = useState<string[]>([]);

  const refresh = () =>
    lastshot
      .listWindows()
      .then((ws) => {
        const seen = new Map<string, string>();
        for (const w of ws) if (w.exe && !seen.has(w.exe.toLowerCase())) seen.set(w.exe.toLowerCase(), w.exe);
        setApps([...seen.values()].sort((a, b) => a.localeCompare(b, undefined, { sensitivity: "base" })));
      })
      .catch(() => setApps([]));

  useEffect(() => {
    if (cur.kind !== "all") void refresh();
    // Only when the mode changes; the list is refreshed on focus too.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cur.kind]);

  const exe = cur.kind === "all" ? "" : cur.exe;
  const options = exe && !apps.some((a) => a.toLowerCase() === exe.toLowerCase()) ? [exe, ...apps] : apps;

  const pickMode = (kind: AppAudio["kind"]) => {
    if (kind === "all") return onChange({ kind: "all" });
    const guess =
      exe ||
      (kind === "only" ? windowExe : apps.find((a) => /discord/i.test(a))) ||
      windowExe ||
      apps[0] ||
      "";
    onChange({ kind, exe: guess });
    if (!apps.length) void refresh();
  };

  const sel = "rounded-md border border-line bg-surface-2 px-2 py-1 text-ink disabled:opacity-50";
  return (
    <div className={className ?? "flex flex-wrap items-center gap-1.5"}>
      <select
        aria-label="Whose sound"
        value={cur.kind}
        disabled={disabled}
        onChange={(e) => pickMode(e.target.value as AppAudio["kind"])}
        className={sel}
      >
        <option value="all">Everything</option>
        <option value="only">Only one app</option>
        <option value="except">Everything except one app</option>
      </select>
      {cur.kind !== "all" && (
        <select
          aria-label="App"
          value={exe}
          disabled={disabled}
          onFocus={() => void refresh()}
          onChange={(e) => onChange({ kind: cur.kind, exe: e.target.value })}
          className={`${sel} min-w-0 max-w-[14rem] flex-1`}
        >
          {!exe && <option value="">Pick an app…</option>}
          {options.map((a) => (
            <option key={a} value={a}>
              {a.replace(/\.exe$/i, "")}
            </option>
          ))}
        </select>
      )}
    </div>
  );
}
