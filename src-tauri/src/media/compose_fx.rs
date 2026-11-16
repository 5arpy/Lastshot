//! Sound effects for the editor mix, per audio piece: noise gate, 3-band EQ
//! (the preview's Web Audio biquads: low shelf 200 Hz, peaking 1 kHz Q 0.8,
//! high shelf 5 kHz) and pan (Web Audio's StereoPannerNode rule). Plus the
//! waveform peaks and the WAV header used by the editor's audio commands.

use std::f64::consts::PI;

/// RBJ cookbook biquad, transposed direct form II, stereo state.
#[derive(Debug, Clone)]
pub struct Biquad {
    b0: f64,
    b1: f64,
    b2: f64,
    a1: f64,
    a2: f64,
    z1: [f64; 2],
    z2: [f64; 2],
}

impl Biquad {
    fn norm(b0: f64, b1: f64, b2: f64, a0: f64, a1: f64, a2: f64) -> Biquad {
        Biquad { b0: b0 / a0, b1: b1 / a0, b2: b2 / a0, a1: a1 / a0, a2: a2 / a0, z1: [0.0; 2], z2: [0.0; 2] }
    }

    /// Shelf slope S = 1 (what Web Audio uses).
    pub fn low_shelf(f0: f64, db: f64, fs: f64) -> Biquad {
        let a = 10f64.powf(db / 40.0);
        let w0 = 2.0 * PI * f0 / fs;
        let (sn, cs) = w0.sin_cos();
        let alpha = sn / 2.0 * 2f64.sqrt();
        let sa = 2.0 * a.sqrt() * alpha;
        Biquad::norm(
            a * ((a + 1.0) - (a - 1.0) * cs + sa),
            2.0 * a * ((a - 1.0) - (a + 1.0) * cs),
            a * ((a + 1.0) - (a - 1.0) * cs - sa),
            (a + 1.0) + (a - 1.0) * cs + sa,
            -2.0 * ((a - 1.0) + (a + 1.0) * cs),
            (a + 1.0) + (a - 1.0) * cs - sa,
        )
    }

    pub fn high_shelf(f0: f64, db: f64, fs: f64) -> Biquad {
        let a = 10f64.powf(db / 40.0);
        let w0 = 2.0 * PI * f0 / fs;
        let (sn, cs) = w0.sin_cos();
        let alpha = sn / 2.0 * 2f64.sqrt();
        let sa = 2.0 * a.sqrt() * alpha;
        Biquad::norm(
            a * ((a + 1.0) + (a - 1.0) * cs + sa),
            -2.0 * a * ((a - 1.0) + (a + 1.0) * cs),
            a * ((a + 1.0) + (a - 1.0) * cs - sa),
            (a + 1.0) - (a - 1.0) * cs + sa,
            2.0 * ((a - 1.0) - (a + 1.0) * cs),
            (a + 1.0) - (a - 1.0) * cs - sa,
        )
    }

    pub fn peaking(f0: f64, q: f64, db: f64, fs: f64) -> Biquad {
        let a = 10f64.powf(db / 40.0);
        let w0 = 2.0 * PI * f0 / fs;
        let (sn, cs) = w0.sin_cos();
        let alpha = sn / (2.0 * q);
        Biquad::norm(1.0 + alpha * a, -2.0 * cs, 1.0 - alpha * a, 1.0 + alpha / a, -2.0 * cs, 1.0 - alpha / a)
    }

    #[inline]
    pub fn process(&mut self, ch: usize, x: f64) -> f64 {
        let y = self.b0 * x + self.z1[ch];
        self.z1[ch] = self.b1 * x - self.a1 * y + self.z2[ch];
        self.z2[ch] = self.b2 * x - self.a2 * y;
        y
    }
}

/// Noise gate: peak envelope (5 ms attack, 80 ms release); below the
/// threshold, after a short hold, the gain falls to silence.
#[derive(Debug, Clone)]
pub struct Gate {
    thr: f32,
    env: f32,
    gain: f32,
    hold: u32,
    hold_len: u32,
    env_atk: f32,
    env_rel: f32,
    g_open: f32,
    g_close: f32,
}

fn coef(seconds: f64, fs: f64) -> f32 {
    (1.0 - (-1.0 / (seconds * fs)).exp()) as f32
}

impl Gate {
    pub fn new(threshold_db: f32, fs: f64) -> Gate {
        Gate {
            thr: 10f32.powf(threshold_db / 20.0),
            env: 0.0,
            gain: 0.0,
            hold: 0,
            hold_len: (0.03 * fs) as u32,
            env_atk: coef(0.005, fs),
            env_rel: coef(0.080, fs),
            g_open: coef(0.001, fs),
            g_close: coef(0.010, fs),
        }
    }

    #[inline]
    pub fn process(&mut self, f: &mut [f32; 2]) {
        let lvl = f[0].abs().max(f[1].abs());
        let k = if lvl > self.env { self.env_atk } else { self.env_rel };
        self.env += (lvl - self.env) * k;
        let open = if self.env >= self.thr {
            self.hold = self.hold_len;
            true
        } else if self.hold > 0 {
            self.hold -= 1;
            true
        } else {
            false
        };
        if open {
            self.gain += (1.0 - self.gain) * self.g_open;
        } else {
            self.gain -= self.gain * self.g_close;
            if self.gain < 1e-4 {
                self.gain = 0.0;
            }
        }
        f[0] *= self.gain;
        f[1] *= self.gain;
    }
}

/// Web Audio StereoPannerNode on a stereo input (`pan` -1..1).
#[inline]
pub fn pan_frame(f: [f32; 2], pan: f32) -> [f32; 2] {
    let p = pan.clamp(-1.0, 1.0);
    if p <= 0.0 {
        let x = (p + 1.0) * std::f32::consts::FRAC_PI_2;
        let (gl, gr) = (x.cos(), x.sin());
        [f[0] + f[1] * gl, f[1] * gr]
    } else {
        let x = p * std::f32::consts::FRAC_PI_2;
        let (gl, gr) = (x.cos(), x.sin());
        [f[0] * gl, f[1] + f[0] * gr]
    }
}

/// The per-piece chain: gate, EQ, pan (volume and fades stay in the mixer).
pub struct Fx {
    gate: Option<Gate>,
    eq: Vec<Biquad>,
    pan: f32,
}

impl Fx {
    pub fn new(pan: f32, eq: [f32; 3], gate_db: Option<f32>, fs: f64) -> Fx {
        let mut bands = Vec::new();
        let db = |v: f32| (v as f64).clamp(-24.0, 24.0);
        if eq[0].abs() > 0.01 {
            bands.push(Biquad::low_shelf(200.0, db(eq[0]), fs));
        }
        if eq[1].abs() > 0.01 {
            bands.push(Biquad::peaking(1000.0, 0.8, db(eq[1]), fs));
        }
        if eq[2].abs() > 0.01 {
            bands.push(Biquad::high_shelf(5000.0, db(eq[2]), fs));
        }
        Fx {
            gate: gate_db.filter(|g| g.is_finite()).map(|g| Gate::new(g.clamp(-100.0, 0.0), fs)),
            eq: bands,
            pan: if pan.is_finite() { pan.clamp(-1.0, 1.0) } else { 0.0 },
        }
    }

    pub fn is_identity(&self) -> bool {
        self.gate.is_none() && self.eq.is_empty() && self.pan.abs() < 1e-4
    }

    pub fn process(&mut self, frames: &mut [[f32; 2]]) {
        if self.is_identity() {
            return;
        }
        for f in frames.iter_mut() {
            if let Some(g) = &mut self.gate {
                g.process(f);
            }
            for b in &mut self.eq {
                f[0] = b.process(0, f[0] as f64) as f32;
                f[1] = b.process(1, f[1] as f64) as f32;
            }
            if self.pan.abs() >= 1e-4 {
                *f = pan_frame(*f, self.pan);
            }
        }
    }
}

// ------------------------------------------------------------------ peaks

/// Buckets per second for a waveform of a file this long: 100, fewer for
/// long files so the list stays well under 200k values.
pub fn peaks_rate(duration: f64) -> f64 {
    if duration <= 0.0 {
        return 100.0;
    }
    (120_000.0 / duration).floor().clamp(4.0, 100.0)
}

/// Peak level per bucket (0-255, linear), fed one input frame at a time.
pub struct PeakBucketer {
    per: f64,
    next: f64,
    n: u64,
    cur: f32,
    pub data: Vec<u8>,
}

impl PeakBucketer {
    /// `in_rate` input frames per second, `rate` buckets per second.
    pub fn new(in_rate: u32, rate: f64) -> PeakBucketer {
        let per = in_rate.max(1) as f64 / rate.max(0.001);
        PeakBucketer { per, next: per, n: 0, cur: 0.0, data: Vec::new() }
    }

    /// Skips `frames` input frames (before the first one read).
    pub fn offset(&mut self, frames: u64) {
        self.n = frames;
        while self.next <= self.n as f64 {
            self.data.push(0);
            self.next += self.per;
        }
    }

    #[inline]
    pub fn push(&mut self, level: f32) {
        self.cur = self.cur.max(level);
        self.n += 1;
        if self.n as f64 >= self.next {
            self.data.push((self.cur.min(1.0) * 255.0).round() as u8);
            self.cur = 0.0;
            self.next += self.per;
        }
    }

    /// 16-bit interleaved PCM with `ch` channels.
    pub fn push_pcm16(&mut self, bytes: &[u8], ch: usize) {
        let ch = ch.max(1);
        for f in bytes.chunks_exact(2 * ch) {
            let mut m = 0i32;
            for s in f.chunks_exact(2) {
                m = m.max((i16::from_le_bytes([s[0], s[1]]) as i32).abs());
            }
            self.push(m as f32 / 32768.0);
        }
    }

    pub fn finish(mut self) -> Vec<u8> {
        if self.n as f64 > self.next - self.per {
            self.data.push((self.cur.min(1.0) * 255.0).round() as u8);
        }
        self.data
    }
}

// ------------------------------------------------------------------ wav

/// 44-byte header of a 16-bit PCM WAV file.
pub fn wav_header(frames: u32, rate: u32, channels: u16) -> [u8; 44] {
    let block = channels as u32 * 2;
    let data = frames.saturating_mul(block);
    let mut h = [0u8; 44];
    h[0..4].copy_from_slice(b"RIFF");
    h[4..8].copy_from_slice(&data.saturating_add(36).to_le_bytes());
    h[8..12].copy_from_slice(b"WAVE");
    h[12..16].copy_from_slice(b"fmt ");
    h[16..20].copy_from_slice(&16u32.to_le_bytes());
    h[20..22].copy_from_slice(&1u16.to_le_bytes());
    h[22..24].copy_from_slice(&channels.to_le_bytes());
    h[24..28].copy_from_slice(&rate.to_le_bytes());
    h[28..32].copy_from_slice(&(rate * block).to_le_bytes());
    h[32..34].copy_from_slice(&(block as u16).to_le_bytes());
    h[34..36].copy_from_slice(&16u16.to_le_bytes());
    h[36..40].copy_from_slice(b"data");
    h[40..44].copy_from_slice(&data.to_le_bytes());
    h
}

#[cfg(test)]
mod tests {
    use super::*;

    const FS: f64 = 48_000.0;

    fn sine(freq: f64, amp: f32, n: usize) -> Vec<[f32; 2]> {
        (0..n)
            .map(|i| {
                let v = amp * (2.0 * PI * freq * i as f64 / FS).sin() as f32;
                [v, v]
            })
            .collect()
    }

    #[test]
    fn zero_db_biquads_are_identity() {
        for mut b in [Biquad::low_shelf(200.0, 0.0, FS), Biquad::peaking(1000.0, 0.8, 0.0, FS), Biquad::high_shelf(5000.0, 0.0, FS)] {
            for (i, f) in sine(440.0, 0.8, 2000).iter().enumerate() {
                let y = b.process(0, f[0] as f64);
                assert!((y - f[0] as f64).abs() < 1e-9, "sample {i}");
            }
        }
    }

    #[test]
    fn shelves_and_peak_have_the_right_gain() {
        // Low shelf +6 dB: DC gain = A^2 = 10^(6/20).
        let mut b = Biquad::low_shelf(200.0, 6.0, FS);
        let mut y = 0.0;
        for _ in 0..48_000 {
            y = b.process(0, 1.0);
        }
        assert!((y - 10f64.powf(6.0 / 20.0)).abs() < 1e-3, "{y}");
        // High shelf -6 dB leaves DC alone.
        let mut b = Biquad::high_shelf(5000.0, -6.0, FS);
        for _ in 0..48_000 {
            y = b.process(0, 1.0);
        }
        assert!((y - 1.0).abs() < 1e-6, "{y}");
        // Peaking +12 dB at 1 kHz: a 1 kHz sine comes out ~4x.
        let mut b = Biquad::peaking(1000.0, 0.8, 12.0, FS);
        let mut peak = 0.0f64;
        for (i, f) in sine(1000.0, 0.1, 48_000).iter().enumerate() {
            let v = b.process(0, f[0] as f64);
            if i > 24_000 {
                peak = peak.max(v.abs());
            }
        }
        assert!((peak / 0.1 - 10f64.powf(12.0 / 20.0)).abs() < 0.05, "{peak}");
    }

    #[test]
    fn gate_silences_below_threshold_and_passes_above() {
        let mut fx = Fx::new(0.0, [0.0; 3], Some(-40.0), FS);
        // -60 dBFS hum: gated to silence.
        let mut quiet = sine(100.0, 0.001, 9600);
        fx.process(&mut quiet);
        assert!(quiet[4800..].iter().all(|f| f[0] == 0.0 && f[1] == 0.0));
        // -6 dBFS: passes (after the 1 ms opening), nearly untouched.
        let mut fx = Fx::new(0.0, [0.0; 3], Some(-40.0), FS);
        let loud = sine(440.0, 0.5, 9600);
        let mut out = loud.clone();
        fx.process(&mut out);
        for i in 4800..9600 {
            assert!((out[i][0] - loud[i][0]).abs() < 1e-3, "{i}");
        }
        // Signal stops: the gate closes to silence within ~0.4 s.
        let mut tail = vec![[0.0005f32, 0.0005]; 24_000];
        fx.process(&mut tail);
        assert_eq!(tail[23_999], [0.0, 0.0]);
        assert!(tail[10][0] > 0.0, "hold keeps it open briefly");
    }

    #[test]
    fn pan_follows_web_audio() {
        let f = [0.5f32, 0.25];
        assert_eq!(pan_frame(f, 0.0), [0.5, 0.25]);
        let l = pan_frame(f, -1.0);
        assert!((l[0] - 0.75).abs() < 1e-6 && l[1].abs() < 1e-6);
        let r = pan_frame(f, 1.0);
        assert!(r[0].abs() < 1e-6 && (r[1] - 0.75).abs() < 1e-6);
        let h = pan_frame([1.0, 1.0], 0.5);
        let g = (std::f32::consts::FRAC_PI_4).cos();
        assert!((h[0] - g).abs() < 1e-6 && (h[1] - (1.0 + g)).abs() < 1e-6);
        assert!(Fx::new(0.0, [0.0; 3], None, FS).is_identity());
    }

    #[test]
    fn peaks_bucket_per_rate() {
        // 1 s at 48 kHz, 100 buckets: 480 frames each.
        let mut p = PeakBucketer::new(48_000, 100.0);
        for i in 0..48_000 {
            p.push(if i / 480 == 3 && i % 480 == 7 { 1.0 } else { 0.25 });
        }
        let d = p.finish();
        assert_eq!(d.len(), 100);
        assert_eq!(d[3], 255);
        assert_eq!(d[4], 64);
        // A partial last bucket still counts; offset pads with silence.
        let mut p = PeakBucketer::new(1000, 10.0);
        p.offset(250);
        for _ in 0..55 {
            p.push(0.5);
        }
        let d = p.finish();
        assert_eq!(d, vec![0, 0, 128, 128]);
        // PCM input: max of the channels.
        let mut p = PeakBucketer::new(2, 1.0);
        let pcm = [16384i16, -32768, 0, 100].iter().flat_map(|s| s.to_le_bytes()).collect::<Vec<_>>();
        p.push_pcm16(&pcm, 2);
        assert_eq!(p.finish(), vec![255]);
        assert_eq!(peaks_rate(60.0), 100.0);
        assert_eq!(peaks_rate(3.0 * 3600.0), 11.0);
        assert!(peaks_rate(3.0 * 3600.0) * 3.0 * 3600.0 < 200_000.0);
    }

    #[test]
    fn wav_header_fields() {
        let h = wav_header(48_000, 48_000, 2);
        assert_eq!(&h[0..4], b"RIFF");
        assert_eq!(u32::from_le_bytes(h[4..8].try_into().unwrap()), 36 + 192_000);
        assert_eq!(&h[8..16], b"WAVEfmt ");
        assert_eq!(u16::from_le_bytes([h[22], h[23]]), 2);
        assert_eq!(u32::from_le_bytes(h[24..28].try_into().unwrap()), 48_000);
        assert_eq!(u32::from_le_bytes(h[28..32].try_into().unwrap()), 192_000);
        assert_eq!(u16::from_le_bytes([h[32], h[33]]), 4);
        assert_eq!(u16::from_le_bytes([h[34], h[35]]), 16);
        assert_eq!(&h[36..40], b"data");
        assert_eq!(u32::from_le_bytes(h[40..44].try_into().unwrap()), 192_000);
    }
}
