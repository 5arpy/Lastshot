//! On-disk parts of the Audio guard: snapshot files and the change log.
//!
//! `<app data>/audio-guard/snapshots/<id>.json` and
//! `<app data>/audio-guard/log.jsonl` (rotated to `log.1.jsonl` at 1 MB).

use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};

use serde::Serialize;

use super::model::*;

pub struct Store {
    dir: PathBuf,
}

/// A snapshot without its contents, for the list.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SnapshotMeta {
    pub id: String,
    pub name: Option<String>,
    pub time: u64,
    pub reason: String,
}

pub fn now_ms() -> u64 {
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_millis() as u64).unwrap_or(0)
}

impl Store {
    pub fn new(dir: PathBuf) -> Self {
        let _ = fs::create_dir_all(dir.join("snapshots"));
        Self { dir }
    }

    fn snap_path(&self, id: &str) -> Option<PathBuf> {
        valid_snapshot_id(id).then(|| self.dir.join("snapshots").join(format!("{id}.json")))
    }

    pub fn new_id(&self, named: bool) -> String {
        let t = now_ms();
        let mut n = 0u32;
        loop {
            let id = format!("{}-{t}-{n}", if named { "scene" } else { "auto" });
            if !self.dir.join("snapshots").join(format!("{id}.json")).exists() {
                return id;
            }
            n += 1;
        }
    }

    pub fn save(&self, s: &Snapshot) -> Result<(), String> {
        let p = self.snap_path(&s.id).ok_or("Bad snapshot id")?;
        let tmp = p.with_extension("tmp");
        fs::write(&tmp, serde_json::to_vec_pretty(s).map_err(|e| e.to_string())?).map_err(|e| e.to_string())?;
        fs::rename(&tmp, &p).map_err(|e| e.to_string())
    }

    pub fn load(&self, id: &str) -> Result<Snapshot, String> {
        let p = self.snap_path(id).ok_or("Bad snapshot id")?;
        let b = fs::read(&p).map_err(|_| "That snapshot is gone".to_string())?;
        serde_json::from_slice(&b).map_err(|e| format!("That snapshot can't be read: {e}"))
    }

    pub fn delete(&self, id: &str) -> Result<(), String> {
        let p = self.snap_path(id).ok_or("Bad snapshot id")?;
        fs::remove_file(p).map_err(|e| e.to_string())
    }

    pub fn list(&self) -> Vec<SnapshotMeta> {
        let mut out = Vec::new();
        let Ok(rd) = fs::read_dir(self.dir.join("snapshots")) else { return out };
        for e in rd.flatten() {
            let p = e.path();
            if p.extension().and_then(|x| x.to_str()) != Some("json") {
                continue;
            }
            if let Some(s) = fs::read(&p).ok().and_then(|b| serde_json::from_slice::<Snapshot>(&b).ok()) {
                out.push(SnapshotMeta { id: s.id, name: s.name, time: s.time, reason: s.reason });
            }
        }
        out.sort_by_key(|a| std::cmp::Reverse(a.time));
        out
    }

    /// Newest automatic snapshot.
    pub fn latest_auto(&self) -> Option<Snapshot> {
        self.list().into_iter().find(|m| m.name.is_none()).and_then(|m| self.load(&m.id).ok())
    }

    /// Saves an automatic snapshot unless nothing changed since the last
    /// one, then prunes. Returns the id when one was written.
    pub fn auto(&self, mut s: Snapshot) -> Option<String> {
        if let Some(last) = self.latest_auto() {
            if last.defaults == s.defaults && last.apps == s.apps && last.cables == s.cables && last.guard == s.guard {
                return None;
            }
        }
        s.id = self.new_id(false);
        s.name = None;
        let id = s.id.clone();
        if let Err(e) = self.save(&s) {
            log::warn!("[audio-guard] snapshot not saved: {e}");
            return None;
        }
        let all: Vec<(String, u64, bool)> = self.list().into_iter().map(|m| (m.id, m.time, m.name.is_some())).collect();
        for gone in prune(&all, now_ms(), AUTO_KEEP, AUTO_MAX_AGE_MS) {
            let _ = self.delete(&gone);
        }
        Some(id)
    }

    // -- log --

    fn log_path(&self) -> PathBuf {
        self.dir.join("log.jsonl")
    }

    pub fn log(&self, e: &LogEntry) {
        let p = self.log_path();
        // The size from the open file (a directory listing can lag on Windows).
        let size = fs::File::open(&p).and_then(|f| f.metadata()).map(|m| m.len()).unwrap_or(0);
        if size > LOG_MAX_BYTES {
            let old = self.dir.join("log.1.jsonl");
            let _ = fs::remove_file(&old);
            if let Err(e) = fs::rename(&p, &old) {
                // Something (a virus scanner) may hold the file: copy, then empty it.
                log::debug!("[audio-guard] log rotate by rename failed: {e}");
                if fs::copy(&p, &old).is_ok() {
                    let _ = fs::File::create(&p);
                }
            }
        }
        if let (Ok(mut f), Ok(line)) = (fs::OpenOptions::new().create(true).append(true).open(&p), serde_json::to_string(e)) {
            let _ = writeln!(f, "{line}");
        }
    }

    /// Newest first, both files.
    pub fn read_log(&self, n: usize) -> Vec<LogEntry> {
        let old = fs::read_to_string(self.dir.join("log.1.jsonl")).unwrap_or_default();
        let cur = fs::read_to_string(self.log_path()).unwrap_or_default();
        parse_log(&format!("{old}{cur}"), n)
    }

    pub fn export_log(&self, to: &Path) -> Result<usize, String> {
        let entries = self.read_log(usize::MAX);
        let text: String = entries.iter().rev().filter_map(|e| serde_json::to_string(e).ok()).map(|l| l + "\n").collect();
        fs::write(to, text).map_err(|e| e.to_string())?;
        Ok(entries.len())
    }
}

/// Only plain .json / .jsonl files chosen by the user.
pub fn check_user_path(p: &str, exts: &[&str]) -> Result<PathBuf, String> {
    let path = PathBuf::from(p);
    let ext = path.extension().and_then(|x| x.to_str()).unwrap_or("").to_ascii_lowercase();
    if !path.is_absolute() || !exts.contains(&ext.as_str()) {
        return Err(format!("Pick a .{} file", exts[0]));
    }
    Ok(path)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tmp() -> PathBuf {
        // Tests run in parallel: the counter keeps two tests started in the
        // same millisecond out of each other's folder.
        static N: std::sync::atomic::AtomicU32 = std::sync::atomic::AtomicU32::new(0);
        let n = N.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
        let d = std::env::temp_dir().join(format!("lastshot-guard-test-{}-{}-{n}", std::process::id(), now_ms()));
        let _ = fs::remove_dir_all(&d);
        d
    }

    fn snap(id: &str) -> Snapshot {
        Snapshot { id: id.into(), name: None, time: now_ms(), reason: "test".into(), defaults: vec![], apps: vec![], cables: None, guard: None }
    }

    #[test]
    fn snapshots_round_trip_and_dedupe() {
        let d = tmp();
        let st = Store::new(d.clone());
        let a = st.auto(snap("x")).expect("first is saved");
        assert!(st.auto(snap("y")).is_none(), "identical setup is not saved twice");
        let mut changed = snap("z");
        changed.defaults.push(SnapDefault { flow: 0, role: 0, id: "d".into(), name: "D".into() });
        let b = st.auto(changed).unwrap();
        assert_ne!(a, b);
        let mut named = snap("");
        named.id = st.new_id(true);
        named.name = Some("Gaming".into());
        st.save(&named).unwrap();
        let list = st.list();
        assert_eq!(list.len(), 3);
        assert_eq!(st.load(&named.id).unwrap().name.as_deref(), Some("Gaming"));
        assert!(st.load("../../etc").is_err());
        st.delete(&a).unwrap();
        assert_eq!(st.list().len(), 2);
        let _ = fs::remove_dir_all(d);
    }

    #[test]
    fn log_rotates() {
        let d = tmp();
        let st = Store::new(d.clone());
        let e = LogEntry { time: 1, kind: "default".into(), what: "x".repeat(8000), from: "a".into(), to: "b".into(), who: Cause::User, action: "logged".into() };
        for _ in 0..160 {
            st.log(&e);
        }
        assert!(d.join("log.1.jsonl").exists());
        assert!(fs::metadata(d.join("log.jsonl")).unwrap().len() <= LOG_MAX_BYTES + 9000);
        assert_eq!(st.read_log(5).len(), 5);
        let out = d.join("export.jsonl");
        assert!(st.export_log(&out).unwrap() > 130);
        let _ = fs::remove_dir_all(d);
    }

    #[test]
    fn user_paths() {
        assert!(check_user_path(r"C:\x\a.json", &["json"]).is_ok());
        assert!(check_user_path(r"C:\x\a.exe", &["json"]).is_err());
        assert!(check_user_path("a.json", &["json"]).is_err());
    }
}
