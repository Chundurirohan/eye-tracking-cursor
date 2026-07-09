import time
from typing import Optional
import numpy as np
from eye_cursor.models import ScreenPointRaw, ScreenPointSmooth
from eye_cursor.kalman_filter.interface import PointFilterInterface

class GazeKalmanFilter(PointFilterInterface):
    """Kalman filter for smoothing screen coordinates using a constant velocity model."""

    def __init__(
        self,
        process_noise: float = 0.05,
        measurement_noise: float = 1.0,
    ) -> None:
        self.process_noise = process_noise
        self.measurement_noise = measurement_noise

        # State vector: [x, y, vx, vy]^T
        self._x = np.zeros((4, 1), dtype=np.float32)
        # Covariance matrix P
        self._P = np.eye(4, dtype=np.float32) * 100.0

        self._initialized = False
        self._last_time: Optional[float] = None

    def filter(self, point: ScreenPointRaw) -> ScreenPointSmooth:
        """Apply noise-filtering to smooth raw screen coordinates."""
        now = time.time()

        if not self._initialized:
            self._x[0, 0] = point.x
            self._x[1, 0] = point.y
            self._x[2, 0] = 0.0
            self._x[3, 0] = 0.0
            self._last_time = now
            self._initialized = True
            return ScreenPointSmooth(x=point.x, y=point.y)

        dt = now - (self._last_time or now)
        if dt <= 0.0:
            dt = 0.033  # fallback to ~30 FPS frame time

        self._last_time = now

        # Run predict-update cycle
        self.predict(dt)
        self.update(point.x, point.y)

        return ScreenPointSmooth(
            x=float(self._x[0, 0]),
            y=float(self._x[1, 0]),
        )

    def predict(self, dt: float) -> None:
        """Predict the future state of the cursor position and velocity.

        Args:
            dt: Time delta since the last update.
        """
        # State transition matrix F
        F = np.array(
            [
                [1.0, 0.0, dt, 0.0],
                [0.0, 1.0, 0.0, dt],
                [0.0, 0.0, 1.0, 0.0],
                [0.0, 0.0, 0.0, 1.0],
            ],
            dtype=np.float32,
        )

        # Process noise covariance matrix Q (discrete constant acceleration)
        # We can construct Q directly to represent uncertainty added per timestep.
        Q = np.array(
            [
                [dt**4 / 4.0, 0.0, dt**3 / 2.0, 0.0],
                [0.0, dt**4 / 4.0, 0.0, dt**3 / 2.0],
                [dt**3 / 2.0, 0.0, dt**2, 0.0],
                [0.0, dt**3 / 2.0, 0.0, dt**2],
            ],
            dtype=np.float32,
        ) * self.process_noise

        # x_predicted = F * x
        self._x = np.dot(F, self._x)
        # P_predicted = F * P * F^T + Q
        self._P = np.dot(F, np.dot(self._P, F.T)) + Q

    def update(self, x: float, y: float) -> None:
        """Update state using actual observation coordinates.

        Args:
            x: Raw measured screen X coordinate.
            y: Raw measured screen Y coordinate.
        """
        # Measurement matrix H (mapping 4D state to 2D measurement)
        H = np.array(
            [
                [1.0, 0.0, 0.0, 0.0],
                [0.0, 1.0, 0.0, 0.0],
            ],
            dtype=np.float32,
        )

        # Measurement noise covariance matrix R
        R = np.eye(2, dtype=np.float32) * self.measurement_noise

        # Measurement vector z
        z = np.array([[x], [y]], dtype=np.float32)

        # Innovation: y = z - H * x
        innovation = z - np.dot(H, self._x)

        # Innovation covariance: S = H * P * H^T + R
        S = np.dot(H, np.dot(self._P, H.T)) + R

        # Kalman Gain: K = P * H^T * S^-1
        K = np.dot(self._P, np.dot(H.T, np.linalg.pinv(S)))

        # x = x + K * y
        self._x = self._x + np.dot(K, innovation)

        # P = (I - K * H) * P
        I = np.eye(4, dtype=np.float32)
        self._P = np.dot(I - np.dot(K, H), self._P)

    def reset(self) -> None:
        """Reset internal state vectors."""
        self._x.fill(0.0)
        self._P = np.eye(4, dtype=np.float32) * 100.0
        self._initialized = False
        self._last_time = None
