from dataclasses import dataclass
from typing import Dict, List, Tuple
import numpy as np

@dataclass(frozen=True)
class Frame:
    """Represents a captured webcam video frame."""
    data: np.ndarray
    t_capture: float


@dataclass(frozen=True)
class FaceLandmarks:
    """Represents facial and eye landmarks detected on a frame."""
    landmarks: List[Tuple[float, float, float]]
    eye_pts_left: List[Tuple[float, float, float]]
    eye_pts_right: List[Tuple[float, float, float]]
    confidence: float
    status: str  # e.g., "tracking", "lost", "low_confidence"


@dataclass(frozen=True)
class RawGaze:
    """Represents the raw gaze direction estimated from face coordinates."""
    yaw_deg: float
    pitch_deg: float
    confidence: float


@dataclass(frozen=True)
class ScreenPointRaw:
    """Represents the raw pixel coordinate mapped to the screen."""
    x: float
    y: float


@dataclass(frozen=True)
class ScreenPointSmooth:
    """Represents noise-smoothed pixel coordinate on the screen."""
    x: float
    y: float


@dataclass(frozen=True)
class ClickEvent:
    """Represents a click action triggered by the interface."""
    button: str  # e.g. "left", "right"
    source: str  # e.g. "dwell", "blink"
    timestamp: float
    position: Tuple[float, float]  # (x, y)


@dataclass(frozen=True)
class CalibrationModel:
    """Represents the parameters and performance of a screen calibration session."""
    coefficients: Dict[str, List[float]]
    rms_error: float
    screen_resolution: Tuple[int, int]  # (width, height)
    calibration_timestamp: float
