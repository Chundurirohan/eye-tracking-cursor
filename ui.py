import logging
import time
from typing import List, Tuple, Optional
import cv2
import numpy as np

from eye_cursor.video_capture.interface import VideoCaptureInterface
from eye_cursor.face_landmark_detection.interface import FaceLandmarkDetectorInterface
from eye_cursor.gaze_estimation.interface import GazeEstimatorInterface
from eye_cursor.calibration_system.calibrator import GazeCalibrator
from eye_cursor.models import RawGaze, CalibrationModel

logger = logging.getLogger(__name__)

class CalibrationUI:
    """OpenCV-based fullscreen calibration UI for collecting screen-gaze associations."""

    def __init__(
        self,
        capture: VideoCaptureInterface,
        detector: FaceLandmarkDetectorInterface,
        estimator: GazeEstimatorInterface,
        screen_resolution: Tuple[int, int] = (1920, 1080),
    ) -> None:
        self._capture = capture
        self._detector = detector
        self._estimator = estimator
        self._width, self._height = screen_resolution
        self._calibrator = GazeCalibrator(screen_resolution=screen_resolution)

        # 9 calibration points (normalized coordinates)
        self._points_norm: List[Tuple[float, float]] = [
            (0.1, 0.1), (0.5, 0.1), (0.9, 0.1),  # Top
            (0.1, 0.5), (0.5, 0.5), (0.9, 0.5),  # Center
            (0.1, 0.9), (0.5, 0.9), (0.9, 0.9),  # Bottom
        ]

    def run_calibration(self) -> Optional[CalibrationModel]:
        """Run the interactive calibration sequence.

        Returns:
            CalibrationModel: The fitted model, or None if calibration was aborted or failed.
        """
        logger.info("Starting interactive Calibration UI...")
        cv2.namedWindow("Calibration", cv2.WND_PROP_FULLSCREEN)
        cv2.setWindowProperty("Calibration", cv2.WND_PROP_FULLSCREEN, cv2.WINDOW_FULLSCREEN)

        self._calibrator.reset()
        point_idx = 0

        # Background canvass (dark blue slate)
        canvas = np.zeros((self._height, self._width, 3), dtype=np.uint8)

        # Ensure camera is streaming
        if not self._capture.is_running():
            self._capture.start()
            time.sleep(0.5)

        aborted = False

        while point_idx < len(self._points_norm):
            px_norm, py_norm = self._points_norm[point_idx]
            px = int(px_norm * self._width)
            py = int(py_norm * self._height)

            # Frame loop for the current target point
            while True:
                canvas.fill(15)  # dark slate gray background
                
                # Draw prompt message
                cv2.putText(
                    canvas,
                    f"Calibrating Point {point_idx + 1}/9. Focus on the dot.",
                    (int(self._width * 0.3), int(self._height * 0.4)),
                    cv2.FONT_HERSHEY_SIMPLEX,
                    0.8,
                    (255, 255, 255),
                    2,
                )
                cv2.putText(
                    canvas,
                    "Press [SPACE] when focused, or [ESC] to abort.",
                    (int(self._width * 0.3), int(self._height * 0.45)),
                    cv2.FONT_HERSHEY_SIMPLEX,
                    0.7,
                    (200, 200, 200),
                    2,
                )

                # Draw target dot
                cv2.circle(canvas, (px, py), 24, (220, 220, 220), -1)
                cv2.circle(canvas, (px, py), 12, (50, 50, 240), -1)
                cv2.circle(canvas, (px, py), 2, (255, 255, 255), -1)

                cv2.imshow("Calibration", canvas)
                key = cv2.waitKey(30) & 0xFF

                if key == 27:  # ESC
                    aborted = True
                    break
                elif key == 32:  # SPACE
                    # Collect and average gaze samples
                    gaze_data = self._collect_gaze_samples()
                    if gaze_data is not None:
                        self._calibrator.add_calibration_point(gaze_data, float(px), float(py))
                        point_idx += 1
                        break
                    else:
                        # Draw warning if gaze estimation is failing
                        cv2.putText(
                            canvas,
                            "No Face Detected! Please align camera.",
                            (int(self._width * 0.35), int(self._height * 0.8)),
                            cv2.FONT_HERSHEY_SIMPLEX,
                            0.7,
                            (50, 50, 255),
                            2,
                        )
                        cv2.imshow("Calibration", canvas)
                        cv2.waitKey(1000)

            if aborted:
                break

        cv2.destroyWindow("Calibration")

        if aborted or len(self._calibrator.gaze_samples) < 9:
            logger.warning("Calibration sequence aborted by user.")
            return None

        # Fit regression coefficients
        try:
            model = self._calibrator.calibrate()
            # If RMS exceeds limit, recursively prompt recalibration
            if model.rms_error > self._calibrator.calibration_rms_threshold_px:
                logger.warning(f"Calibration error too high: {model.rms_error:.1f}px. Prompting recalibration.")
                # We can prompt the user to recalibrate
                return self.run_calibration()
            return model
        except Exception as e:
            logger.error(f"Failed fitting calibration coefficients: {e}")
            return None

    def _collect_gaze_samples(self) -> Optional[RawGaze]:
        """Averages multiple raw gaze estimations over 150ms to cancel noise."""
        yaws: List[float] = []
        pitches: List[float] = []
        confidences: List[float] = []

        start_time = time.perf_counter()
        while time.perf_counter() - start_time < 0.15:
            frame = self._capture.read()
            if frame is not None:
                landmarks = self._detector.detect(frame)
                if landmarks is not None and landmarks.status == "tracking":
                    gaze = self._estimator.estimate(frame, landmarks)
                    if gaze is not None:
                        yaws.append(gaze.yaw_deg)
                        pitches.append(gaze.pitch_deg)
                        confidences.append(gaze.confidence)
            time.sleep(0.01)

        if not yaws:
            return None

        return RawGaze(
            yaw_deg=float(np.mean(yaws)),
            pitch_deg=float(np.mean(pitches)),
            confidence=float(np.mean(confidences)),
        )
