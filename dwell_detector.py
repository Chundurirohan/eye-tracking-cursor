import logging
import time
from typing import Optional, Tuple
from eye_cursor.models import ScreenPointSmooth, ClickEvent
from eye_cursor.click_detection.interface import ClickDetectorInterface
from eye_cursor.face_landmark_detection.interface import FaceLandmarkDetectorInterface  # for compatibility

logger = logging.getLogger(__name__)

class GazeDwellDetector:
    """Detects click events when the gaze remains stationary within a radius for a set duration."""

    def __init__(
        self,
        radius_px: float = 40.0,
        dwell_time_sec: float = 0.5,
        cooldown_sec: float = 0.4,
    ) -> None:
        self.radius_px = radius_px
        self.dwell_time_sec = dwell_time_sec
        self.cooldown_sec = cooldown_sec

        self._dwell_start_point: Optional[Tuple[float, float]] = None
        self._dwell_start_time: Optional[float] = None
        self._last_click_time: float = 0.0

    def process(self, point: ScreenPointSmooth) -> Optional[ClickEvent]:
        """Process a new smoothed coordinate and check for dwell click.

        Args:
            point: The smoothed cursor coordinate.

        Returns:
            Optional[ClickEvent]: The triggered click event, or None if no click occurred.
        """
        now = time.time()

        # Cooldown check
        if now - self._last_click_time < self.cooldown_sec:
            self.reset()
            return None

        current_pos = (point.x, point.y)

        # Initial point in the window
        if self._dwell_start_point is None or self._dwell_start_time is None:
            self._dwell_start_point = current_pos
            self._dwell_start_time = now
            return None

        # Calculate distance from the anchor point
        dx = current_pos[0] - self._dwell_start_point[0]
        dy = current_pos[1] - self._dwell_start_point[1]
        dist = (dx**2 + dy**2) ** 0.5

        if dist <= self.radius_px:
            # Gaze remains stable
            elapsed = now - self._dwell_start_time
            if elapsed >= self.dwell_time_sec:
                # Trigger click!
                click_evt = ClickEvent(
                    button="left",
                    source="dwell",
                    timestamp=now,
                    position=current_pos,
                )
                logger.info(f"Dwell Click triggered at position {current_pos} after {elapsed:.2f}s")
                self._last_click_time = now
                self.reset()
                return click_evt
        else:
            # Gaze shifted outside the radius, reset anchor to current point
            self._dwell_start_point = current_pos
            self._dwell_start_time = now

        return None

    def reset(self) -> None:
        """Reset the active dwell tracker window."""
        self._dwell_start_point = None
        self._dwell_start_time = None
