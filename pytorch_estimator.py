import logging
import os
import time
from typing import Optional, Tuple
import cv2
import numpy as np

try:
    import torch
    import torch.nn as nn
    import torch.nn.functional as F
    import torchvision.models as models
except ImportError:
    torch = None
    nn = None
    F = None
    models = None

from eye_cursor.models import Frame, FaceLandmarks, RawGaze
from eye_cursor.gaze_estimation.interface import GazeEstimatorInterface
from eye_cursor.telemetry.interface import TelemetryInterface

logger = logging.getLogger(__name__)

# Define ResNet-50 L2CS-Net architecture if PyTorch is available
if torch is not None and nn is not None and models is not None:
    class L2CSNet(nn.Module):
        """L2CS-Net Model architecture for Gaze Estimation."""

        def __init__(self, num_bins: int = 90) -> None:
            super(L2CSNet, self).__init__()
            # Base ResNet50 backbone
            self.backbone = models.resnet50(weights=None)
            self.fc_yaw = nn.Linear(1000, num_bins)
            self.fc_pitch = nn.Linear(1000, num_bins)

        def forward(self, x: torch.Tensor) -> Tuple[torch.Tensor, torch.Tensor]:
            x = self.backbone(x)
            yaw = self.fc_yaw(x)
            pitch = self.fc_pitch(x)
            return yaw, pitch
else:
    class L2CSNet:  # type: ignore
        pass


class PytorchL2CSNetGazeEstimator(GazeEstimatorInterface):
    """PyTorch L2CS-Net gaze estimator with robust analytical fallback."""

    def __init__(
        self,
        model_path: str = "models/l2cs_net.pth",
        use_gpu: bool = False,
        telemetry: Optional[TelemetryInterface] = None,
    ) -> None:
        self._model_path = model_path
        self._use_gpu = use_gpu
        self._telemetry = telemetry
        self._device = "cpu"
        self._model = None

        if torch is not None:
            if use_gpu and torch.cuda.is_available():
                self._device = "cuda"
            logger.info(f"Using device: {self._device} for gaze estimation.")

            if os.path.exists(self._model_path):
                try:
                    self._model = L2CSNet()
                    state_dict = torch.load(self._model_path, map_location=self._device)
                    self._model.load_state_dict(state_dict)
                    self._model.to(self._device)
                    self._model.eval()
                    logger.info(f"Loaded L2CS-Net weights successfully from {self._model_path}")
                except Exception as e:
                    logger.warning(
                        f"Failed to load L2CS-Net weights from {self._model_path}: {e}. "
                        "Gaze estimator will run in analytical fallback mode."
                    )
                    self._model = None
            else:
                logger.info(
                    f"Model weights file '{self._model_path}' not found. "
                    "Running in analytical fallback mode."
                )
        else:
            logger.info("PyTorch is not available. Running in analytical fallback mode.")

    def estimate(self, frame: Frame, landmarks: FaceLandmarks) -> Optional[RawGaze]:
        """Estimate yaw and pitch angles of gaze from face image and landmarks."""
        t_start = time.perf_counter()

        if not landmarks.landmarks or landmarks.status == "lost":
            return None

        # Execute PyTorch model if available and loaded
        if self._model is not None and torch is not None and F is not None:
            try:
                res = self._pytorch_estimate(frame, landmarks)
                if res is not None:
                    self._log_latency(t_start)
                    return res
            except Exception as e:
                logger.error(f"Error during L2CS-Net inference: {e}. Falling back to analytical mode.")

        # Fallback to analytical calculation
        res_analytical = self._analytical_estimate(landmarks)
        self._log_latency(t_start)
        return res_analytical

    def _pytorch_estimate(self, frame: Frame, landmarks: FaceLandmarks) -> Optional[RawGaze]:
        """Run ResNet50-based PyTorch L2CS-Net inference."""
        if torch is None or F is None or self._model is None:
            return None

        # Determine face bounding box coordinates
        pts = np.array(landmarks.landmarks)
        x_min, y_min = np.min(pts[:, :2], axis=0)
        x_max, y_max = np.max(pts[:, :2], axis=0)

        h, w, _ = frame.data.shape
        x1, y1 = int(x_min * w), int(y_min * h)
        x2, y2 = int(x_max * w), int(y_max * h)

        # Pad and clamp dimensions
        x1 = max(0, x1)
        y1 = max(0, y1)
        x2 = min(w, x2)
        y2 = min(h, y2)

        if (x2 - x1) < 20 or (y2 - y1) < 20:
            return None

        # Crop and resize
        face_img = frame.data[y1:y2, x1:x2]
        face_img = cv2.resize(face_img, (224, 224))
        face_img = face_img.astype(np.float32) / 255.0

        # Standard ImageNet normalization
        mean = np.array([0.485, 0.456, 0.406], dtype=np.float32)
        std = np.array([0.229, 0.224, 0.225], dtype=np.float32)
        face_img = (face_img - mean) / std
        face_img = np.transpose(face_img, (2, 0, 1))

        # Convert to tensor and run
        tensor = torch.tensor(face_img, dtype=torch.float32).unsqueeze(0).to(self._device)
        with torch.no_grad():
            yaw_out, pitch_out = self._model(tensor)
            
            # Predict angles as expectation over bins
            # Output represents 90 bins from -90 to 90 degrees with step size of 2
            softmax_yaw = F.softmax(yaw_out, dim=1)
            softmax_pitch = F.softmax(pitch_out, dim=1)

            bins = torch.arange(-90, 90, 2, dtype=torch.float32).to(self._device)
            yaw_deg = torch.sum(softmax_yaw * bins, dim=1).item()
            pitch_deg = torch.sum(softmax_pitch * bins, dim=1).item()

        return RawGaze(
            yaw_deg=yaw_deg,
            pitch_deg=pitch_deg,
            confidence=landmarks.confidence,
        )

    def _analytical_estimate(self, landmarks: FaceLandmarks) -> RawGaze:
        """Estimate gaze mathematically using eye aspect / iris location displacement.

        This uses the displacement of the iris center relative to the eye corners.
        """
        # Retrieve left and right eye points
        # Structure of eye_pts: [corner_l, top_l, top_r, corner_r, bot_r, bot_l, iris_center]
        left_pts = landmarks.eye_pts_left
        right_pts = landmarks.eye_pts_right

        # Default fallback values if coordinates are missing or malformed
        if len(left_pts) < 7 or len(right_pts) < 7:
            return RawGaze(yaw_deg=0.0, pitch_deg=0.0, confidence=0.1)

        # Function to calculate gaze ratios for a single eye
        def get_eye_gaze_ratios(pts: List[Tuple[float, float, float]]) -> Tuple[float, float]:
            p_left = np.array(pts[0])
            p_right = np.array(pts[3])
            iris = np.array(pts[6])

            # Horizontal displacement ratio
            eye_midpoint = (p_left + p_right) / 2.0
            eye_width = np.linalg.norm(p_left - p_right)
            
            if eye_width < 1e-6:
                return 0.0, 0.0

            dx = iris[0] - eye_midpoint[0]
            ratio_x = dx / eye_width

            # Vertical displacement ratio
            # Average of eye top points and bottom points
            p_top = (np.array(pts[1]) + np.array(pts[2])) / 2.0
            p_bot = (np.array(pts[4]) + np.array(pts[5])) / 2.0
            eye_height = np.linalg.norm(p_top - p_bot)

            if eye_height < 1e-6:
                return ratio_x, 0.0

            dy = iris[1] - (p_top[1] + p_bot[1]) / 2.0
            ratio_y = dy / eye_height

            return ratio_x, ratio_y

        left_rx, left_ry = get_eye_gaze_ratios(left_pts)
        right_rx, right_ry = get_eye_gaze_ratios(right_pts)

        # Average ratios across both eyes
        avg_rx = (left_rx + right_rx) / 2.0
        avg_ry = (left_ry + right_ry) / 2.0

        # Calibrate/scale ratio to approximate field-of-view degrees
        # Horizontal ratio range is roughly [-0.5, 0.5], map to [-45.0, 45.0] degrees
        yaw_deg = avg_rx * 45.0
        # Vertical ratio range is roughly [-0.5, 0.5], map to [-30.0, 30.0] degrees (inverted)
        pitch_deg = -avg_ry * 30.0

        # Clamp angles to standard visual ranges
        yaw_deg = float(np.clip(yaw_deg, -60.0, 60.0))
        pitch_deg = float(np.clip(pitch_deg, -45.0, 45.0))

        return RawGaze(
            yaw_deg=yaw_deg,
            pitch_deg=pitch_deg,
            confidence=landmarks.confidence * 0.9,  # slightly lower confidence than true CNN estimation
        )

    def _log_latency(self, t_start: float) -> None:
        if self._telemetry:
            latency_ms = (time.perf_counter() - t_start) * 1000.0
            self._telemetry.log_latency("gaze_inference", latency_ms)
