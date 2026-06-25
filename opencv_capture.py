import logging
import threading
import time
from typing import Optional
import cv2
from eye_cursor.models import Frame
from eye_cursor.video_capture.interface import VideoCaptureInterface
from eye_cursor.telemetry.interface import TelemetryInterface

logger = logging.getLogger(__name__)

class OpenCVCapture(VideoCaptureInterface):
    """OpenCV implementation of VideoCaptureInterface with background threading."""

    def __init__(
        self,
        camera_index: int = 0,
        width: int = 640,
        height: int = 480,
        telemetry: Optional[TelemetryInterface] = None,
        max_failures: int = 10,
    ) -> None:
        """Initialize the OpenCV capture source.

        Args:
            camera_index: The OS index of the camera.
            width: Configured frame width.
            height: Configured frame height.
            telemetry: Optional TelemetryInterface implementation for performance tracking.
            max_failures: Maximum consecutive frame read failures before stopping.
        """
        self._camera_index = camera_index
        self._width = width
        self._height = height
        self._telemetry = telemetry
        self._max_failures = max_failures

        self._cap: Optional[cv2.VideoCapture] = None
        self._thread: Optional[threading.Thread] = None
        self._running = False

        self._frame: Optional[Frame] = None
        self._frame_lock = threading.Lock()

        self._fps = 0.0
        self._fps_lock = threading.Lock()

    def start(self) -> None:
        """Start the video capture thread."""
        if self._running:
            logger.warning("VideoCapture stream is already running.")
            return

        logger.info(f"Opening camera source with index {self._camera_index}...")
        self._cap = cv2.VideoCapture(self._camera_index)
        if not self._cap.isOpened():
            error_msg = f"Failed to open video capture device with index {self._camera_index}."
            logger.error(error_msg)
            if self._telemetry:
                self._telemetry.log_event("camera_init_failed", {"camera_index": self._camera_index})
            self._cap = None
            return

        # Configure camera resolution properties
        self._cap.set(cv2.CAP_PROP_FRAME_WIDTH, self._width)
        self._cap.set(cv2.CAP_PROP_FRAME_HEIGHT, self._height)

        # Re-read set parameters to verify actual settings
        actual_width = self._cap.get(cv2.CAP_PROP_FRAME_WIDTH)
        actual_height = self._cap.get(cv2.CAP_PROP_FRAME_HEIGHT)
        logger.info(f"Camera initialized. Resolution: {actual_width}x{actual_height}")

        if self._telemetry:
            self._telemetry.log_event(
                "camera_init_success",
                {
                    "camera_index": self._camera_index,
                    "width": actual_width,
                    "height": actual_height,
                },
            )

        self._running = True
        self._thread = threading.Thread(target=self._capture_loop, daemon=True)
        self._thread.start()

    def _capture_loop(self) -> None:
        """Background thread target to constantly fetch new frames."""
        frame_id = 0
        consecutive_failures = 0
        fps_start_time = time.perf_counter()
        fps_frame_count = 0

        while self._running:
            if self._cap is None or not self._cap.isOpened():
                logger.error("Camera device closed unexpectedly.")
                if self._telemetry:
                    self._telemetry.log_event("camera_device_lost", {})
                self._running = False
                break

            t_start = time.perf_counter()
            ret, frame_data = self._cap.read()
            t_capture = time.time()
            t_end = time.perf_counter()

            read_latency_ms = (t_end - t_start) * 1000.0
            if self._telemetry:
                self._telemetry.log_latency("frame_capture", read_latency_ms)

            if not ret or frame_data is None:
                consecutive_failures += 1
                logger.warning(
                    f"Failed to read frame from camera. Failure {consecutive_failures}/{self._max_failures}"
                )
                if self._telemetry:
                    self._telemetry.log_event(
                        "frame_read_failed", {"consecutive_failures": consecutive_failures}
                    )

                if consecutive_failures >= self._max_failures:
                    logger.error("Exceeded maximum consecutive frame failures. Stopping capture.")
                    if self._telemetry:
                        self._telemetry.log_event("camera_max_failures_reached", {})
                    self._running = False
                    break
                time.sleep(0.01)
                continue

            # Successful read
            consecutive_failures = 0
            frame_id += 1

            # Update FPS calculation
            fps_frame_count += 1
            fps_elapsed = t_end - fps_start_time
            if fps_elapsed >= 1.0:
                with self._fps_lock:
                    self._fps = fps_frame_count / fps_elapsed
                if self._telemetry:
                    self._telemetry.log_event("camera_fps_update", {"fps": self._fps})
                fps_start_time = t_end
                fps_frame_count = 0

            # Store the frame thread-safely
            with self._frame_lock:
                self._frame = Frame(
                    data=frame_data,
                    t_capture=t_capture,
                )

        # Release resources if thread exits
        self._cleanup()

    def read(self) -> Optional[Frame]:
        """Read the latest captured Frame (non-blocking).

        Returns:
            The latest Frame instance, or None if no frame is available.
        """
        with self._frame_lock:
            return self._frame

    def stop(self) -> None:
        """Stop the video capture stream and cleanup."""
        if not self._running:
            return

        logger.info("Stopping video capture stream...")
        self._running = False
        if self._thread is not None:
            self._thread.join(timeout=1.0)
            self._thread = None

        self._cleanup()
        logger.info("Video capture stream stopped.")

    def is_running(self) -> bool:
        """Check if background thread is active."""
        return self._running

    def get_fps(self) -> float:
        """Retrieve current FPS measurement."""
        with self._fps_lock:
            return self._fps

    def _cleanup(self) -> None:
        """Clean up camera resources."""
        if self._cap is not None:
            self._cap.release()
            self._cap = None
