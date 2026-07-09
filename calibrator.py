import logging
import time
from typing import Dict, List, Optional, Tuple
import numpy as np
from eye_cursor.models import RawGaze, ScreenPointRaw, CalibrationModel
from eye_cursor.calibration_system.interface import CalibrationSystemInterface

logger = logging.getLogger(__name__)

class GazeCalibrator(CalibrationSystemInterface):
    """Implementation of CalibrationSystemInterface using Ridge Polynomial Regression."""

    def __init__(
        self,
        regression_order: int = 2,
        ridge_lambda: float = 0.1,
        edge_distortion_coef: float = 0.0,
        screen_resolution: Tuple[int, int] = (1920, 1080),
    ) -> None:
        self.regression_order = regression_order
        self.ridge_lambda = ridge_lambda
        self.edge_distortion_coef = edge_distortion_coef
        self.screen_resolution = screen_resolution

        self.gaze_samples: List[Tuple[float, float]] = []  # List of (yaw, pitch)
        self.screen_samples: List[Tuple[float, float]] = []  # List of (x, y)

    def add_calibration_point(self, gaze: RawGaze, screen_x: float, screen_y: float) -> None:
        """Record a calibration pairing."""
        self.gaze_samples.append((gaze.yaw_deg, gaze.pitch_deg))
        self.screen_samples.append((screen_x, screen_y))
        logger.info(f"Added calibration point: Gaze=({gaze.yaw_deg:.2f}, {gaze.pitch_deg:.2f}) -> Screen=({screen_x}, {screen_y})")

    def reset(self) -> None:
        """Reset all collected pairings."""
        self.gaze_samples.clear()
        self.screen_samples.clear()
        logger.info("Calibration pairings cleared.")

    def _get_features(self, yaw: float, pitch: float) -> List[float]:
        """Compute polynomial features based on order."""
        if self.regression_order == 2:
            # [1, yaw, pitch, yaw^2, yaw*pitch, pitch^2] (6 features)
            return [1.0, yaw, pitch, yaw**2, yaw * pitch, pitch**2]
        elif self.regression_order == 3:
            # [1, yaw, pitch, yaw^2, yaw*pitch, pitch^2, yaw^3, yaw^2*pitch, yaw*pitch^2, pitch^3] (10 features)
            return [
                1.0,
                yaw,
                pitch,
                yaw**2,
                yaw * pitch,
                pitch**2,
                yaw**3,
                (yaw**2) * pitch,
                yaw * (pitch**2),
                pitch**3,
            ]
        else:
            # Default fallback to linear if order is unsupported
            return [1.0, yaw, pitch]

    def calibrate(self) -> CalibrationModel:
        """Fit polynomial coefficients using Ridge Regression (L2 regularization)."""
        if len(self.gaze_samples) < 6:
            raise ValueError(f"Insufficient calibration points. Need at least 6 points, got {len(self.gaze_samples)}")

        X = np.array([self._get_features(y, p) for y, p in self.gaze_samples])
        Y = np.array(self.screen_samples)

        n_samples, n_features = X.shape

        # Ridge Regression formulation: beta = (X^T X + lambda * I)^-1 X^T Y
        XTX = np.dot(X.T, X)
        # Identity matrix for regularization, ignoring the intercept term (index 0)
        I_reg = np.eye(n_features)
        I_reg[0, 0] = 0.0
        
        # Fit coefficients
        XTX_reg = XTX + self.ridge_lambda * I_reg
        beta = np.dot(np.linalg.pinv(XTX_reg), np.dot(X.T, Y))

        # Calculate Root Mean Squared (RMS) error on the training dataset
        predictions = np.dot(X, beta)
        errors = Y - predictions
        squared_errors = np.sum(errors**2, axis=1)
        rms_error = float(np.sqrt(np.mean(squared_errors)))

        logger.info(f"Calibration completed. Fitted {n_features} features. RMS Error: {rms_error:.2f} pixels.")

        coefficients = {
            "x_coefs": beta[:, 0].tolist(),
            "y_coefs": beta[:, 1].tolist(),
        }

        return CalibrationModel(
            coefficients=coefficients,
            rms_error=rms_error,
            screen_resolution=self.screen_resolution,
            calibration_timestamp=time.time(),
        )

    def map_gaze(self, gaze: RawGaze, model: CalibrationModel) -> Optional[ScreenPointRaw]:
        """Apply regression coefficients to map raw gaze to screen coordinates."""
        if not model.coefficients or "x_coefs" not in model.coefficients:
            return None

        x_coefs = np.array(model.coefficients["x_coefs"])
        y_coefs = np.array(model.coefficients["y_coefs"])

        features = np.array(self._get_features(gaze.yaw_deg, gaze.pitch_deg))

        # Compute raw mapping coordinates
        raw_x = float(np.dot(features, x_coefs))
        raw_y = float(np.dot(features, y_coefs))

        # Apply edge distortion correction (radial lens model relative to screen center)
        if abs(self.edge_distortion_coef) > 1e-6:
            sw, sh = model.screen_resolution
            # Center normalized coordinates
            nx = (raw_x - sw / 2.0) / (sw / 2.0)
            ny = (raw_y - sh / 2.0) / (sh / 2.0)
            r2 = nx**2 + ny**2

            distortion = 1.0 + self.edge_distortion_coef * r2
            raw_x = (nx * distortion) * (sw / 2.0) + sw / 2.0
            raw_y = (ny * distortion) * (sh / 2.0) + sh / 2.0

        # Clamping to screen boundaries
        clamped_x = float(np.clip(raw_x, 0.0, model.screen_resolution[0]))
        clamped_y = float(np.clip(raw_y, 0.0, model.screen_resolution[1]))

        return ScreenPointRaw(x=clamped_x, y=clamped_y)
