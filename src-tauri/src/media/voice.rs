//! "Clean up my voice" for the microphone, and the sound meters.
//!
//! The voice chain is small and runs on the audio thread, per 48 kHz stereo
//! block, in this order:
//! 1. low cut at 80 Hz (rumble, desk knocks, fan hum);
//! 2. noise gate: quiet background between words is turned down (not cut
//!    off hard, so it never sounds choppy);
//! 3. compressor: loud and quiet speech end up closer together;
//! 4. limiter: never clips.
//!
//! Meters keep the loudest sample since the last read, per source.

use std::sync::atomic::{AtomicBool, AtomicU32, Ordering};

pub const RATE: f32 = 48_000.0;

static CLEAN_VOICE: AtomicBool = AtomicBool::new(false);
static PEAK_GAME: AtomicU32 = AtomicU32::new(0);
static PEAK_MIC: AtomicU32 = AtomicU32::new(0);

pub fn set_clean_voice(on: bool) {
    CLEAN_VOICE.store(on, Ordering::Release);
}

pub fn clean_voice() -> bool {
    CLEAN_VOICE.load(Ordering::Acquire)
}

fn bump(slot: &AtomicU32, samples: &[f32]) {
    let peak = samples.iter().fold(0.0f32, |m, s| m.max(s.abs()));
    if peak <= 0.0 {
        return;
    }
    let mut old = slot.load(Ordering::Acquire);
    while peak > f32::from_bits(old) {
        match slot.compare_exchange_weak(old, peak.to_bits(), Ordering::AcqRel, Ordering::Acquire) {
            Ok(_) => break,
            Err(v) => old = v,
        }
    }
}

/// Records the loudest sample of freshly captured PC sound / microphone audio
/// (after the volume sliders and the voice chain).
pub fn meter_game(samples: &[f32]) {
    bump(&PEAK_GAME, samples);
}
pub fn meter_mic(samples: &[f32]) {
    bump(&PEAK_MIC, samples);
}

/// Loudest level per source since the last call, in dBFS (-100 = silence).
#[derive(Debug, Clone, Copy, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Levels {
    pub game_db: f32,
    pub mic_db: f32,
}

fn to_db(v: f32) -> f32 {
    if v <= 0.00001 {
        -100.0
    } else {
        (20.0 * v.log10()).max(-100.0)
    }
}

pub fn take_levels() -> Levels {
    Levels {
        game_db: to_db(f32::from_bits(PEAK_GAME.swap(0, Ordering::AcqRel))),
        mic_db: to_db(f32::from_bits(PEAK_MIC.swap(0, Ordering::AcqRel))),
    }
}

#[tauri::command]
pub fn get_audio_levels() -> Levels {
    take_levels()
}

fn coef(ms: f32) -> f32 {
    (-1.0 / (ms * 0.001 * RATE)).exp()
}
fn db(v: f32) -> f32 {
    10f32.powf(v / 20.0)
}

/// Second-order high-pass (RBJ cookbook), one state per channel.
#[derive(Clone)]
struct HighPass {
    b0: f32,
    b1: f32,
    b2: f32,
    a1: f32,
    a2: f32,
    s: [[f32; 4]; 2],
}

impl HighPass {
    fn new(freq: f32) -> Self {
        let w = 2.0 * std::f32::consts::PI * freq / RATE;
        let alpha = w.sin() / (2.0 * std::f32::consts::FRAC_1_SQRT_2);
        let cos = w.cos();
        let a0 = 1.0 + alpha;
        Self {
            b0: (1.0 + cos) / 2.0 / a0,
            b1: -(1.0 + cos) / a0,
            b2: (1.0 + cos) / 2.0 / a0,
            a1: -2.0 * cos / a0,
            a2: (1.0 - alpha) / a0,
            s: [[0.0; 4]; 2],
        }
    }
    #[inline]
    fn run(&mut self, ch: usize, x: f32) -> f32 {
        let [x1, x2, y1, y2] = self.s[ch];
        let y = self.b0 * x + self.b1 * x1 + self.b2 * x2 - self.a1 * y1 - self.a2 * y2;
        self.s[ch] = [x, x1, y, y1];
        y
    }
}

/// The microphone chain. Keep one per audio thread; feed it every block.
pub struct VoiceChain {
    hp: HighPass,
    // gate
    gate_env: f32,
    gate_gain: f32,
    gate_open: bool,
    hold_left: u32,
    // compressor
    comp_env: f32,
    // limiter
    lim_gain: f32,
}

const GATE_OPEN_DB: f32 = -46.0;
const GATE_CLOSE_DB: f32 = -52.0;
const GATE_FLOOR: f32 = 0.06; // about -24 dB
const GATE_HOLD_MS: f32 = 180.0;
const COMP_THRESHOLD_DB: f32 = -22.0;
const COMP_RATIO: f32 = 3.0;
const COMP_MAKEUP_DB: f32 = 5.0;
const LIMIT: f32 = 0.89; // -1 dBFS

impl Default for VoiceChain {
    fn default() -> Self {
        Self::new()
    }
}

impl VoiceChain {
    pub fn new() -> Self {
        Self {
            hp: HighPass::new(80.0),
            gate_env: 0.0,
            gate_gain: GATE_FLOOR,
            gate_open: false,
            hold_left: 0,
            comp_env: 0.0,
            lim_gain: 1.0,
        }
    }

    /// Processes interleaved stereo samples in place.
    pub fn process(&mut self, buf: &mut [f32]) {
        let (env_att, env_rel) = (coef(1.0), coef(120.0));
        let (g_att, g_rel) = (coef(3.0), coef(90.0));
        let (c_att, c_rel) = (coef(6.0), coef(150.0));
        let lim_rel = coef(60.0);
        let open = db(GATE_OPEN_DB);
        let close = db(GATE_CLOSE_DB);
        let hold = (GATE_HOLD_MS * 0.001 * RATE) as u32;
        let thr = db(COMP_THRESHOLD_DB);
        let makeup = db(COMP_MAKEUP_DB);

        for fr in buf.chunks_exact_mut(2) {
            let l = self.hp.run(0, fr[0]);
            let r = self.hp.run(1, fr[1]);
            let level = l.abs().max(r.abs());

            // Gate: fast-rising, slow-falling envelope with hysteresis + hold.
            let k = if level > self.gate_env { env_att } else { env_rel };
            self.gate_env = level + k * (self.gate_env - level);
            if self.gate_env > open {
                self.gate_open = true;
                self.hold_left = hold;
            } else if self.gate_env < close {
                if self.hold_left > 0 {
                    self.hold_left -= 1;
                } else {
                    self.gate_open = false;
                }
            }
            let target = if self.gate_open { 1.0 } else { GATE_FLOOR };
            let k = if target > self.gate_gain { g_att } else { g_rel };
            self.gate_gain = target + k * (self.gate_gain - target);

            // Compressor on the gated signal.
            let (l, r) = (l * self.gate_gain, r * self.gate_gain);
            let level = l.abs().max(r.abs());
            let k = if level > self.comp_env { c_att } else { c_rel };
            self.comp_env = level + k * (self.comp_env - level);
            let comp = if self.comp_env > thr {
                (thr / self.comp_env).powf(1.0 - 1.0 / COMP_RATIO)
            } else {
                1.0
            };
            let (l, r) = (l * comp * makeup, r * comp * makeup);

            // Limiter: instant attack, smooth release.
            let peak = l.abs().max(r.abs());
            let want = if peak * self.lim_gain > LIMIT { LIMIT / peak } else { 1.0 };
            self.lim_gain = if want < self.lim_gain { want } else { want + lim_rel * (self.lim_gain - want) };
            fr[0] = (l * self.lim_gain).clamp(-LIMIT, LIMIT);
            fr[1] = (r * self.lim_gain).clamp(-LIMIT, LIMIT);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tone(freq: f32, amp: f32, secs: f32) -> Vec<f32> {
        let n = (secs * RATE) as usize;
        let mut v = Vec::with_capacity(n * 2);
        for i in 0..n {
            let s = amp * (2.0 * std::f32::consts::PI * freq * i as f32 / RATE).sin();
            v.push(s);
            v.push(s);
        }
        v
    }
    fn peak(v: &[f32]) -> f32 {
        v.iter().fold(0.0f32, |m, s| m.max(s.abs()))
    }
    fn run(v: &mut [f32]) {
        let mut c = VoiceChain::new();
        // Feed in audio-thread sized blocks (10 ms).
        for b in v.chunks_mut(960) {
            c.process(b);
        }
    }

    #[test]
    fn quiet_background_is_turned_down() {
        let mut v = tone(1000.0, db(-60.0), 1.0);
        run(&mut v);
        let tail = &v[v.len() / 2..];
        // About 19 dB lower (gate floor -24 dB, then the +5 dB make-up).
        assert!(to_db(peak(tail)) < -76.0, "background {}", to_db(peak(tail)));
    }

    #[test]
    fn speech_level_passes_and_loud_is_evened_out() {
        let mut talk = tone(300.0, db(-30.0), 1.0);
        run(&mut talk);
        let t = to_db(peak(&talk[talk.len() / 2..]));
        assert!((t - -25.0).abs() < 3.0, "speech level {t}");
        let mut loud = tone(300.0, db(-6.0), 1.0);
        run(&mut loud);
        let l = to_db(peak(&loud[loud.len() / 2..]));
        // 24 dB apart going in, much closer coming out, never over -1 dBFS.
        assert!(l - t < 14.0 && l <= -0.9, "loud {l} vs speech {t}");
    }

    #[test]
    fn low_rumble_is_cut() {
        let mut v = tone(30.0, db(-30.0), 1.0);
        run(&mut v);
        let mut ref_ = tone(1000.0, db(-30.0), 1.0);
        run(&mut ref_);
        let a = to_db(peak(&v[v.len() / 2..]));
        let b = to_db(peak(&ref_[ref_.len() / 2..]));
        assert!(b - a > 12.0, "30 Hz {a} dB vs 1 kHz {b} dB");
    }

    #[test]
    fn meters_report_and_reset() {
        let _ = take_levels();
        meter_game(&[0.0, 0.5, -0.25]);
        meter_mic(&[]);
        let l = take_levels();
        assert!((l.game_db - -6.02).abs() < 0.1, "{l:?}");
        assert_eq!(l.mic_db, -100.0);
        assert_eq!(take_levels().game_db, -100.0);
    }
}
