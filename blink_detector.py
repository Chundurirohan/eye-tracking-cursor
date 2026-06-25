import logging
import time
from typing import List, Optional, Tuple
import numpy as np
from eye_cursor.models import FaceLandmarks, ClickEvent

logger = logging.getLogger(__name__)

class GazeBlinkDetector:
    """Detects left click events from intentional double-blink gestures using EAR (Eye Aspect Ratio)."""

    def __init__(
        self,
        ear_threshold: float = 0.20,
        double_blink_window_sec: float = 0.50,
    ) -> None:
        self.ear_threshold = ear_threshold
        self.double_blink_window = double_blink_window_sec

        self._eye_was_closed = False
        self._blink_start_time: Optional[float] = None
        self._blink_history: List[float] = []

    def calculate_ear(self, eye_pts: List[Tuple[float, float, float]]) -> float:
        """Compute the Eye Aspect Ratio (EAR) from 6 contour landmarks.

        Formula: EAR = (||p2 - p6|| + ||p3 - p5||) / (2.0 * ||p1 - p4||)
        """
        if len(eye_pts) < 6:
            return 1.0

        p1 = np.array(eye_pts[0])
        p2 = np.array(eye_pts[1])
        p3 = np.array(eye_pts[2])
        p4 = np.array(eye_pts[3])
        p5 = np.array(eye_pts[4])
        p6 = np.array(eye_pts[5])

        num1 = np.linalg.norm(p2 - p6)
        num2 = np.linalg.norm(p3 - p5)
        den = np.linalg.norm(p1 - p4)

        if den < 1e-6:
            return 1.0

        return (num1 + num2) / (2.0 * den)

    def process(self, landmarks: FaceLandmarks, cursor_pos: Tuple[float, float] = (0.0, 0.0)) -> Optional[ClickEvent]:
        """Process facial landmarks to identify double-blink gesture events.

        Args:
            landmarks: The face landmark coordinates.
            cursor_pos: Current smoothed screen coordinates to populate the event.

        Returns:
            Optional[ClickEvent]: Click event if double blink is detected, else None.
        """
        if landmarks.status == "lost" or not landmarks.eye_pts_left or not landmarks.eye_pts_right:
            self._eye_was_closed = False
            return None

        now = time.time()

        # Calculate EAR for both eyes
        left_ear = self.calculate_ear(landmarks.eye_pts_left)
        right_ear = self.calculate_ear(landmarks.eye_pts_right)
        avg_ear = (left_ear + right_ear) / 2.0

        # State machine transition
        if avg_ear < self.ear_threshold:
            if not self._eye_was_closed:
                self._eye_was_closed = True
                self._blink_start_time = now
        else:
            if self._eye_was_closed:
                # Eye just opened: record blink duration
                duration = now - (self._blink_start_time or now)
                self._eye_was_closed = False

                # Reject long eyelid closures (e.g. sleep) and short glitch frames (<50ms)
                if 0.05 <= duration <= 0.45:
                    self._blink_history.append(now)
                    # Filter history to current double blink window
                    self._blink_history = [t for t in self._blink_history if now - t <= self.double_blink]
                    
                    logger.debug(f"Detected valid blink duration: {duration:.2f}s. Blink history: {len(self._blink_history)}")

                    if len(self._blink_history) >= 2:
                        self._blink_history.clear()  # prevent double-firing
                        click_evt = ClickEvent(
                            button="left",
                            source="blink",
                            timestamp=now,
                            position=cursor_pos,
                        )
                        logger.info(f"Blink Click triggered at position {cursor_pos} (double blink).")
                        return click_evt

        return None

    def reset(self) -> None:
        """Reset internal history state trackers."""
        self._eye_was_closed = False
        self._blink_start_time = None
        self._blink_history.clear()

    @property
    def double_blink(self) -> float:
        return self.double_blink_window
