from dataclasses import dataclass, field
from typing import Tuple

@dataclass
class AppConfig:
    """App-wide configuration parameters."""
    # Video Capture
    camera_index: int = 0
    frame_width: int = 640
    frame_height: int = 480
    camera_fps_target: int = 30
    camera_max_failures: int = 15

    # Face Landmark Detection
    min_detection_confidence: float = 0.5
    min_tracking_confidence: float = 0.5

    # Gaze Estimation
    gaze_model_path: str = "models/l2cs_net.pth"
    use_gpu: bool = False
    gaze_confidence_threshold: float = 0.4

    # Calibration
    calibration_rms_threshold_px: float = 40.0
    regression_order: int = 2  # 2 or 3
    ridge_lambda: float = 0.1  # Regularization constant
    edge_distortion_coef: float = 0.0  # Optional correction

    # Kalman Filter
    kalman_process_noise: float = 0.05
    kalman_measurement_noise: float = 1.0

    # Dwell Clicking
    dwell_click_enabled: bool = True
    dwell_radius_px: float = 40.0
    dwell_time_sec: float = 0.5
    dwell_cooldown_sec: float = 0.4

    # Blink Clicking
    blink_click_enabled: bool = False
    blink_ear_threshold: float = 0.20
    double_blink_window_sec: float = 0.50

    # Cursor Controller
    cursor_speed: float = 1.0
    dpi_scaling_factor: float = 1.0

    # Persistence
    config_file_path: str = "settings.json"
    calibration_file_path: str = "calibration.json"
