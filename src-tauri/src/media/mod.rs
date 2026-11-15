//! Media subsystem: capture, encode, buffer, mux, trim.

pub mod audio;
pub mod compose;
pub mod compositor;
pub mod library;
pub mod recorder;
pub mod shrink;
pub mod wincap;

pub use library::{ClipMetadata, TrimResult};
pub use recorder::{
    CaptureEngine, CaptureSource, ClipWriteResult, Codec, EncoderInfo, EncoderVendor, EngineState, EngineStats,
    MonitorInfo, RecorderConfig, RecorderError,
};
