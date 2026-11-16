//! Audio tab → Devices and the Audio guard: Lastshot keeps the user's
//! default devices, per-app outputs and microphones, volumes and mutes
//! where the user put them, and decides what to do when Windows (or
//! anything else) changes them: ask, put them back, or accept.
//!
//! - Event-driven: device notifications (IMMNotificationClient) and new
//!   audio sessions (IAudioSessionNotification) wake the guard thread; a
//!   slow 3 s tick catches what no event reports (an app moved by its own
//!   settings, new processes for remembered microphones).
//! - Every change is preceded by an automatic snapshot of the whole setup,
//!   and logged (time, what, from → to, who, what the guard did).
//! - Off by default: nothing is watched or touched until the user turns the
//!   guard on (remembered per-app microphones apply like "Send to" does).
//! - IPolicyConfig and IAudioPolicyConfigFactory are undocumented; when
//!   either fails the UI says so in plain words.

pub mod model;
pub mod store;
pub mod win;

use std::collections::{HashMap, HashSet};
use std::sync::mpsc::{channel, RecvTimeoutError, Sender};
use std::sync::Arc;
use std::time::{Duration, Instant};

use parking_lot::Mutex;
use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager};

use crate::audio_routing::app_output;
use crate::audio_routing::endpoints as devices;
use crate::commands::AppState;
pub use model::*;
use store::{now_ms, SnapshotMeta, Store};
use win::Event;

pub const EVT_GUARD: &str = "lastshot://audio-guard";
const ASK_EXPIRES: Duration = Duration::from_secs(15 * 60);

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

#[derive(Debug, Clone)]
enum Question {
    /// Windows (or someone) moved a default: `roles` of `flow` now on `new`.
    Default { flow: Flow, roles: Vec<Role>, mine: String, mine_name: String, new: String, new_name: String },
    /// An app's session is on `now` instead of `mine`.
    App { exe: String, pid: u32, render: bool, mine: String, mine_name: String, now_name: String },
}

struct Pending {
    id: u64,
    q: Question,
    at: Instant,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PendingView {
    pub id: u64,
    pub text: String,
}

#[derive(Default)]
struct GState {
    known_defaults: HashMap<(Flow, Role), String>,
    own_writes: HashMap<String, Instant>,
    last_device_event: Option<Instant>,
    pending: Vec<Pending>,
    next_id: u64,
    /// pid → exe, muted by strict mode.
    strict_muted: HashMap<u32, String>,
    /// (pid, render) → the wrong device we already dealt with.
    handled: HashMap<(u32, bool), String>,
    /// Same for an app's Windows setting (its sound may not have moved yet).
    handled_setting: HashMap<(u32, bool), String>,
    /// pids whose remembered microphone / volume was applied.
    applied_input: HashSet<u32>,
    applied_volume: HashSet<u32>,
    last_fix: Option<(Instant, String)>,
    error: Option<String>,
    ducker: Ducker,
    /// pid → volume before ducking.
    ducked: HashMap<u32, f32>,
    /// Solo: the app, and the pids Lastshot muted for it.
    solo: Option<(String, Vec<u32>)>,
}

pub struct Guard {
    st: Mutex<GState>,
    tx: Mutex<Option<Sender<Event>>>,
    store: Store,
    app_id: String,
}

fn guard(app: &AppHandle) -> Option<tauri::State<'_, Arc<Guard>>> {
    app.try_state::<Arc<Guard>>()
}

fn settings(app: &AppHandle) -> GuardSettings {
    app.state::<AppState>().settings.read().audio_guard.clone()
}

fn save_settings(app: &AppHandle, g: GuardSettings) -> Result<(), String> {
    let state = app.state::<AppState>();
    let mut s = state.settings.read().clone();
    s.audio_guard = g;
    s.save()?;
    *state.settings.write() = s;
    Ok(())
}

fn emit(app: &AppHandle) {
    let _ = app.emit(EVT_GUARD, ());
}

fn ago(t: Option<Instant>) -> Option<u64> {
    t.map(|t| t.elapsed().as_millis() as u64)
}

fn short(exe: &str) -> &str {
    exe.strip_suffix(".exe").or_else(|| exe.strip_suffix(".EXE")).unwrap_or(exe)
}

/// id → name for the active devices of one flow.
fn active(flow: Flow) -> Vec<(String, String)> {
    devices::list_endpoints(flow == 0).into_iter().map(|e| (e.id, e.name)).collect()
}

fn name_of(id: &str) -> String {
    devices::list_endpoints(true)
        .into_iter()
        .chain(devices::list_endpoints(false))
        .find(|e| e.id == id)
        .map(|e| e.name)
        .unwrap_or_else(|| if id.is_empty() { "nothing".into() } else { "a device that is not connected".into() })
}

/// What the guard needs from Lastshot's virtual cables (Pro). A build
/// without cables never sets it: then there are no cables.
pub trait CableHooks: Send + Sync {
    /// Endpoint ids of every cable (both sides).
    fn endpoint_ids(&self) -> Vec<String>;
    /// The cable settings were replaced (a restored snapshot): apply them.
    fn reload(&self, app: &AppHandle);
}

static CABLE_HOOKS: std::sync::OnceLock<Box<dyn CableHooks>> = std::sync::OnceLock::new();

/// Called once by the cables module when it starts.
pub fn set_cable_hooks(h: Box<dyn CableHooks>) {
    let _ = CABLE_HOOKS.set(h);
}

fn cable_ids() -> HashSet<String> {
    CABLE_HOOKS.get().map(|h| h.endpoint_ids()).unwrap_or_default().into_iter().collect()
}

/// The output the user chose for `exe` ("Send to").
fn wanted_output(app: &AppHandle, exe: &str) -> Option<DevicePick> {
    app.state::<AppState>()
        .settings
        .read()
        .app_outputs
        .iter()
        .find(|r| r.exe.eq_ignore_ascii_case(exe))
        .map(|r| DevicePick { id: r.device_id.clone(), name: r.device_name.clone() })
}

// ---------------------------------------------------------------------------
// Snapshots
// ---------------------------------------------------------------------------

/// The whole setup now. `patch` replaces one default (the value it had just
/// before a detected change), so the snapshot shows the setup before it.
fn live_snapshot(app: &AppHandle, reason: &str, patch: Option<(Flow, Role, &str)>) -> Snapshot {
    let names: HashMap<String, String> =
        devices::list_endpoints(true).into_iter().chain(devices::list_endpoints(false)).map(|e| (e.id, e.name)).collect();
    let mut defaults: Vec<SnapDefault> = devices::snapshot_defaults()
        .into_iter()
        .map(|d| SnapDefault { flow: d.flow, role: d.role, name: names.get(&d.id).cloned().unwrap_or_default(), id: d.id })
        .collect();
    if let Some((f, r, id)) = patch {
        if let Some(d) = defaults.iter_mut().find(|d| d.flow == f && d.role == r) {
            d.id = id.to_string();
            d.name = names.get(id).cloned().unwrap_or_default();
        }
    }
    let s = app.state::<AppState>().settings.read().clone();
    let g = s.audio_guard.clone();
    let mut apps: Vec<SnapApp> = Vec::new();
    fn add(apps: &mut Vec<SnapApp>, exe: &str) -> usize {
        if let Some(i) = apps.iter().position(|a| a.exe.eq_ignore_ascii_case(exe)) {
            return i;
        }
        apps.push(SnapApp { exe: exe.to_string(), ..Default::default() });
        apps.len() - 1
    }
    for r in &s.app_outputs {
        let i = add(&mut apps, &r.exe);
        apps[i].output = Some(DevicePick { id: r.device_id.clone(), name: r.device_name.clone() });
        apps[i].ruled = true;
    }
    for p in &g.apps {
        let i = add(&mut apps, &p.exe);
        apps[i].input = p.input.clone();
        apps[i].volume = p.volume;
        apps[i].mute = p.mute;
    }
    // Running apps: their live devices (including ones set outside
    // Lastshot), volume and mute, so a restore puts back exactly this.
    let names: HashMap<String, String> = names;
    let pick = |id: Option<String>| id.map(|id| DevicePick { name: names.get(&id).cloned().unwrap_or_default(), id });
    let mut seen: HashSet<String> = HashSet::new();
    for sess in win::sessions(false) {
        let i = add(&mut apps, &sess.exe);
        if seen.insert(sess.exe.to_lowercase()) {
            let ruled = s.app_outputs.iter().any(|r| r.exe.eq_ignore_ascii_case(&sess.exe));
            if !ruled {
                apps[i].output = pick(app_output::get_app_device(sess.pid, true).ok().flatten());
            }
            if apps[i].input.is_none() {
                apps[i].input = pick(app_output::get_app_device(sess.pid, false).ok().flatten());
            }
        }
        if sess.render && apps[i].volume.is_none() {
            apps[i].volume = Some(sess.volume);
            apps[i].mute = Some(sess.mute);
        }
    }
    apps.sort_by_key(|a| a.exe.to_lowercase());
    Snapshot {
        id: String::new(),
        name: None,
        time: now_ms(),
        reason: reason.to_string(),
        defaults,
        apps,
        cables: (!s.cables.is_null()).then(|| s.cables.clone()),
        guard: Some(g),
    }
}

/// An automatic snapshot before a change.
fn auto_snapshot(app: &AppHandle, reason: &str, patch: Option<(Flow, Role, &str)>) {
    if let Some(g) = guard(app) {
        let s = live_snapshot(app, reason, patch);
        g.store.auto(s);
    }
}

fn log(app: &AppHandle, kind: &str, what: String, from: String, to: String, who: Cause, action: &str) {
    if let Some(g) = guard(app) {
        g.store.log(&LogEntry { time: now_ms(), kind: kind.into(), what, from, to, who, action: action.into() });
    }
}

// ---------------------------------------------------------------------------
// Acting
// ---------------------------------------------------------------------------

fn mark_own(app: &AppHandle, key: String) {
    if let Some(g) = guard(app) {
        g.st.lock().own_writes.insert(key, Instant::now());
    }
}

fn set_error(app: &AppHandle, e: Option<String>) {
    if let Some(g) = guard(app) {
        g.st.lock().error = e;
    }
}

/// Makes `id` the default for `roles` (Lastshot's own write).
fn set_default(app: &AppHandle, flow: Flow, roles: &[Role], id: &str) -> Result<(), String> {
    for r in roles {
        mark_own(app, format!("d{flow}{r}"));
        if let Err(e) = devices::set_default_endpoint(id, *r) {
            set_error(app, Some(e.clone()));
            return Err(e);
        }
    }
    if let Some(g) = guard(app) {
        let mut st = g.st.lock();
        for r in roles {
            st.known_defaults.insert((flow, *r), id.to_string());
        }
    }
    Ok(())
}

fn set_app_device(app: &AppHandle, pid: u32, render: bool, id: Option<&str>) -> Result<(), String> {
    mark_own(app, format!("a{pid}{render}"));
    let r = app_output::set_app_device(pid, render, id).inspect_err(|e| set_error(app, Some(format!("Per-app devices are not available ({e})"))));
    if r.is_ok() {
        // Its setting is now ours: the next change to it is news again.
        if let Some(g) = guard(app) {
            g.st.lock().handled_setting.remove(&(pid, render));
        }
    }
    r
}

fn fixed(app: &AppHandle, text: String) {
    if let Some(g) = guard(app) {
        g.st.lock().last_fix = Some((Instant::now(), text));
    }
}

/// Test copies (LASTSHOT_TEST_INSTANCE=1) show nothing on the desktop.
fn test_instance() -> bool {
    std::env::var("LASTSHOT_TEST_INSTANCE").as_deref() == Ok("1")
}

fn notify(app: &AppHandle, title: &str, body: &str) {
    use tauri_plugin_notification::NotificationExt;
    if test_instance() {
        return;
    }
    let _ = app.notification().builder().title(title).body(body).show();
}

/// A notification with buttons. It never takes focus; in a full-screen game
/// Windows holds it in the notification center.
fn ask_toast(app: &AppHandle, id: u64, title: &str, body: &str) -> Option<()> {
    if test_instance() {
        return None;
    }
    #[cfg(windows)]
    {
        use tauri_winrt_notification::Toast;
        let g = guard(app)?;
        let h = app.clone();
        let toast = Toast::new(&g.app_id)
            .title(title)
            .text1(body)
            .sound(None)
            .add_button("Restore mine", &format!("{id}:restore"))
            .add_button("Keep new", &format!("{id}:keep"))
            .add_button("Always restore", &format!("{id}:alwaysRestore"))
            .on_activated(move |action| {
                if let Some(a) = action {
                    let mut it = a.splitn(2, ':');
                    if let (Some(Ok(id)), Some(choice)) = (it.next().map(|x| x.parse::<u64>()), it.next()) {
                        let h2 = h.clone();
                        let choice = choice.to_string();
                        std::thread::spawn(move || {
                            let _ = answer(&h2, id, &choice);
                        });
                    }
                }
                Ok(())
            });
        if let Err(e) = toast.show() {
            log::warn!("[audio-guard] notification not shown: {e:?}");
            return None;
        }
        return Some(());
    }
    #[allow(unreachable_code)]
    {
        let _ = (app, id, title, body);
        None
    }
}

fn question_text(q: &Question) -> (String, String) {
    match q {
        Question::Default { flow, new_name, mine_name, roles, .. } => (
            format!("Windows changed your default {}", if *flow == 0 { "output" } else { "microphone" }),
            format!(
                "{}{} is now the default. Yours was {}.",
                new_name,
                if roles == &[2] { " (communications)" } else { "" },
                mine_name
            ),
        ),
        Question::App { exe, render, now_name, mine_name, .. } => (
            format!("{} moved", short(exe)),
            format!(
                "{} now {} {} instead of {}.",
                short(exe),
                if *render { "plays on" } else { "records from" },
                now_name,
                mine_name
            ),
        ),
    }
}

fn ask(app: &AppHandle, q: Question) {
    let Some(g) = guard(app) else { return };
    // Windows moves the three roles one by one: one question for all.
    {
        let mut st = g.st.lock();
        if let Question::Default { flow, roles, new, .. } = &q {
            for p in st.pending.iter_mut() {
                if let Question::Default { flow: f2, roles: r2, new: n2, .. } = &mut p.q {
                    if f2 == flow && n2 == new && p.at.elapsed() < Duration::from_secs(3) {
                        for r in roles {
                            if !r2.contains(r) {
                                r2.push(*r);
                            }
                        }
                        return;
                    }
                }
            }
        }
    }
    let id = {
        let mut st = g.st.lock();
        st.next_id += 1;
        st.next_id
    };
    let (title, body) = question_text(&q);
    if ask_toast(app, id, &title, &body).is_none() {
        log::info!("[audio-guard] question {id} is in the Audio tab only");
    }
    g.st.lock().pending.push(Pending { id, q, at: Instant::now() });
    emit(app);
}

/// The user's answer to a question: "restore", "keep", "alwaysRestore",
/// "alwaysKeep".
pub fn answer(app: &AppHandle, id: u64, choice: &str) -> Result<(), String> {
    let g = guard(app).ok_or("Not ready")?;
    let p = {
        let mut st = g.st.lock();
        let i = st.pending.iter().position(|p| p.id == id).ok_or("That question was already answered")?;
        st.pending.remove(i)
    };
    let restore = choice == "restore" || choice == "alwaysRestore";
    let always = choice.starts_with("always");
    if always {
        let mut gs = settings(app);
        let pol = if restore { Policy::Restore } else { Policy::Accept };
        match &p.q {
            Question::Default { new, .. } => {
                gs.device_rules.retain(|r| &r.device_id != new);
                gs.device_rules.push(DeviceRule { device_id: new.clone(), policy: pol });
            }
            Question::App { exe, .. } => gs.app_mut(exe).policy = Some(pol),
        }
        auto_snapshot(app, "Before remembering your answer", None);
        save_settings(app, gs)?;
    }
    match &p.q {
        Question::Default { flow, roles, mine, mine_name, new_name, .. } => {
            let what = format!("Default {} device", flow_name(*flow));
            if restore {
                auto_snapshot(app, "Before putting your default back", None);
                set_default(app, *flow, roles, mine)?;
                fixed(app, format!("Put your default {} back on {mine_name}", flow_name(*flow)));
            }
            log(app, "default", what, new_name.clone(), if restore { mine_name.clone() } else { new_name.clone() }, Cause::User, if restore { "restored (your answer)" } else { "kept (your answer)" });
        }
        Question::App { exe, pid, render, mine, mine_name, now_name, .. } => {
            if restore {
                auto_snapshot(app, &format!("Before moving {} back", short(exe)), None);
                set_app_device(app, *pid, *render, Some(mine))?;
                fixed(app, format!("Moved {} back to {mine_name}", short(exe)));
            }
            unmute_strict(app, *pid);
            log(
                app,
                if *render { "app-output" } else { "app-input" },
                short(exe).to_string(),
                now_name.clone(),
                if restore { mine_name.clone() } else { now_name.clone() },
                Cause::User,
                if restore { "restored (your answer)" } else { "kept (your answer)" },
            );
        }
    }
    emit(app);
    Ok(())
}

fn unmute_strict(app: &AppHandle, pid: u32) {
    let Some(g) = guard(app) else { return };
    let was = g.st.lock().strict_muted.remove(&pid);
    if let Some(exe) = was {
        win::set_pid_volume(pid, None, Some(false), true);
        log(app, "app-volume", short(&exe).to_string(), "muted".into(), "not muted".into(), Cause::Guard, "unmuted (strict mode)");
    }
}

// ---------------------------------------------------------------------------
// Reacting
// ---------------------------------------------------------------------------

fn on_default_changed(app: &AppHandle, flow: Flow, role: Role, new: String) {
    let Some(g) = guard(app) else { return };
    let (prev, since_dev, since_own) = {
        let mut st = g.st.lock();
        let prev = st.known_defaults.insert((flow, role), new.clone());
        (prev, ago(st.last_device_event), ago(st.own_writes.get(&format!("d{flow}{role}")).copied()))
    };
    if prev.as_deref() == Some(new.as_str()) {
        return;
    }
    let gs = settings(app);
    if !gs.enabled {
        return;
    }
    let cause = classify(since_dev, since_own);
    if cause == Cause::Guard {
        return;
    }
    // What the user wants here: the first connected preferred device, or
    // (no preference set) what it was before.
    let wanted = match gs.preferred(flow, role) {
        Some(p) => pick_connected(&p.order, &active(flow)).map(|(_, id)| id),
        None => prev.clone(),
    };
    let Some(wanted) = wanted.filter(|w| !w.is_empty()) else { return };
    if wanted == new {
        return;
    }
    let is_cable = cable_ids().contains(&new);
    let picked = gs.preferred(flow, role).is_some_and(|p| p.order.iter().any(|d| d.id == new));
    let decision = decide(cause, gs.policy_for(None, Some(&new)), is_cable, picked);
    let (new_name, mine_name) = (name_of(&new), name_of(&wanted));
    let what = format!("Default {} device ({})", flow_name(flow), role_name(role));
    auto_snapshot(app, &format!("Before: {what} changed"), prev.as_deref().map(|p| (flow, role, p)));
    match decision {
        Decision::Ignore => {}
        Decision::Restore => {
            let action = match set_default(app, flow, &[role], &wanted) {
                Ok(()) => {
                    let who = if cause == Cause::Windows { "Windows" } else { "Something" };
                    let text = format!("Fixed: {who} switched your {} to {new_name}", flow_name(flow));
                    fixed(app, text.clone());
                    if gs.notify_restores && role == 0 {
                        notify(app, "Lastshot put your device back", &format!("{text}; back on {mine_name}."));
                    }
                    "restored"
                }
                Err(_) => "could not restore",
            };
            log(app, "default", what, new_name, mine_name, cause, action);
        }
        Decision::Ask => {
            log(app, "default", what, mine_name.clone(), new_name.clone(), cause, "asked");
            ask(app, Question::Default { flow, roles: vec![role], mine: wanted, mine_name, new, new_name });
        }
        Decision::Accept => log(app, "default", what, mine_name, new_name, cause, "kept (your setting)"),
    }
    emit(app);
}

/// Puts each default on the first connected preferred device (after a
/// device came or went).
fn apply_preferred(app: &AppHandle, gs: &GuardSettings) {
    let Some(g) = guard(app) else { return };
    for p in &gs.defaults {
        let Some((pick, id)) = pick_connected(&p.order, &active(p.flow)) else { continue };
        let roles: Vec<Role> = p
            .roles()
            .iter()
            .copied()
            .filter(|r| g.st.lock().known_defaults.get(&(p.flow, *r)) != Some(&id))
            .collect();
        if roles.is_empty() {
            continue;
        }
        let from = g.st.lock().known_defaults.get(&(p.flow, roles[0])).cloned().unwrap_or_default();
        // A device event is Windows' doing: the policy decides, like any change.
        let decision = decide(Cause::Windows, gs.policy_for(None, Some(&from)), cable_ids().contains(&from), false);
        if decision != Decision::Restore {
            continue; // on_default_changed already asked or accepted
        }
        auto_snapshot(app, "Before switching to your preferred device", None);
        let what = format!("Default {} device", flow_name(p.flow));
        if set_default(app, p.flow, &roles, &id).is_ok() {
            fixed(app, format!("Switched your {} to {}", flow_name(p.flow), pick.name));
            log(app, "default", what, name_of(&from), pick.name.clone(), Cause::Guard, "switched to your preferred device");
        }
    }
}

/// Apps on the wrong device; remembered microphones and volumes for new
/// processes.
fn check_apps(app: &AppHandle) {
    let Some(g) = guard(app) else { return };
    let gs = settings(app);
    let sessions = win::sessions(false);
    let procs = app_output::processes();
    let alive: HashSet<u32> = procs.iter().map(|(p, _)| *p).collect();
    {
        let mut st = g.st.lock();
        st.handled.retain(|(p, _), _| alive.contains(p));
        st.handled_setting.retain(|(p, _), _| alive.contains(p));
        st.applied_input.retain(|p| alive.contains(p));
        st.applied_volume.retain(|p| alive.contains(p));
        st.strict_muted.retain(|p, _| alive.contains(p));
    }
    // Remembered microphones: once per new process (like "Send to").
    for (pid, exe) in &procs {
        let Some(pick) = gs.app(exe).and_then(|a| a.input.clone()) else { continue };
        if !g.st.lock().applied_input.insert(*pid) {
            continue;
        }
        if let Some((_, id)) = pick_connected(std::slice::from_ref(&pick), &active(1)) {
            let _ = set_app_device(app, *pid, false, Some(&id));
        }
    }
    // Remembered volume / mute: once per process, when its sound starts.
    for s in sessions.iter().filter(|s| s.render) {
        let Some(p) = gs.app(&s.exe) else { continue };
        if (p.volume.is_some() || p.mute.is_some()) && g.st.lock().applied_volume.insert(s.pid) {
            win::set_pid_volume(s.pid, p.volume, p.mute, false);
        }
    }
    if !gs.enabled {
        return;
    }
    let (act_r, act_c) = (active(0), active(1));
    for s in &sessions {
        let want = if s.render { wanted_output(app, &s.exe) } else { gs.app(&s.exe).and_then(|a| a.input.clone()) };
        let Some(want) = want else { continue };
        let Some((_, want_id)) = pick_connected(std::slice::from_ref(&want), if s.render { &act_r } else { &act_c }) else { continue };
        if s.device_id == want_id {
            if g.st.lock().strict_muted.contains_key(&s.pid) {
                unmute_strict(app, s.pid);
            }
            g.st.lock().handled.remove(&(s.pid, s.render));
            continue;
        }
        // Already handled this exact situation.
        {
            let mut st = g.st.lock();
            if st.handled.get(&(s.pid, s.render)) == Some(&s.device_id) {
                continue;
            }
            st.handled.insert((s.pid, s.render), s.device_id.clone());
        }
        let routed = app_output::get_app_device(s.pid, s.render).ok().flatten();
        if let Some(r) = routed.as_deref().filter(|r| *r != want_id) {
            // Dealt with here, so the setting check below doesn't ask twice.
            g.st.lock().handled_setting.insert((s.pid, s.render), r.to_string());
        }
        let m = Misroute { pid: s.pid, exe: &s.exe, render: s.render, now: &s.device_id, want: &want, want_id: &want_id };
        misrouted(app, &gs, &m, routed.as_deref(), true);
    }
    // The app's own Windows setting was changed (Settings → App volume,
    // another tool) while its sound is still right: some apps only switch
    // when they next open their sound, so catch the setting itself.
    let mut seen = HashSet::new();
    for (pid, exe) in &procs {
        if !seen.insert(*pid) {
            continue;
        }
        for render in [true, false] {
            let want = if render { wanted_output(app, exe) } else { gs.app(exe).and_then(|a| a.input.clone()) };
            let Some(want) = want else { continue };
            let Some((_, want_id)) = pick_connected(std::slice::from_ref(&want), if render { &act_r } else { &act_c }) else { continue };
            let key = (*pid, render);
            let routed = match app_output::get_app_device(*pid, render) {
                Ok(Some(r)) if r != want_id => r,
                _ => {
                    g.st.lock().handled_setting.remove(&key);
                    continue;
                }
            };
            {
                let mut st = g.st.lock();
                if st.handled_setting.get(&key) == Some(&routed) {
                    continue;
                }
                st.handled_setting.insert(key, routed.clone());
            }
            let m = Misroute { pid: *pid, exe, render, now: &routed, want: &want, want_id: &want_id };
            misrouted(app, &gs, &m, Some(&routed), false);
        }
    }
}

/// One app on a device it should not be on.
struct Misroute<'a> {
    pid: u32,
    exe: &'a str,
    render: bool,
    /// Where it is now (its sound, or its Windows setting).
    now: &'a str,
    want: &'a DevicePick,
    want_id: &'a str,
}

/// What the guard does about it, by the policy. `by_sound`: its sound is
/// on the wrong device (strict mode may mute it); else only its Windows
/// setting changed.
fn misrouted(app: &AppHandle, gs: &GuardSettings, m: &Misroute, routed: Option<&str>, by_sound: bool) {
    let Some(g) = guard(app) else { return };
    let (since_dev, since_own) = {
        let st = g.st.lock();
        (ago(st.last_device_event), ago(st.own_writes.get(&format!("a{}{}", m.pid, m.render)).copied()))
    };
    // Setting right but the sound elsewhere: Windows fell back, or the app
    // picks its own device.
    let setting_right = routed == Some(m.want_id);
    let cause = if by_sound && setting_right { Cause::Windows } else { classify(since_dev, since_own) };
    if cause == Cause::Guard {
        return;
    }
    let decision = decide(cause, gs.policy_for(Some(m.exe), Some(m.now)), false, false);
    let (now_name, mine_name) = (name_of(m.now), m.want.name.clone());
    let kind = if m.render { "app-output" } else { "app-input" };
    let app_name = short(m.exe).to_string();
    auto_snapshot(app, &format!("Before: {app_name} moved"), None);
    match decision {
        Decision::Ignore => {}
        Decision::Restore => {
            let ok = set_app_device(app, m.pid, m.render, Some(m.want_id)).is_ok();
            let who = if cause == Cause::Windows { "Windows" } else { "Something" };
            if ok {
                let text = format!("Fixed: {who} moved {app_name} to {now_name}");
                fixed(app, text.clone());
                if gs.notify_restores {
                    notify(app, "Lastshot moved an app back", &format!("{text}; back on {mine_name}."));
                }
            }
            let action = match (ok, by_sound && setting_right) {
                (false, _) => "could not move it back",
                (true, true) => "moved back (if it stays, the app picks its own device in its settings)",
                (true, false) => "moved back",
            };
            log(app, kind, app_name, now_name, mine_name, cause, action);
        }
        Decision::Ask => {
            // Strict mode mutes only sound that really is on the wrong device.
            let strict = gs.strict && by_sound;
            if strict && win::set_pid_volume(m.pid, None, Some(true), true) > 0 {
                g.st.lock().strict_muted.insert(m.pid, m.exe.to_string());
            }
            log(app, kind, app_name, mine_name.clone(), now_name.clone(), cause, if strict { "asked; muted until answered (strict)" } else { "asked" });
            ask(
                app,
                Question::App {
                    exe: m.exe.to_string(),
                    pid: m.pid,
                    render: m.render,
                    mine: m.want_id.to_string(),
                    mine_name,
                    now_name,
                },
            );
        }
        Decision::Accept => log(app, kind, app_name, mine_name, now_name, cause, "kept (your setting)"),
    }
    emit(app);
}

/// Auto-duck: one step. Lowers every other app while the mic is in use.
fn duck_step(app: &AppHandle, gs: &GuardSettings, dt_ms: u32) {
    let Some(g) = guard(app) else { return };
    if !gs.duck.enabled {
        let restore: Vec<(u32, f32)> = g.st.lock().ducked.drain().collect();
        for (pid, v) in restore {
            win::set_pid_volume(pid, Some(v), None, false);
        }
        g.st.lock().ducker = Ducker::default();
        return;
    }
    let (_, mic) = win::device_peaks();
    let (before, after) = {
        let mut st = g.st.lock();
        let b = st.ducker.gain;
        (b, st.ducker.step(&gs.duck, mic, dt_ms))
    };
    if (after - before).abs() < 0.005 && !(after == 1.0 && before != 1.0) {
        return;
    }
    let me = std::process::id();
    for s in win::sessions(false).into_iter().filter(|s| s.render && s.pid != me) {
        if gs.app(&s.exe).is_some_and(|a| a.no_duck) {
            continue;
        }
        let orig = *g.st.lock().ducked.entry(s.pid).or_insert(s.volume);
        win::set_pid_volume(s.pid, Some(orig * after), None, false);
    }
    if after >= 1.0 {
        g.st.lock().ducked.clear();
    }
}

fn run(app: AppHandle, rx: std::sync::mpsc::Receiver<Event>, tx: Sender<Event>) {
    let mut watcher = match win::Watcher::start(tx) {
        Ok(w) => Some(w),
        Err(e) => {
            set_error(&app, Some(format!("Lastshot can't watch audio devices ({e})")));
            None
        }
    };
    // Probe the undocumented interfaces once (read-only).
    if let Err(e) = app_output::get_app_device(std::process::id(), true) {
        set_error(&app, Some(format!("Per-app devices are not available on this Windows ({e})")));
    }
    if let Some(g) = guard(&app) {
        let mut st = g.st.lock();
        for d in devices::snapshot_defaults() {
            st.known_defaults.insert((d.flow, d.role), d.id);
        }
    }
    let mut last_tick = Instant::now();
    let mut device_settle: Option<Instant> = None;
    loop {
        let gs = settings(&app);
        let wait = if gs.duck.enabled { Duration::from_millis(50) } else { Duration::from_millis(1000) };
        match rx.recv_timeout(wait) {
            Ok(Event::DefaultChanged(f, r, id)) => on_default_changed(&app, f, r, id),
            Ok(Event::DeviceEvent) => {
                if let Some(g) = guard(&app) {
                    g.st.lock().last_device_event = Some(Instant::now());
                }
                device_settle = Some(Instant::now());
            }
            Ok(Event::SessionCreated) => {
                // Let the new session settle on its device first.
                std::thread::sleep(Duration::from_millis(150));
                check_apps(&app);
                emit(&app);
            }
            Err(RecvTimeoutError::Timeout) => {}
            Err(RecvTimeoutError::Disconnected) => break,
        }
        if device_settle.is_some_and(|t| t.elapsed() > Duration::from_millis(600)) {
            device_settle = None;
            if let Some(w) = watcher.as_mut() {
                w.rewatch_sessions();
            }
            let gs = settings(&app);
            if gs.enabled {
                apply_preferred(&app, &gs);
            }
            check_apps(&app);
            emit(&app);
        }
        if gs.duck.enabled || guard(&app).is_some_and(|g| !g.st.lock().ducked.is_empty()) {
            duck_step(&app, &gs, 50);
        }
        if last_tick.elapsed() >= Duration::from_secs(3) {
            last_tick = Instant::now();
            check_apps(&app);
            // Unanswered questions expire as "keep".
            let expired: Vec<u64> = guard(&app)
                .map(|g| g.st.lock().pending.iter().filter(|p| p.at.elapsed() > ASK_EXPIRES).map(|p| p.id).collect())
                .unwrap_or_default();
            for id in expired {
                let _ = answer(&app, id, "keep");
            }
        }
        if guard(&app).is_none() {
            break;
        }
    }
    drop(watcher);
}

/// Called once at app start.
pub fn init(app: &AppHandle) {
    let dir = crate::paths::app_data_dir().join("audio-guard");
    // Installed copies have a registered app id; a portable exe borrows
    // PowerShell's, which Windows always accepts.
    let installed = std::env::current_exe()
        .ok()
        .and_then(|p| p.to_str().map(|s| s.to_ascii_lowercase()))
        .is_some_and(|p| p.contains("\\program files"));
    let app_id = if installed {
        app.config().identifier.clone()
    } else {
        "{1AC14E77-02E7-4E5D-B744-2EB1AE5198B7}\\WindowsPowerShell\\v1.0\\powershell.exe".to_string()
    };
    let g = Arc::new(Guard { st: Mutex::new(GState::default()), tx: Mutex::new(None), store: Store::new(dir), app_id });
    app.manage(g.clone());
    let (tx, rx) = channel();
    *g.tx.lock() = Some(tx.clone());
    let h = app.clone();
    let _ = std::thread::Builder::new().name("audio-guard".into()).spawn(move || run(h, rx, tx));
    // The mic-mute shortcut.
    let key = settings(app).mic_mute_hotkey;
    if !key.is_empty() {
        if let Err(e) = crate::hotkeys::rebind(app, "", &key) {
            log::warn!("[audio-guard] mic shortcut: {e}");
        }
    }
}

/// Called on quit: give ducked and strict-muted apps their sound back.
pub fn shutdown(app: &AppHandle) {
    let Some(g) = guard(app) else { return };
    let (ducked, muted, solo) = {
        let mut st = g.st.lock();
        (st.ducked.drain().collect::<Vec<_>>(), st.strict_muted.drain().collect::<Vec<_>>(), st.solo.take())
    };
    for (pid, v) in ducked {
        win::set_pid_volume(pid, Some(v), None, false);
    }
    for (pid, _) in muted {
        win::set_pid_volume(pid, None, Some(false), true);
    }
    if let Some((_, pids)) = solo {
        for pid in pids {
            win::set_pid_volume(pid, None, Some(false), false);
        }
    }
    *g.tx.lock() = None;
}

/// The mic-mute shortcut was pressed.
pub fn toggle_mic(app: &AppHandle) {
    let h = app.clone();
    std::thread::spawn(move || match win::mic_mute(None).and_then(|m| win::mic_mute(Some(!m))) {
        Ok(m) => {
            log(&h, "mic", "Default microphone".into(), (!m).to_string(), m.to_string(), Cause::Lastshot, if m { "muted (shortcut)" } else { "unmuted (shortcut)" });
            notify(&h, if m { "Mic muted" } else { "Mic on" }, "Lastshot's mic shortcut");
            emit(&h);
        }
        Err(e) => log::warn!("[audio-guard] mic mute: {e}"),
    });
}

pub fn is_mic_hotkey(app: &AppHandle, shortcut: &tauri_plugin_global_shortcut::Shortcut) -> bool {
    let key = app.state::<AppState>().settings.read().audio_guard.mic_mute_hotkey.clone();
    !key.is_empty() && crate::hotkeys::parse(&key).map(|s| &s == shortcut).unwrap_or(false)
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

async fn blocking<R: Send + 'static>(f: impl FnOnce() -> R + Send + 'static) -> Result<R, String> {
    tauri::async_runtime::spawn_blocking(f).await.map_err(|e| e.to_string())
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GuardView {
    pub settings: GuardSettings,
    pub status: StatusLine,
    pub pending: Vec<PendingView>,
    pub render: Vec<devices::Endpoint>,
    pub capture: Vec<devices::Endpoint>,
    pub defaults: Vec<SnapDefault>,
    pub cable_ids: Vec<String>,
    pub mic_muted: Option<bool>,
    pub error: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StatusLine {
    pub tone: &'static str,
    pub text: String,
}

fn status_line(gs: &GuardSettings, st: &GState) -> StatusLine {
    if let Some(e) = &st.error {
        return StatusLine { tone: "err", text: e.clone() };
    }
    if !gs.enabled {
        return StatusLine { tone: "info", text: "The guard is off: Windows can change your devices.".into() };
    }
    if let Some(p) = st.pending.first() {
        return StatusLine { tone: "warn", text: format!("Waiting for your answer: {}", question_text(&p.q).1) };
    }
    if let Some(exe) = st.strict_muted.values().next() {
        return StatusLine { tone: "warn", text: format!("{} is muted until it's back on its device (strict mode).", short(exe)) };
    }
    if let Some((t, text)) = &st.last_fix {
        if t.elapsed() < Duration::from_secs(120) {
            return StatusLine { tone: "ok", text: text.clone() };
        }
    }
    StatusLine { tone: "ok", text: "All audio where it should be.".into() }
}

fn view(app: &AppHandle) -> GuardView {
    let gs = settings(app);
    let (status, pending, error) = match guard(app) {
        Some(g) => {
            let st = g.st.lock();
            (
                status_line(&gs, &st),
                st.pending.iter().map(|p| PendingView { id: p.id, text: question_text(&p.q).1 }).collect(),
                st.error.clone(),
            )
        }
        None => (StatusLine { tone: "info", text: "Starting…".into() }, Vec::new(), None),
    };
    let render = devices::list_endpoints(true);
    let capture = devices::list_endpoints(false);
    let names: HashMap<&str, &str> = render.iter().chain(capture.iter()).map(|e| (e.id.as_str(), e.name.as_str())).collect();
    let defaults = devices::snapshot_defaults()
        .into_iter()
        .map(|d| SnapDefault { flow: d.flow, role: d.role, name: names.get(d.id.as_str()).map(|s| s.to_string()).unwrap_or_default(), id: d.id })
        .collect();
    GuardView {
        settings: gs,
        status,
        pending,
        defaults,
        cable_ids: cable_ids().into_iter().collect(),
        mic_muted: win::mic_mute(None).ok(),
        error,
        render,
        capture,
    }
}

#[tauri::command]
pub async fn guard_status(app: AppHandle) -> Result<GuardView, String> {
    blocking(move || view(&app)).await
}

/// Saves the guard settings (policy, strict, notifications, preferred
/// devices, ducking, the mic shortcut). Turning the guard on with no
/// preferred devices yet takes today's defaults as the preference.
#[tauri::command]
pub async fn guard_set_settings(app: AppHandle, settings_new: GuardSettings) -> Result<GuardView, String> {
    blocking(move || {
        let old = settings(&app);
        let mut gs = settings_new;
        gs.duck.amount_db = gs.duck.amount_db.clamp(3.0, 30.0);
        gs.duck.threshold_db = gs.duck.threshold_db.clamp(-80.0, 0.0);
        gs.duck.release_ms = gs.duck.release_ms.clamp(100, 5000);
        if gs.enabled && !old.enabled && gs.defaults.is_empty() {
            let names: HashMap<String, String> =
                devices::list_endpoints(true).into_iter().chain(devices::list_endpoints(false)).map(|e| (e.id, e.name)).collect();
            for d in devices::snapshot_defaults() {
                if d.role == 0 || d.role == 2 {
                    gs.defaults.push(PreferredDefault {
                        flow: d.flow,
                        comm: d.role == 2,
                        order: vec![DevicePick { name: names.get(&d.id).cloned().unwrap_or_default(), id: d.id }],
                    });
                }
            }
        }
        if gs.mic_mute_hotkey != old.mic_mute_hotkey {
            if gs.mic_mute_hotkey.is_empty() {
                if let Ok(sc) = crate::hotkeys::parse(&old.mic_mute_hotkey) {
                    use tauri_plugin_global_shortcut::GlobalShortcutExt;
                    let _ = app.global_shortcut().unregister(sc);
                }
            } else {
                crate::hotkeys::rebind(&app, &old.mic_mute_hotkey, &gs.mic_mute_hotkey)?;
            }
        }
        gs.tidy();
        auto_snapshot(&app, "Before changing the guard settings", None);
        if old.enabled != gs.enabled {
            log(&app, "guard", "Audio guard".into(), if old.enabled { "on" } else { "off" }.into(), if gs.enabled { "on" } else { "off" }.into(), Cause::Lastshot, "changed in Lastshot");
        }
        save_settings(&app, gs.clone())?;
        if gs.enabled {
            apply_preferred(&app, &gs);
        }
        emit(&app);
        Ok(view(&app))
    })
    .await?
}

/// Makes a device the Windows default now ("comm": the communications
/// role, else console + multimedia) and puts it first in the preferred list.
#[tauri::command]
pub async fn guard_set_default(app: AppHandle, flow: Flow, comm: bool, id: String) -> Result<GuardView, String> {
    blocking(move || {
        let name = active(flow).into_iter().find(|(i, _)| *i == id).map(|(_, n)| n).ok_or("That device is not connected")?;
        auto_snapshot(&app, "Before changing a default device", None);
        let roles: &[Role] = if comm { &[2] } else { &[0, 1] };
        let from = devices::snapshot_defaults().into_iter().find(|d| d.flow == flow && d.role == roles[0]).map(|d| d.id).unwrap_or_default();
        set_default(&app, flow, roles, &id)?;
        let mut gs = settings(&app);
        let pick = DevicePick { id: id.clone(), name: name.clone() };
        match gs.defaults.iter_mut().find(|d| d.flow == flow && d.comm == comm) {
            Some(d) => {
                d.order.retain(|x| x.id != id);
                d.order.insert(0, pick);
            }
            None => gs.defaults.push(PreferredDefault { flow, comm, order: vec![pick] }),
        }
        save_settings(&app, gs)?;
        log(&app, "default", format!("Default {} device{}", flow_name(flow), if comm { " (communications)" } else { "" }), name_of(&from), name, Cause::Lastshot, "changed in Lastshot");
        emit(&app);
        Ok(view(&app))
    })
    .await?
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AppView {
    pub exe: String,
    pub pids: Vec<u32>,
    pub playing: bool,
    pub recording: bool,
    pub volume: f32,
    pub mute: bool,
    pub peak: f32,
    /// Where its sound goes / comes from now.
    pub output_now: Option<String>,
    pub input_now: Option<String>,
    pub output: Option<DevicePick>,
    pub input: Option<DevicePick>,
    pub pref: Option<AppPref>,
    pub solo: bool,
}

/// Running apps with sound, with live volume, mute and level.
#[tauri::command]
pub async fn guard_apps(app: AppHandle) -> Result<Vec<AppView>, String> {
    blocking(move || {
        let gs = settings(&app);
        let solo = guard(&app).and_then(|g| g.st.lock().solo.as_ref().map(|s| s.0.clone()));
        let me = std::process::id();
        let mut by: Vec<AppView> = Vec::new();
        for s in win::sessions(true).into_iter().filter(|s| s.pid != me) {
            let i = match by.iter().position(|a| a.exe.eq_ignore_ascii_case(&s.exe)) {
                Some(i) => i,
                None => {
                    by.push(AppView {
                        exe: s.exe.clone(),
                        pids: Vec::new(),
                        playing: false,
                        recording: false,
                        volume: 1.0,
                        mute: false,
                        peak: 0.0,
                        output_now: None,
                        input_now: None,
                        output: wanted_output(&app, &s.exe),
                        input: gs.app(&s.exe).and_then(|a| a.input.clone()),
                        pref: gs.app(&s.exe).cloned(),
                        solo: solo.as_deref().is_some_and(|x| x.eq_ignore_ascii_case(&s.exe)),
                    });
                    by.len() - 1
                }
            };
            let a = &mut by[i];
            if !a.pids.contains(&s.pid) {
                a.pids.push(s.pid);
            }
            if s.render {
                a.playing |= s.active;
                a.volume = s.volume;
                a.mute = s.mute;
                a.peak = a.peak.max(s.peak);
                if s.active || a.output_now.is_none() {
                    a.output_now = Some(s.device_id.clone());
                }
            } else {
                a.recording |= s.active;
                if s.active || a.input_now.is_none() {
                    a.input_now = Some(s.device_id.clone());
                }
            }
        }
        by.sort_by_key(|a| a.exe.to_lowercase());
        by
    })
    .await
}

/// Sets an app's microphone (Some = that device, None = Windows default).
#[tauri::command]
pub async fn guard_set_app_input(app: AppHandle, exe: String, device: Option<DevicePick>) -> Result<(), String> {
    blocking(move || {
        if !crate::audio_routing::valid_exe(&exe) {
            return Err(format!("Not an app name: {exe}"));
        }
        auto_snapshot(&app, &format!("Before changing {}'s microphone", short(&exe)), None);
        let mut gs = settings(&app);
        let from = gs.app(&exe).and_then(|a| a.input.clone());
        gs.app_mut(&exe).input = device.clone();
        gs.tidy();
        save_settings(&app, gs)?;
        let pids: Vec<u32> = app_output::processes().into_iter().filter(|(_, e)| e.eq_ignore_ascii_case(&exe)).map(|(p, _)| p).collect();
        let mut last = Ok(());
        for p in &pids {
            last = set_app_device(&app, *p, false, device.as_ref().map(|d| d.id.as_str()));
            if let Some(g) = guard(&app) {
                g.st.lock().applied_input.insert(*p);
            }
        }
        let l = |d: &Option<DevicePick>| d.as_ref().map(|d| d.name.clone()).unwrap_or_else(|| "Windows' default".into());
        log(&app, "app-input", short(&exe).to_string(), l(&from), l(&device), Cause::Lastshot, "changed in Lastshot");
        emit(&app);
        last
    })
    .await?
}

/// Sets an app's volume and/or mute now; `remember` keeps it for next time.
#[tauri::command]
pub async fn guard_set_app_volume(app: AppHandle, exe: String, volume: Option<f32>, mute: Option<bool>, remember: bool) -> Result<u32, String> {
    blocking(move || {
        let volume = volume.map(|v| v.clamp(0.0, 1.0));
        if mute.is_some() || remember {
            auto_snapshot(&app, &format!("Before changing {}'s volume", short(&exe)), None);
        }
        let n = win::set_app_volume(&exe, volume, mute);
        if remember {
            let mut gs = settings(&app);
            let p = gs.app_mut(&exe);
            if volume.is_some() {
                p.volume = volume;
            }
            if mute.is_some() {
                p.mute = mute;
            }
            save_settings(&app, gs)?;
        }
        if let Some(m) = mute {
            log(&app, "app-volume", short(&exe).to_string(), (!m).then_some("muted").unwrap_or("not muted").into(), m.then_some("muted").unwrap_or("not muted").into(), Cause::Lastshot, "changed in Lastshot");
        }
        Ok(n)
    })
    .await?
}

/// Per-app options kept by the guard (policy override, never-duck).
#[tauri::command]
pub async fn guard_set_app_options(app: AppHandle, exe: String, policy: Option<Policy>, no_duck: bool, forget_volume: bool) -> Result<GuardView, String> {
    blocking(move || {
        let mut gs = settings(&app);
        let p = gs.app_mut(&exe);
        p.policy = policy;
        p.no_duck = no_duck;
        if forget_volume {
            p.volume = None;
            p.mute = None;
        }
        gs.tidy();
        save_settings(&app, gs)?;
        Ok(view(&app))
    })
    .await?
}

/// Solo: hear only `exe` (every other app muted); None undoes it.
#[tauri::command]
pub async fn guard_solo(app: AppHandle, exe: Option<String>) -> Result<(), String> {
    blocking(move || {
        let g = guard(&app).ok_or("Not ready")?;
        let prev = g.st.lock().solo.take();
        if let Some((_, pids)) = prev {
            for pid in pids {
                win::set_pid_volume(pid, None, Some(false), false);
            }
        }
        if let Some(exe) = exe {
            let me = std::process::id();
            let mut muted = Vec::new();
            for s in win::sessions(false).into_iter().filter(|s| s.render && !s.mute && s.pid != me && !s.exe.eq_ignore_ascii_case(&exe)) {
                if win::set_pid_volume(s.pid, None, Some(true), false) > 0 && !muted.contains(&s.pid) {
                    muted.push(s.pid);
                }
            }
            g.st.lock().solo = Some((exe, muted));
        }
        emit(&app);
        Ok(())
    })
    .await?
}

#[tauri::command]
pub async fn guard_answer(app: AppHandle, id: u64, choice: String) -> Result<GuardView, String> {
    blocking(move || {
        answer(&app, id, &choice)?;
        Ok(view(&app))
    })
    .await?
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Levels {
    pub output: f32,
    pub mic: f32,
}

/// Default output and microphone levels (for the bus meters).
#[tauri::command]
pub fn guard_levels() -> Levels {
    let (output, mic) = win::device_peaks();
    Levels { output, mic }
}

#[tauri::command]
pub async fn guard_mic_mute(app: AppHandle, mute: bool) -> Result<bool, String> {
    blocking(move || {
        let m = win::mic_mute(Some(mute))?;
        log(&app, "mic", "Default microphone".into(), (!m).to_string(), m.to_string(), Cause::Lastshot, "changed in Lastshot");
        emit(&app);
        Ok(m)
    })
    .await?
}

#[tauri::command]
pub async fn guard_log(app: AppHandle, limit: Option<usize>) -> Result<Vec<LogEntry>, String> {
    blocking(move || guard(&app).map(|g| g.store.read_log(limit.unwrap_or(500).min(5000))).unwrap_or_default()).await
}

#[tauri::command]
pub async fn guard_export_log(app: AppHandle, path: String) -> Result<usize, String> {
    blocking(move || {
        let p = store::check_user_path(&path, &["jsonl", "json", "txt"])?;
        guard(&app).ok_or("Not ready")?.store.export_log(&p)
    })
    .await?
}

#[tauri::command]
pub async fn guard_snapshots(app: AppHandle) -> Result<Vec<SnapshotMeta>, String> {
    blocking(move || guard(&app).map(|g| g.store.list()).unwrap_or_default()).await
}

/// Saves the setup now, under a name (a scene) or as an automatic one.
#[tauri::command]
pub async fn guard_snapshot_take(app: AppHandle, name: Option<String>) -> Result<SnapshotMeta, String> {
    blocking(move || {
        let g = guard(&app).ok_or("Not ready")?;
        let name = name.map(|n| clean_snapshot_name(&n)).transpose()?;
        let mut s = live_snapshot(&app, if name.is_some() { "Saved by you" } else { "Taken by you" }, None);
        s.id = g.store.new_id(name.is_some());
        s.name = name;
        g.store.save(&s)?;
        log(&app, "snapshot", s.name.clone().unwrap_or_else(|| "Snapshot".into()), String::new(), String::new(), Cause::Lastshot, "saved");
        Ok(SnapshotMeta { id: s.id, name: s.name, time: s.time, reason: s.reason })
    })
    .await?
}

/// What restoring a snapshot would change.
#[tauri::command]
pub async fn guard_snapshot_preview(app: AppHandle, id: String) -> Result<Vec<Change>, String> {
    blocking(move || {
        let g = guard(&app).ok_or("Not ready")?;
        let to = g.store.load(&id)?;
        Ok(diff(&live_snapshot(&app, "", None), &to))
    })
    .await?
}

/// Restores a snapshot (after saving the current setup, so it can be undone).
#[tauri::command]
pub async fn guard_snapshot_restore(app: AppHandle, id: String) -> Result<Vec<Change>, String> {
    blocking(move || restore_snapshot(&app, &id)).await?
}

fn restore_snapshot(app: &AppHandle, id: &str) -> Result<Vec<Change>, String> {
    let g = guard(app).ok_or("Not ready")?;
    let to = g.store.load(id)?;
    let label = to.name.clone().unwrap_or_else(|| "a snapshot".into());
    let before = live_snapshot(app, &format!("Before restoring {label}"), None);
    let changes = diff(&before, &to);
    // Always keep the way back, even when nothing seems to change.
    let mut b = before.clone();
    b.id = g.store.new_id(false);
    g.store.save(&b)?;
    let mut errors = Vec::new();
    // Settings first (the guard then holds what is restored).
    {
        let state = app.state::<AppState>();
        let mut s = state.settings.read().clone();
        // The guard's remembered choices (microphones, volumes, policies)
        // and the "Send to" rules come back exactly as they were; apps that
        // were only running at the time get no new rule.
        if let Some(gs) = &to.guard {
            s.audio_guard = gs.clone();
        }
        s.app_outputs = to
            .apps
            .iter()
            .filter(|a| a.ruled)
            .filter_map(|a| {
                a.output.as_ref().map(|d| crate::audio_routing::AppOutputRule {
                    exe: a.exe.clone(),
                    device_id: d.id.clone(),
                    device_name: d.name.clone(),
                })
            })
            .collect();
        s.audio_guard.tidy();
        let cables_changed = to.cables.clone().filter(|c| *c != s.cables);
        if let Some(c) = &cables_changed {
            s.cables = c.clone();
        }
        s.save()?;
        *state.settings.write() = s;
        if cables_changed.is_some() {
            let h = app.clone();
            std::thread::spawn(move || {
                if let Some(c) = CABLE_HOOKS.get() {
                    c.reload(&h);
                }
            });
        }
    }
    // Defaults.
    let (act_r, act_c) = (active(0), active(1));
    for d in &to.defaults {
        let acts = if d.flow == 0 { &act_r } else { &act_c };
        let pick = DevicePick { id: d.id.clone(), name: d.name.clone() };
        let Some((_, id)) = pick_connected(std::slice::from_ref(&pick), acts) else {
            errors.push(format!("{} is not connected", if d.name.is_empty() { "A device" } else { &d.name }));
            continue;
        };
        if before.defaults.iter().any(|b| b.flow == d.flow && b.role == d.role && b.id == id) {
            continue;
        }
        if let Err(e) = set_default(app, d.flow, &[d.role], &id) {
            errors.push(e);
        }
    }
    // Running apps: only what differs from now (never touch the rest).
    let procs = app_output::processes();
    for a in &to.apps {
        let empty = SnapApp::default();
        let cur = before.apps.iter().find(|b| b.exe.eq_ignore_ascii_case(&a.exe)).unwrap_or(&empty);
        let id = |d: &Option<DevicePick>| d.as_ref().map(|d| d.id.clone());
        let out_differs = id(&a.output) != id(&cur.output);
        let in_differs = id(&a.input) != id(&cur.input);
        let vol = a.volume.filter(|v| cur.volume.map(|c| (c - v).abs() > 0.005).unwrap_or(true));
        let mute = a.mute.filter(|m| cur.mute != Some(*m));
        for (pid, _) in procs.iter().filter(|(_, e)| e.eq_ignore_ascii_case(&a.exe)) {
            if out_differs {
                let _ = set_app_device(app, *pid, true, a.output.as_ref().map(|d| d.id.as_str()));
            }
            if in_differs {
                let _ = set_app_device(app, *pid, false, a.input.as_ref().map(|d| d.id.as_str()));
            }
            if vol.is_some() || mute.is_some() {
                win::set_pid_volume(*pid, vol, mute, false);
            }
        }
    }
    log(app, "snapshot", label.clone(), String::new(), format!("{} change(s)", changes.len()), Cause::Restore, if errors.is_empty() { "restored" } else { "restored in part" });
    fixed(app, format!("Restored {label}"));
    emit(app);
    if errors.is_empty() {
        Ok(changes)
    } else {
        Err(format!("Restored, except: {}", errors.join("; ")))
    }
}

#[tauri::command]
pub async fn guard_snapshot_delete(app: AppHandle, id: String) -> Result<(), String> {
    blocking(move || guard(&app).ok_or("Not ready")?.store.delete(&id)).await?
}

#[tauri::command]
pub async fn guard_snapshot_rename(app: AppHandle, id: String, name: String) -> Result<(), String> {
    blocking(move || {
        let g = guard(&app).ok_or("Not ready")?;
        let mut s = g.store.load(&id)?;
        s.name = Some(clean_snapshot_name(&name)?);
        g.store.save(&s)
    })
    .await?
}

#[tauri::command]
pub async fn guard_snapshot_export(app: AppHandle, id: String, path: String) -> Result<(), String> {
    blocking(move || {
        let p = store::check_user_path(&path, &["json"])?;
        let s = guard(&app).ok_or("Not ready")?.store.load(&id)?;
        std::fs::write(p, serde_json::to_vec_pretty(&s).map_err(|e| e.to_string())?).map_err(|e| e.to_string())
    })
    .await?
}

#[tauri::command]
pub async fn guard_snapshot_import(app: AppHandle, path: String) -> Result<SnapshotMeta, String> {
    blocking(move || {
        let p = store::check_user_path(&path, &["json"])?;
        if std::fs::metadata(&p).map(|m| m.len()).unwrap_or(0) > 4 * 1024 * 1024 {
            return Err("That file is too big to be a Lastshot snapshot".into());
        }
        let b = std::fs::read(&p).map_err(|e| e.to_string())?;
        let mut s = serde_json::from_slice::<Snapshot>(&b).map_err(|_| "That file is not a Lastshot audio snapshot".to_string())?;
        let g = guard(&app).ok_or("Not ready")?;
        s.id = g.store.new_id(true);
        s.name = Some(clean_snapshot_name(s.name.as_deref().unwrap_or("Imported"))?);
        g.store.save(&s)?;
        Ok(SnapshotMeta { id: s.id, name: s.name, time: s.time, reason: "Imported".into() })
    })
    .await?
}
