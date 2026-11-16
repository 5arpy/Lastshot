//! The Audio guard's plain logic (no Windows calls, all unit-tested):
//! settings, who changed what, what to do about it, snapshots and their
//! differences, the change log, preferred-device fallback, and auto-duck.

use serde::{Deserialize, Serialize};

/// 0 = playback (render), 1 = recording (capture).
pub type Flow = u8;
/// 0 = console, 1 = multimedia, 2 = communications.
pub type Role = u8;

pub fn flow_name(f: Flow) -> &'static str {
    if f == 0 {
        "playback"
    } else {
        "recording"
    }
}

pub fn role_name(r: Role) -> &'static str {
    match r {
        0 => "default",
        1 => "default (multimedia)",
        _ => "communications",
    }
}

/// A device as the user picked it: the id, plus the name to find it again
/// if Windows gives it a new id (some drivers do after an update).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct DevicePick {
    pub id: String,
    #[serde(default)]
    pub name: String,
}

/// What to do when something other than Lastshot changes a protected setting.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub enum Policy {
    /// A notification with "Restore mine" / "Keep new".
    #[default]
    Ask,
    /// Put it back at once.
    Restore,
    /// Keep Windows' change; only log it.
    Accept,
}

/// The preferred default device for one flow and role group, in order:
/// the first one that is connected wins ("Arctis, else Speakers").
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct PreferredDefault {
    pub flow: Flow,
    /// false: console + multimedia; true: communications.
    pub comm: bool,
    pub order: Vec<DevicePick>,
}

impl PreferredDefault {
    pub fn roles(&self) -> &'static [Role] {
        if self.comm {
            &[2]
        } else {
            &[0, 1]
        }
    }
}

/// Everything Lastshot keeps for one app, keyed by exe name (so an update
/// that moves the app's folder keeps it). The app's output lives in the
/// existing "Send to" rules (`Settings::app_outputs`); this holds the rest.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct AppPref {
    pub exe: String,
    #[serde(default)]
    pub input: Option<DevicePick>,
    /// 0..1, None = leave it.
    #[serde(default)]
    pub volume: Option<f32>,
    #[serde(default)]
    pub mute: Option<bool>,
    /// Overrides the global policy for this app.
    #[serde(default)]
    pub policy: Option<Policy>,
    /// Never lowered by auto-duck (e.g. the voice chat app).
    #[serde(default)]
    pub no_duck: bool,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DeviceRule {
    pub device_id: String,
    pub policy: Policy,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DuckSettings {
    pub enabled: bool,
    /// Mic level that counts as talking, dBFS.
    pub threshold_db: f32,
    /// How much to lower the other apps, dB (3-30).
    pub amount_db: f32,
    /// How long after the mic goes quiet the apps come back, ms.
    pub release_ms: u32,
}

impl Default for DuckSettings {
    fn default() -> Self {
        Self { enabled: false, threshold_db: -40.0, amount_db: 12.0, release_ms: 800 }
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GuardSettings {
    /// The guard watches and acts. Off by default: nothing is touched
    /// until the user turns it on.
    #[serde(default)]
    pub enabled: bool,
    #[serde(default)]
    pub policy: Policy,
    /// "Always restore mine": also show a small notification.
    #[serde(default)]
    pub notify_restores: bool,
    /// Mute an app while it plays on the wrong device.
    #[serde(default)]
    pub strict: bool,
    #[serde(default)]
    pub defaults: Vec<PreferredDefault>,
    #[serde(default)]
    pub apps: Vec<AppPref>,
    #[serde(default)]
    pub device_rules: Vec<DeviceRule>,
    #[serde(default)]
    pub duck: DuckSettings,
    /// Global shortcut that mutes the default microphone, e.g. "Ctrl+Alt+M".
    #[serde(default)]
    pub mic_mute_hotkey: String,
}

impl Default for GuardSettings {
    fn default() -> Self {
        Self {
            enabled: false,
            policy: Policy::Ask,
            notify_restores: false,
            strict: false,
            defaults: Vec::new(),
            apps: Vec::new(),
            device_rules: Vec::new(),
            duck: DuckSettings::default(),
            mic_mute_hotkey: String::new(),
        }
    }
}

impl GuardSettings {
    pub fn app(&self, exe: &str) -> Option<&AppPref> {
        self.apps.iter().find(|a| a.exe.eq_ignore_ascii_case(exe))
    }

    pub fn app_mut(&mut self, exe: &str) -> &mut AppPref {
        if let Some(i) = self.apps.iter().position(|a| a.exe.eq_ignore_ascii_case(exe)) {
            return &mut self.apps[i];
        }
        self.apps.push(AppPref { exe: exe.to_string(), ..Default::default() });
        self.apps.sort_by_key(|a| a.exe.to_lowercase());
        let i = self.apps.iter().position(|a| a.exe.eq_ignore_ascii_case(exe)).unwrap_or(0);
        &mut self.apps[i]
    }

    /// Drops app entries that no longer hold anything.
    pub fn tidy(&mut self) {
        self.apps.retain(|a| a.input.is_some() || a.volume.is_some() || a.mute.is_some() || a.policy.is_some() || a.no_duck);
        self.defaults.retain(|d| !d.order.is_empty());
    }

    pub fn preferred(&self, flow: Flow, role: Role) -> Option<&PreferredDefault> {
        self.defaults.iter().find(|d| d.flow == flow && d.roles().contains(&role))
    }

    /// The policy for a change to `device_id` or to `exe`'s routing.
    pub fn policy_for(&self, exe: Option<&str>, device_id: Option<&str>) -> Policy {
        if let Some(p) = exe.and_then(|e| self.app(e)).and_then(|a| a.policy) {
            return p;
        }
        if let Some(r) = device_id.and_then(|d| self.device_rules.iter().find(|r| r.device_id == d)) {
            return r.policy;
        }
        self.policy
    }
}

/// The first preferred device that is connected now. Matches by id, then by
/// name (a driver update can give a device a new id).
pub fn pick_connected<'a>(order: &'a [DevicePick], active: &[(String, String)]) -> Option<(&'a DevicePick, String)> {
    for p in order {
        if active.iter().any(|(id, _)| *id == p.id) {
            return Some((p, p.id.clone()));
        }
        if !p.name.is_empty() {
            if let Some((id, _)) = active.iter().find(|(_, n)| n.eq_ignore_ascii_case(&p.name)) {
                return Some((p, id.clone()));
            }
        }
    }
    None
}

// ---------------------------------------------------------------------------
// Who changed it, and what to do
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum Cause {
    /// Windows, right after a device came, went or changed state.
    Windows,
    /// Someone changed it in Windows' settings or another app.
    User,
    /// Lastshot's own change from the Audio tab.
    Lastshot,
    /// Lastshot's guard putting the user's choice back.
    Guard,
    /// Restoring a snapshot.
    Restore,
}

/// A change this soon after a device event is Windows' doing.
pub const DEVICE_EVENT_WINDOW_MS: u64 = 3000;
/// A change this soon after Lastshot wrote the same setting is our own echo.
pub const OWN_WRITE_WINDOW_MS: u64 = 2000;

/// `since_device_event` / `since_own_write`: ms since the last device
/// event / since Lastshot last set this same setting (None = never).
pub fn classify(since_device_event: Option<u64>, since_own_write: Option<u64>) -> Cause {
    if since_own_write.is_some_and(|ms| ms <= OWN_WRITE_WINDOW_MS) {
        return Cause::Guard;
    }
    if since_device_event.is_some_and(|ms| ms <= DEVICE_EVENT_WINDOW_MS) {
        return Cause::Windows;
    }
    Cause::User
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum Decision {
    /// Our own change echoing back: nothing to do.
    Ignore,
    Restore,
    Ask,
    Accept,
}

/// What the guard does about a change. A Lastshot cable never stays a
/// default by Windows' doing: Windows makes every new USB audio device the
/// default, so that switch is always undone.
pub fn decide(cause: Cause, policy: Policy, new_is_cable: bool, user_picked_new: bool) -> Decision {
    match cause {
        Cause::Guard | Cause::Lastshot | Cause::Restore => Decision::Ignore,
        _ if new_is_cable && !user_picked_new && cause == Cause::Windows => Decision::Restore,
        _ => match policy {
            Policy::Ask => Decision::Ask,
            Policy::Restore => Decision::Restore,
            Policy::Accept => Decision::Accept,
        },
    }
}

// ---------------------------------------------------------------------------
// Snapshots
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SnapDefault {
    pub flow: Flow,
    pub role: Role,
    pub id: String,
    #[serde(default)]
    pub name: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct SnapApp {
    pub exe: String,
    #[serde(default)]
    pub output: Option<DevicePick>,
    #[serde(default)]
    pub input: Option<DevicePick>,
    #[serde(default)]
    pub volume: Option<f32>,
    #[serde(default)]
    pub mute: Option<bool>,
    /// The output is a Lastshot "Send to" rule (not just where it plays now).
    #[serde(default)]
    pub ruled: bool,
}

/// The whole audio setup at one moment.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Snapshot {
    pub id: String,
    /// Named snapshots are the user's scenes ("Gaming"); None = automatic.
    #[serde(default)]
    pub name: Option<String>,
    /// ms since 1970.
    pub time: u64,
    /// Why an automatic one was taken.
    #[serde(default)]
    pub reason: String,
    pub defaults: Vec<SnapDefault>,
    pub apps: Vec<SnapApp>,
    #[serde(default)]
    pub cables: Option<serde_json::Value>,
    #[serde(default)]
    pub guard: Option<GuardSettings>,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Change {
    pub what: String,
    pub from: String,
    pub to: String,
}

fn pick_label(p: &Option<DevicePick>) -> String {
    match p {
        Some(d) if !d.name.is_empty() => d.name.clone(),
        Some(d) => d.id.clone(),
        None => "Windows' default".into(),
    }
}

fn vol_label(v: Option<f32>) -> String {
    v.map(|x| format!("{:.0}%", x * 100.0)).unwrap_or_else(|| "as is".into())
}

/// What restoring `to` would change, starting from `from`.
pub fn diff(from: &Snapshot, to: &Snapshot) -> Vec<Change> {
    let mut out = Vec::new();
    for d in &to.defaults {
        let cur = from.defaults.iter().find(|c| c.flow == d.flow && c.role == d.role);
        if cur.map(|c| c.id != d.id).unwrap_or(true) {
            out.push(Change {
                what: format!("Default {} device ({})", flow_name(d.flow), role_name(d.role)),
                from: cur.map(|c| if c.name.is_empty() { c.id.clone() } else { c.name.clone() }).unwrap_or_else(|| "none".into()),
                to: if d.name.is_empty() { d.id.clone() } else { d.name.clone() },
            });
        }
    }
    for a in &to.apps {
        let empty = SnapApp::default();
        let cur = from.apps.iter().find(|c| c.exe.eq_ignore_ascii_case(&a.exe)).unwrap_or(&empty);
        let app = a.exe.trim_end_matches(".exe");
        if cur.output.as_ref().map(|d| &d.id) != a.output.as_ref().map(|d| &d.id) {
            out.push(Change { what: format!("{app} plays on"), from: pick_label(&cur.output), to: pick_label(&a.output) });
        }
        if cur.input.as_ref().map(|d| &d.id) != a.input.as_ref().map(|d| &d.id) {
            out.push(Change { what: format!("{app} records from"), from: pick_label(&cur.input), to: pick_label(&a.input) });
        }
        if a.volume.is_some() && cur.volume.map(|v| (v * 100.0).round()) != a.volume.map(|v| (v * 100.0).round()) {
            out.push(Change { what: format!("{app} volume"), from: vol_label(cur.volume), to: vol_label(a.volume) });
        }
        if a.mute.is_some() && cur.mute != a.mute {
            let l = |m: Option<bool>| match m {
                Some(true) => "muted".to_string(),
                Some(false) => "not muted".to_string(),
                None => "as is".to_string(),
            };
            out.push(Change { what: format!("{app} mute"), from: l(cur.mute), to: l(a.mute) });
        }
    }
    if to.cables.is_some() && from.cables != to.cables {
        out.push(Change { what: "Cables setup".into(), from: "current".into(), to: "from the snapshot".into() });
    }
    if to.guard.is_some() && from.guard != to.guard {
        out.push(Change { what: "Guard settings".into(), from: "current".into(), to: "from the snapshot".into() });
    }
    out
}

/// Which automatic snapshots to delete: keep the newest `keep` and none
/// older than `max_age_ms`. Named ones are never pruned. Returns ids.
pub fn prune(snaps: &[(String, u64, bool)], now: u64, keep: usize, max_age_ms: u64) -> Vec<String> {
    let mut auto: Vec<&(String, u64, bool)> = snaps.iter().filter(|s| !s.2).collect();
    auto.sort_by_key(|s| std::cmp::Reverse(s.1));
    auto.iter()
        .enumerate()
        .filter(|(i, s)| *i >= keep || now.saturating_sub(s.1) > max_age_ms)
        .map(|(_, s)| s.0.clone())
        .collect()
}

pub const AUTO_KEEP: usize = 100;
pub const AUTO_MAX_AGE_MS: u64 = 30 * 24 * 3600 * 1000;

/// Snapshot names and ids become file names: keep them plain.
pub fn clean_snapshot_name(name: &str) -> Result<String, String> {
    let n: String = name.trim().chars().filter(|c| !c.is_control()).collect();
    if n.is_empty() {
        return Err("Give it a name".into());
    }
    if n.chars().count() > 40 {
        return Err("Keep the name to 40 characters".into());
    }
    Ok(n)
}

pub fn valid_snapshot_id(id: &str) -> bool {
    !id.is_empty() && id.len() <= 64 && id.chars().all(|c| c.is_ascii_alphanumeric() || c == '-')
}

// ---------------------------------------------------------------------------
// Log
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LogEntry {
    pub time: u64,
    /// "default", "app-output", "app-input", "app-volume", "snapshot", "guard".
    pub kind: String,
    pub what: String,
    #[serde(default)]
    pub from: String,
    #[serde(default)]
    pub to: String,
    pub who: Cause,
    /// What the guard did: "restored", "asked", "kept", "muted", "logged", ...
    pub action: String,
}

pub const LOG_MAX_BYTES: u64 = 1024 * 1024;

/// Last `n` entries of a JSON-lines log (bad lines skipped), newest first.
pub fn parse_log(text: &str, n: usize) -> Vec<LogEntry> {
    let mut v: Vec<LogEntry> = text.lines().filter_map(|l| serde_json::from_str(l).ok()).collect();
    v.reverse();
    v.truncate(n);
    v
}

// ---------------------------------------------------------------------------
// Auto-duck
// ---------------------------------------------------------------------------

/// Lowers the other apps while the mic is in use: opens at the threshold,
/// closes when the level has stayed 6 dB below it for `release_ms`
/// (hysteresis, so speech pauses don't pump), with short gain ramps.
#[derive(Debug, Clone)]
pub struct Ducker {
    pub active: bool,
    quiet_ms: u32,
    /// Current gain applied to ducked apps, 0..1.
    pub gain: f32,
}

impl Default for Ducker {
    fn default() -> Self {
        Self { active: false, quiet_ms: 0, gain: 1.0 }
    }
}

pub const DUCK_HYSTERESIS_DB: f32 = 6.0;

impl Ducker {
    /// One step of `dt_ms` with the mic peak level `peak` (0..1).
    /// Returns the gain for ducked apps.
    pub fn step(&mut self, s: &DuckSettings, peak: f32, dt_ms: u32) -> f32 {
        let db = if peak > 0.0 { 20.0 * peak.log10() } else { -120.0 };
        if db >= s.threshold_db {
            self.active = true;
            self.quiet_ms = 0;
        } else if self.active {
            if db < s.threshold_db - DUCK_HYSTERESIS_DB {
                self.quiet_ms += dt_ms;
            } else {
                self.quiet_ms = 0;
            }
            if self.quiet_ms >= s.release_ms {
                self.active = false;
                self.quiet_ms = 0;
            }
        }
        let amount = s.amount_db.clamp(3.0, 30.0);
        let target = if self.active { 10f32.powf(-amount / 20.0) } else { 1.0 };
        // ~50 ms down, ~300 ms up.
        let rate = if target < self.gain { dt_ms as f32 / 50.0 } else { dt_ms as f32 / 300.0 };
        self.gain += (target - self.gain) * rate.min(1.0);
        if (self.gain - target).abs() < 0.002 {
            self.gain = target;
        }
        self.gain
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn pick(id: &str, name: &str) -> DevicePick {
        DevicePick { id: id.into(), name: name.into() }
    }

    #[test]
    fn fallback_order() {
        let order = vec![pick("arctis", "Arctis"), pick("spk", "Speakers")];
        let active = vec![("spk".to_string(), "Speakers".to_string())];
        assert_eq!(pick_connected(&order, &active).map(|x| x.1), Some("spk".into()));
        let active = vec![("spk".into(), "Speakers".into()), ("arctis".into(), "Arctis".into())];
        assert_eq!(pick_connected(&order, &active).map(|x| x.1), Some("arctis".into()));
        // New id after a driver update, same name.
        let active = vec![("arctis2".to_string(), "arctis".to_string())];
        assert_eq!(pick_connected(&order, &active).map(|x| x.1), Some("arctis2".into()));
        assert!(pick_connected(&order, &[]).is_none());
    }

    #[test]
    fn who_changed_it() {
        assert_eq!(classify(Some(500), None), Cause::Windows);
        assert_eq!(classify(Some(500), Some(100)), Cause::Guard);
        assert_eq!(classify(Some(10_000), None), Cause::User);
        assert_eq!(classify(None, Some(5000)), Cause::User);
        assert_eq!(classify(None, None), Cause::User);
    }

    #[test]
    fn what_to_do() {
        use Decision::*;
        assert_eq!(decide(Cause::Guard, Policy::Ask, false, false), Ignore);
        assert_eq!(decide(Cause::Windows, Policy::Ask, false, false), Ask);
        assert_eq!(decide(Cause::Windows, Policy::Restore, false, false), Restore);
        assert_eq!(decide(Cause::User, Policy::Accept, false, false), Accept);
        // Windows making a new cable the default is always undone...
        assert_eq!(decide(Cause::Windows, Policy::Accept, true, false), Restore);
        // ...but a cable the user picked is the user's business.
        assert_eq!(decide(Cause::User, Policy::Accept, true, false), Accept);
        assert_eq!(decide(Cause::Windows, Policy::Ask, true, true), Ask);
    }

    #[test]
    fn per_item_policy_wins() {
        let mut g = GuardSettings { policy: Policy::Ask, ..Default::default() };
        g.app_mut("Discord.exe").policy = Some(Policy::Restore);
        g.device_rules.push(DeviceRule { device_id: "dev".into(), policy: Policy::Accept });
        assert_eq!(g.policy_for(Some("discord.EXE"), Some("dev")), Policy::Restore);
        assert_eq!(g.policy_for(None, Some("dev")), Policy::Accept);
        assert_eq!(g.policy_for(Some("x.exe"), None), Policy::Ask);
        g.app_mut("Discord.exe").policy = None;
        g.tidy();
        assert!(g.apps.is_empty());
    }

    #[test]
    fn preferred_roles() {
        let g = GuardSettings {
            defaults: vec![
                PreferredDefault { flow: 0, comm: false, order: vec![pick("a", "A")] },
                PreferredDefault { flow: 0, comm: true, order: vec![pick("b", "B")] },
            ],
            ..Default::default()
        };
        assert_eq!(g.preferred(0, 1).unwrap().order[0].id, "a");
        assert_eq!(g.preferred(0, 0).unwrap().order[0].id, "a");
        assert_eq!(g.preferred(0, 2).unwrap().order[0].id, "b");
        assert!(g.preferred(1, 0).is_none());
    }

    fn snap(defaults: Vec<SnapDefault>, apps: Vec<SnapApp>) -> Snapshot {
        Snapshot { id: "x".into(), name: None, time: 0, reason: String::new(), defaults, apps, cables: None, guard: None }
    }

    #[test]
    fn diffs_read_plainly() {
        let d = |id: &str, name: &str| SnapDefault { flow: 0, role: 1, id: id.into(), name: name.into() };
        let a = snap(vec![d("1", "Speakers")], vec![]);
        let b = snap(
            vec![d("2", "Headset")],
            vec![SnapApp { exe: "Discord.exe".into(), output: Some(pick("c", "Chat (Lastshot)")), volume: Some(0.5), ..Default::default() }],
        );
        let ch = diff(&a, &b);
        assert_eq!(ch.len(), 3);
        assert_eq!(ch[0].what, "Default playback device (default (multimedia))");
        assert_eq!((ch[0].from.as_str(), ch[0].to.as_str()), ("Speakers", "Headset"));
        assert_eq!(ch[1].what, "Discord plays on");
        assert_eq!(ch[1].from, "Windows' default");
        assert_eq!(ch[2].to, "50%");
        assert!(diff(&b, &b).is_empty());
    }

    #[test]
    fn pruning_keeps_named_and_recent() {
        let day: u64 = 24 * 3600 * 1000;
        let now = 400 * day;
        let mut v: Vec<(String, u64, bool)> = (0..105).map(|i| (format!("a{i}"), now - i as u64 * 1000, false)).collect();
        v.push(("old".into(), now - 31 * day, false));
        v.push(("gaming".into(), now - 300 * day, true));
        let gone = prune(&v, now, AUTO_KEEP, AUTO_MAX_AGE_MS);
        assert_eq!(gone.len(), 6);
        assert!(gone.contains(&"old".to_string()));
        assert!(gone.contains(&"a104".to_string()));
        assert!(!gone.contains(&"gaming".to_string()));
        assert!(!gone.contains(&"a0".to_string()));
    }

    #[test]
    fn names_and_ids() {
        assert_eq!(clean_snapshot_name(" Gaming ").unwrap(), "Gaming");
        assert!(clean_snapshot_name("").is_err());
        assert!(valid_snapshot_id("auto-1731234-ab"));
        assert!(!valid_snapshot_id("../x"));
        assert!(!valid_snapshot_id(""));
    }

    #[test]
    fn log_lines() {
        let e = LogEntry {
            time: 5,
            kind: "default".into(),
            what: "Default playback".into(),
            from: "A".into(),
            to: "B".into(),
            who: Cause::Windows,
            action: "restored".into(),
        };
        let line = serde_json::to_string(&e).unwrap();
        assert!(line.contains("\"who\":\"windows\""));
        let text = format!("{line}\nnot json\n{}\n", line.replace("\"time\":5", "\"time\":6"));
        let v = parse_log(&text, 10);
        assert_eq!(v.len(), 2);
        assert_eq!(v[0].time, 6);
        assert_eq!(parse_log(&text, 1).len(), 1);
    }

    #[test]
    fn duck_opens_holds_and_releases() {
        let s = DuckSettings { enabled: true, threshold_db: -30.0, amount_db: 12.0, release_ms: 500 };
        let mut d = Ducker::default();
        let loud = 0.1; // -20 dB
        let between = 0.025; // -32 dB: under the threshold, inside the hysteresis
        let quiet = 0.001; // -60 dB
        for _ in 0..10 {
            d.step(&s, loud, 50);
        }
        assert!(d.active);
        let ducked = 10f32.powf(-12.0 / 20.0);
        assert!((d.gain - ducked).abs() < 0.01, "gain {}", d.gain);
        // Within the hysteresis band it stays down however long.
        for _ in 0..40 {
            d.step(&s, between, 50);
        }
        assert!(d.active);
        // Quiet: stays down for release_ms, then comes back up.
        for _ in 0..9 {
            d.step(&s, quiet, 50);
        }
        assert!(d.active);
        d.step(&s, quiet, 50);
        assert!(!d.active);
        for _ in 0..40 {
            d.step(&s, quiet, 50);
        }
        assert!((d.gain - 1.0).abs() < 0.001);
        // Amount is clamped to 3-30 dB.
        let mut d2 = Ducker::default();
        let s2 = DuckSettings { amount_db: 80.0, ..s.clone() };
        for _ in 0..20 {
            d2.step(&s2, loud, 50);
        }
        assert!((d2.gain - 10f32.powf(-30.0 / 20.0)).abs() < 0.01);
    }
}
