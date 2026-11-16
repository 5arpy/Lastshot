//! Media subsystem: capture, encode, buffer, mux, trim.

pub mod audio;
pub mod compose;
pub mod compositor;
pub mod cursor;
pub mod layers;
pub mod library;
pub mod preview;
pub mod procaudio;
pub mod recorder;
pub mod shrink;
pub mod voice;
pub mod watchdog;
pub mod webcam;
pub mod wincap;
pub mod winvis;

pub use library::{ClipMetadata, TrimResult};
pub use recorder::{
    CaptureEngine, CaptureSource, ClipWriteResult, Codec, EncoderInfo, EncoderVendor, EngineState, EngineStats,
    MonitorInfo, RecorderConfig, RecorderError,
};
