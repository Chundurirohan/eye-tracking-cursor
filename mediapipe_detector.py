import logging
import time
from typing import Optional, List, Tuple
import cv2
import numpy as np

try:
    import mediapipe as mp
except ImportError:
    mp = None

from eye_cursor.models import Frame, FaceLandmarks
from eye_cursor.face_landmark_detection.interface import FaceLandmarkDetectorInterface
from eye_cursor.telemetry.interface import TelemetryInterface

logger = logging.getLogger(__name__)

class MediaPipeDetector(FaceLandmarkDetectorInterface):
    """MediaPipe-based face and eye landmark detector with Haar cascade fallbacks."""

    def __init__(
        self,
        min_detection_confidence: float = 0.5,
        min_tracking_confidence: float = 0.5,
        telemetry: Optional[TelemetryInterface] = None,
    ) -> None:
        self._telemetry = telemetry
        self._mp_face_mesh = None
        self._face_mesh = None

        # Initialize MediaPipe if installed
        if mp is not None:
            try:
                self._mp_face_mesh = mp.solutions.face_mesh
                self._face_mesh = self._mp_face_mesh.FaceMesh(
                    max_num_faces=1,
                    refine_landmarks=True,
                    min_detection_confidence=min_detection_confidence,
                    min_tracking_confidence=min_tracking_confidence,
                )
                logger.info("MediaPipe Face Mesh initialized successfully.")
            except Exception as e:
                logger.warning(f"Failed to initialize MediaPipe Face Mesh: {e}. Falling back to OpenCV.")
                self._face_mesh = None

        # Set up OpenCV Haar Cascades fallback
        self._face_cascade = cv2.CascadeClassifier(cv2.data.haarcascades + "haarcascade_frontalface_default.xml")
        self._eye_cascade = cv2.CascadeClassifier(cv2.data.haarcascades + "haarcascade_eye.xml")

    def detect(self, frame: Frame) -> Optional[FaceLandmarks]:
        """Detect face and eye landmarks from a Frame."""
        t_start = time.perf_counter()

        if self._face_mesh is not None:
            try:
                # Convert frame to RGB for MediaPipe
                img_rgb = cv2.cvtColor(frame.data, cv2.COLOR_BGR2RGB)
                results = self._face_mesh.process(img_rgb)

                if results.multi_face_landmarks:
                    face_lms = results.multi_face_landmarks[0]
                    landmarks = [(lm.x, lm.y, lm.z) for lm in face_lms.landmark]

                    # Standard indices for eye and iris landmarks in MediaPipe
                    # Left eye contour (p1 to p6) + left iris center (468)
                    left_idx = [33, 160, 158, 133, 153, 144, 468]
                    # Right eye contour (p1 to p6) + right iris center (473)
                    right_idx = [362, 385, 387, 263, 373, 380, 473]

                    # Verify that we have enough landmarks for refinement (at least 478)
                    if len(landmarks) >= 478:
                        eye_pts_left = [landmarks[i] for i in left_idx]
                        eye_pts_right = [landmarks[i] for i in right_idx]
                    else:
                        # Fallback to standard landmarks (index bounds check)
                        eye_pts_left = [landmarks[i] for i in left_idx[:6] if i < len(landmarks)]
                        eye_pts_right = [landmarks[i] for i in right_idx[:6] if i < len(landmarks)]
                        # Append a dummy iris center if needed
                        if eye_pts_left:
                            eye_pts_left.append(eye_pts_left[0])
                        if eye_pts_right:
                            eye_pts_right.append(eye_pts_right[0])

                    confidence = 1.0
                    status = "tracking"

                    # Basic check for blinking or poor frame quality to adjust status
                    # If landmarks are extremely scattered, confidence lowers
                    landmarks_arr = np.array(landmarks)
                    std_dev = np.std(landmarks_arr, axis=0)
                    if std_dev[0] > 0.4 or std_dev[1] > 0.4:
                        confidence = 0.4
                        status = "low_confidence"

                    res = FaceLandmarks(
                        landmarks=landmarks,
                        eye_pts_left=eye_pts_left,
                        eye_pts_right=eye_pts_right,
                        confidence=confidence,
                        status=status,
                    )
                    self._log_latency(t_start)
                    return res

            except Exception as e:
                logger.error(f"Error during MediaPipe Face Mesh processing: {e}")

        # MediaPipe not available or face not found -> Fall back to Haar Cascade
        res_fallback = self._fallback_detect(frame)
        self._log_latency(t_start)
        return res_fallback

    def _fallback_detect(self, frame: Frame) -> FaceLandmarks:
        """Fallback landmark detection using OpenCV Haar Cascades."""
        gray = cv2.cvtColor(frame.data, cv2.COLOR_BGR2GRAY)
        h, w = gray.shape

        faces = self._face_cascade.detectMultiScale(gray, 1.3, 5)

        if len(faces) == 0:
            return FaceLandmarks(
                landmarks=[],
                eye_pts_left=[],
                eye_pts_right=[],
                confidence=0.0,
                status="lost",
            )

        # Take largest face
        x, y, fw, fh = max(faces, key=lambda f: f[2] * f[3])

        # Create structured face landmark points relative to face bounding box
        # We generate a grid of 478 mock landmarks centered on face
        landmarks: List[Tuple[float, float, float]] = []
        for i in range(478):
            lm_x = (x + (i % 20) * (fw / 20.0)) / w
            lm_y = (y + (i // 20) * (fh / 25.0)) / h
            landmarks.append((lm_x, lm_y, 0.0))

        # Detect eyes inside face region
        roi_gray = gray[y : y + fh, x : x + fw]
        eyes = self._eye_cascade.detectMultiScale(roi_gray, 1.1, 3)

        # Try to extract actual eyes or place default coordinates relative to face box
        if len(eyes) >= 2:
            # Sort eyes left-to-right
            eyes = sorted(eyes, key=lambda e: e[0])
            ex1, ey1, ew1, eh1 = eyes[0]
            ex2, ey2, ew2, eh2 = eyes[1]

            # Center coordinates
            el_cx, el_cy = (x + ex1 + ew1 / 2) / w, (y + ey1 + eh1 / 2) / h
            er_cx, er_cy = (x + ex2 + ew2 / 2) / w, (y + ey2 + eh2 / 2) / h

            # Build EAR-ready simulated contours around the center
            eye_pts_left = [
                (el_cx - 0.015, el_cy, 0.0),
                (el_cx - 0.005, el_cy - 0.005, 0.0),
                (el_cx + 0.005, el_cy - 0.005, 0.0),
                (el_cx + 0.015, el_cy, 0.0),
                (el_cx + 0.005, el_cy + 0.005, 0.0),
                (el_cx - 0.005, el_cy + 0.005, 0.0),
                (el_cx, el_cy, 0.0),  # iris center
            ]
            eye_pts_right = [
                (er_cx - 0.015, er_cy, 0.0),
                (er_cx - 0.005, er_cy - 0.005, 0.0),
                (er_cx + 0.005, er_cy - 0.005, 0.0),
                (er_cx + 0.015, er_cy, 0.0),
                (er_cx + 0.005, er_cy + 0.005, 0.0),
                (er_cx - 0.005, er_cy + 0.005, 0.0),
                (er_cx, er_cy, 0.0),  # iris center
            ]
            confidence = 0.6
            status = "tracking"
        else:
            # Fallback eye points based on face bbox proportions
            el_cx, el_cy = (x + fw * 0.35) / w, (y + fh * 0.35) / h
            er_cx, er_cy = (x + fw * 0.65) / w, (y + fh * 0.35) / h

            eye_pts_left = [
                (el_cx - 0.015, el_cy, 0.0),
                (el_cx - 0.005, el_cy - 0.005, 0.0),
                (el_cx + 0.005, el_cy - 0.005, 0.0),
                (el_cx + 0.015, el_cy, 0.0),
                (el_cx + 0.005, el_cy + 0.005, 0.0),
                (el_cx - 0.005, el_cy + 0.005, 0.0),
                (el_cx, el_cy, 0.0),
            ]
            eye_pts_right = [
                (er_cx - 0.015, er_cy, 0.0),
                (er_cx - 0.005, er_cy - 0.005, 0.0),
                (er_cx + 0.005, er_cy - 0.005, 0.0),
                (er_cx + 0.015, er_cy, 0.0),
                (er_cx + 0.005, er_cy + 0.005, 0.0),
                (er_cx - 0.005, er_cy + 0.005, 0.0),
                (er_cx, er_cy, 0.0),
            ]
            confidence = 0.4
            status = "low_confidence"

        return FaceLandmarks(
            landmarks=landmarks,
            eye_pts_left=eye_pts_left,
            eye_pts_right=eye_pts_right,
            confidence=confidence,
            status=status,
        )

    def _log_latency(self, t_start: float) -> None:
        if self._telemetry:
            latency_ms = (time.perf_counter() - t_start) * 1000.0
            self._telemetry.log_latency("landmark_detection", latency_ms)
